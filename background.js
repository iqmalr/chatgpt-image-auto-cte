// background.js — service worker
// Owns queue state, talks to the sidepanel UI and to content.js on chatgpt.com,
// and performs downloads.

const STORAGE_KEY = "cgia_state";
const DEFAULT_STATE = {
  items: [], // { id, prompt, status: 'waiting'|'generating'|'done'|'error', imageUrl, filename, error, refImageDataUrl }
  running: false,
  aspectRatio: null, // e.g. "1:1" | "16:9" | "9:16" | null
  charRefImages: [],  // up to 2 character reference images (data URLs)
  styleRefImages: [], // up to 2 style reference images (data URLs)
  theme: "", // subfolder name under baseFolder, e.g. "Kucing"
  autoDownload: true,
  baseFolder: "ChatGPT Image Auto",
  negativePrompt: "",
  rateLimitRetryAt: null, // epoch ms — set when rate-limited, cleared on resume
};


let state = { ...DEFAULT_STATE };
let processing = false;

function abortAllPending() {
  for (const pending of pendingPromptResults.values()) {
    pending.reject(Object.assign(new Error("Aborted"), { isAborted: true }));
  }
  pendingPromptResults.clear();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  state = { ...DEFAULT_STATE, ...(stored[STORAGE_KEY] || {}) };
}

async function saveState() {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  broadcast();
}

function broadcast() {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state }).catch(() => {});
}

function genId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(text, maxLen = 40) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, maxLen) || "image";
}

function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // brief buffer for the SPA to hydrate past the bare "complete" event
        setTimeout(resolve, 1000);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function findOrCreateChatGptTab() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  let tab = tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
  } else {
    // Always navigate to a fresh new chat so prior conversation context
    // (e.g. the user asking ChatGPT to "generate prompts") does not bleed
    // into the extension's image-generation request.
    await chrome.tabs.update(tab.id, { url: "https://chatgpt.com/" });
  }
  await waitForTabComplete(tab.id);
  // Prevent Chrome's memory saver from discarding this tab while it sits in
  // the background during a multi-minute generate — a discard kills the
  // content script mid-wait and surfaces as "message port closed" errors.
  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch (err) {
    console.warn("[ChatGPT Image Auto] failed to set autoDiscardable:", err);
  }
  return tab;
}

async function ensureContentScriptInjected(tabId) {
  // content.js is idempotent (guards itself with window.__chatgptImageAutoLoaded),
  // so it's safe to (re-)inject it here every time. This makes the extension
  // self-healing: if the tab's original content script went stale (e.g. this
  // extension was reloaded while the tab was already open), this replaces it
  // with a fresh, working one instead of requiring the user to manually
  // close/reopen the tab.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    console.warn("[ChatGPT Image Auto] ensureContentScriptInjected failed:", err);
  }
}

// Pending PROCESS_PROMPT requests awaiting a PROMPT_RESULT message from
// content.js, keyed by requestId. Kept separate from the initial
// tabs.sendMessage round trip (see sendToContentScript) because that single
// callback would otherwise have to stay open for the whole multi-minute
// generate, which is fragile: it breaks if the service worker is evicted,
// the tab gets throttled/discarded, or anything else closes the port.
const pendingPromptResults = new Map();

async function sendToContentScript(tabId, message, timeoutMs = 180000) {
  await ensureContentScriptInjected(tabId);

  const requestId = genId();
  const resultPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPromptResults.delete(requestId);
      reject(new Error("Timed out waiting for content script"));
    }, timeoutMs);
    // MV3 service workers can be terminated after ~30s of no extension-API
    // activity; ping a trivial API on an interval to keep this worker alive
    // for the duration of the wait.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    pendingPromptResults.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        clearInterval(keepAlive);
        pendingPromptResults.delete(requestId);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        clearInterval(keepAlive);
        pendingPromptResults.delete(requestId);
        reject(err);
      },
    });
  });

  // Fire-and-forget: just confirms content.js received the prompt and
  // started working. The actual outcome arrives later as PROMPT_RESULT.
  await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { ...message, requestId }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  }).catch((err) => {
    pendingPromptResults.get(requestId)?.reject(err);
  });

  return resultPromise;
}

function buildFilename(item) {
  const folderParts = [(state.baseFolder || "").trim() || "ChatGPT Image Auto"];
  if (state.theme && state.theme.trim()) folderParts.push(slugify(state.theme.trim(), 40));
  return `${folderParts.join("/")}/${slugify(item.prompt)}-${item.id}.png`;
}

async function downloadImage(item) {
  const dedupe = await chrome.storage.local.get("cgia_downloaded");
  const downloaded = new Set(dedupe.cgia_downloaded || []);
  const alreadyDownloaded = downloaded.has(item.imageUrl);

  let filename = null;
  if (state.autoDownload && !alreadyDownloaded) {
    filename = buildFilename(item);
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: item.imageUrl, filename, conflictAction: "uniquify", saveAs: false },
        (id) => {
          if (chrome.runtime.lastError || !id) {
            reject(new Error(chrome.runtime.lastError?.message || "Download failed"));
            return;
          }
          resolve(id);
        }
      );
    });
    downloaded.add(item.imageUrl);
    await chrome.storage.local.set({ cgia_downloaded: [...downloaded] });
  }

  const lib = await chrome.storage.local.get("cgia_library");
  const library = lib.cgia_library || [];
  library.unshift({
    prompt: item.prompt,
    imageUrl: item.imageUrl,
    filename,
    sourceUrl: item.sourceUrl || null,
    timestamp: Date.now(),
  });
  await chrome.storage.local.set({ cgia_library: library.slice(0, 500) });

  return { skipped: alreadyDownloaded || !state.autoDownload, filename };
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (state.running) {
      const next = state.items.find((i) => i.status === "waiting");
      if (!next) {
        state.running = false;
        await saveState();
        break;
      }

      next.status = "generating";
      await saveState();

      try {
        const tab = await findOrCreateChatGptTab();
        const result = await sendToContentScript(tab.id, {
          type: "PROCESS_PROMPT",
          prompt: next.prompt,
          aspectRatio: state.aspectRatio,
          charRefDataUrls: state.charRefImages || [],
          styleRefDataUrls: state.styleRefImages || [],
          negativePrompt: state.negativePrompt || "",
        });

        if (!result || !result.ok) {
          throw new Error(result?.error || "Unknown content-script error");
        }

        next.imageUrl = result.imageUrl;
        next.sourceUrl = result.sourceUrl;
        const dl = await downloadImage(next);
        next.status = "done";
        next.filename = dl.filename || null;
        next.skippedDuplicate = !!dl.skipped;
      } catch (err) {
        if (err.isAborted || (!state.running && next.status === "waiting")) {
          // Stopped by user — item already reset to waiting, just exit the loop
          break;
        }
        if (err.isRateLimit) {
          // Reset item to waiting; pause the queue; schedule resume via Chrome Alarm
          // (Alarms survive service-worker eviction, unlike setTimeout).
          next.status = "waiting";
          const waitMs = err.waitMs || 3600000;
          state.running = false;
          state.rateLimitRetryAt = Date.now() + waitMs;
          await saveState();
          const delayMinutes = Math.max(1, Math.ceil(waitMs / 60000));
          chrome.alarms.create("rateLimitResume", { delayInMinutes: delayMinutes });
          console.log(`[ChatGPT Image Auto] Rate limit hit. Resuming in ${delayMinutes} min.`);
          break;
        }
        next.status = "error";
        next.error = String(err.message || err);
      }

      await saveState();
      // small delay between prompts to be polite / avoid rate limits
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    processing = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PROMPT_RESULT") {
    const pending = pendingPromptResults.get(msg.requestId);
    if (pending) {
      if (msg.ok) {
        pending.resolve({ ok: true, imageUrl: msg.imageUrl, sourceUrl: msg.sourceUrl });
      } else {
        const err = new Error(msg.error || "Unknown content-script error");
        if (msg.isRateLimit) {
          err.isRateLimit = true;
          err.waitMs = msg.waitMs || 3600000;
        }
        if (msg.isRefusal) err.isRefusal = true;
        pending.reject(err);
      }
    }
    return false;
  }

  (async () => {
    switch (msg.type) {
      case "GET_STATE":
        await loadState();
        sendResponse({ state });
        break;

      case "SET_PROMPTS": {
        // msg.prompts: string[]
        const existingPrompts = new Set(
          state.items.filter((i) => i.status === "done").map((i) => i.prompt)
        );
        const newItems = msg.prompts
          .map((p) => p.trim())
          .filter(Boolean)
          .filter((p) => !existingPrompts.has(p))
          .map((p) => ({ id: genId(), prompt: p, status: "waiting" }));
        state.items.push(...newItems);
        await saveState();
        sendResponse({ ok: true, added: newItems.length });
        break;
      }

      case "SET_ASPECT_RATIO":
        state.aspectRatio = msg.aspectRatio;
        await saveState();
        sendResponse({ ok: true });
        break;

      case "START":
        state.running = true;
        await saveState();
        processQueue();
        sendResponse({ ok: true });
        break;

      case "STOP":
        state.running = false;
        // Reset any in-progress item back to waiting so it can be retried
        state.items.forEach((i) => {
          if (i.status === "generating") i.status = "waiting";
        });
        await saveState();
        // Abort the pending content-script promise so it doesn't linger 180 s
        abortAllPending();
        // Tell the content script to stop waiting for the current generation
        chrome.tabs.query({ url: "https://chatgpt.com/*" }, (tabs) => {
          if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "ABORT_CURRENT" }).catch(() => {});
        });
        sendResponse({ ok: true });
        break;

      case "ADD_CHAR_REF_IMAGE":
        if ((state.charRefImages || []).length < 2) {
          state.charRefImages = [...(state.charRefImages || []), msg.dataUrl];
        }
        await saveState();
        sendResponse({ ok: true });
        break;

      case "REMOVE_CHAR_REF_IMAGE":
        state.charRefImages = (state.charRefImages || []).filter((_, i) => i !== msg.index);
        await saveState();
        sendResponse({ ok: true });
        break;

      case "ADD_STYLE_REF_IMAGE":
        if ((state.styleRefImages || []).length < 2) {
          state.styleRefImages = [...(state.styleRefImages || []), msg.dataUrl];
        }
        await saveState();
        sendResponse({ ok: true });
        break;

      case "REMOVE_STYLE_REF_IMAGE":
        state.styleRefImages = (state.styleRefImages || []).filter((_, i) => i !== msg.index);
        await saveState();
        sendResponse({ ok: true });
        break;

      case "SET_NEGATIVE_PROMPT":
        state.negativePrompt = msg.negativePrompt || "";
        await saveState();
        sendResponse({ ok: true });
        break;

      case "SET_THEME":
        state.theme = msg.theme || "";
        await saveState();
        sendResponse({ ok: true });
        break;

      case "SET_AUTO_DOWNLOAD":
        state.autoDownload = !!msg.enabled;
        await saveState();
        sendResponse({ ok: true });
        break;

      case "SET_BASE_FOLDER":
        state.baseFolder = msg.baseFolder || "";
        await saveState();
        sendResponse({ ok: true });
        break;

      case "RETRY_ITEM": {
        const item = state.items.find((i) => i.id === msg.id);
        if (item) {
          item.status = "waiting";
          item.error = null;
          state.running = true;
        }
        await saveState();
        if (item) processQueue();
        sendResponse({ ok: true });
        break;
      }

      case "RETRY_ALL_FAILED": {
        let hasRetried = false;
        state.items.forEach((i) => {
          if (i.status === "error") {
            i.status = "waiting";
            i.error = null;
            hasRetried = true;
          }
        });
        if (hasRetried) state.running = true;
        await saveState();
        if (hasRetried) processQueue();
        sendResponse({ ok: true });
        break;
      }

      case "DELETE_ITEM":
        state.items = state.items.filter((i) => i.id !== msg.id);
        await saveState();
        sendResponse({ ok: true });
        break;

      case "CLEAR_QUEUE":
        state.items = [];
        state.running = false;
        await saveState();
        sendResponse({ ok: true });
        break;

      case "GET_LIBRARY": {
        const lib = await chrome.storage.local.get("cgia_library");
        sendResponse({ library: lib.cgia_library || [] });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "rateLimitResume") return;
  await loadState();
  state.rateLimitRetryAt = null;
  if (state.items.some((i) => i.status === "waiting")) {
    state.running = true;
    await saveState();
    processQueue();
  } else {
    await saveState();
  }
});

loadState();
