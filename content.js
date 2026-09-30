// content.js — injected into chatgpt.com
//
// IMPORTANT: ChatGPT's DOM changes frequently, and this file gets injected
// both declaratively (manifest content_scripts) and on-demand by
// background.js (chrome.scripting.executeScript, to self-heal a stale
// context after the extension reloads). Both paths can land in the same
// already-open tab, so everything below is wrapped in a guard: if this file
// already ran in this page/world, re-running it is a harmless no-op instead
// of a "SELECTORS already declared" crash.
if (!window.__chatgptImageAutoLoaded) {
  window.__chatgptImageAutoLoaded = true;

  const SELECTORS = {
    composer: [
      "#prompt-textarea", // historically a ProseMirror contenteditable div
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="Ask" i]',
      '[contenteditable="true"][data-virtualkeyboard]',
      'form [contenteditable="true"]',
    ],
    sendButton: [
      '[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'form button[type="submit"]',
    ],
    fileInput: [
      "#upload-photos", // hidden input dedicated to image uploads — no menu click needed
      'input[type="file"][accept*="image" i]',
      'input[type="file"]',
    ],
  };

  const queryFirst = (selectorList, root = document) => {
    for (const sel of selectorList) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, { timeout = 15000, interval = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const val = fn();
      if (val) return val;
      await sleep(interval);
    }
    throw new Error("waitFor: timed out");
  }

  function setComposerText(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // contenteditable (ProseMirror-style) element
    el.innerHTML = "";
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // chatgpt.com's CSP blocks fetch() of data: URLs ("Failed to fetch"), so
  // reference images (stored as data URLs) are decoded to a File manually
  // instead of going through fetch().
  function dataUrlToFile(dataUrl, filename) {
    const [header, base64] = dataUrl.split(",");
    const mime = /data:(.*?);base64/.exec(header)?.[1] || "image/png";
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    return new File([new Uint8Array(byteNumbers)], filename, { type: mime });
  }

  async function attachReferenceImages(dataUrls) {
    // Verified against the live ChatGPT DOM: there's a hidden <input
    // id="upload-photos" type="file" accept="image/*"> always present in the
    // composer, independent of the "Add files and more" menu button. Setting
    // its .files and dispatching "change" attaches the file directly —
    // clicking the menu button first is unnecessary (and was the reason
    // attachment silently failed before).
    if (!dataUrls || !dataUrls.length) return false;
    try {
      const input = await waitFor(() => queryFirst(SELECTORS.fileInput), { timeout: 3000 });

      const dt = new DataTransfer();
      for (let i = 0; i < dataUrls.length; i++) {
        dt.items.add(dataUrlToFile(dataUrls[i], `reference-${i + 1}.png`));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(500);
      return true;
    } catch (err) {
      console.warn("[ChatGPT Image Auto] attachReferenceImages failed:", err);
      return false;
    }
  }

  async function submitPrompt(promptText, aspectRatio, charCount, styleCount, negativePrompt) {
    const composer = await waitFor(() => queryFirst(SELECTORS.composer), { timeout: 15000 });
    let finalText = promptText;
    if (charCount > 0 && styleCount > 0) {
      finalText =
        `Character reference: first ${charCount} attached image(s) — maintain exact character appearance. ` +
        `Style reference: next ${styleCount} attached image(s) — apply this visual style. ` +
        `Apply both references to this image: ${finalText}`;
    } else if (charCount > 0) {
      finalText =
        `Use the attached image(s) as character reference (maintain exact character appearance): ${finalText}`;
    } else if (styleCount > 0) {
      finalText =
        `Use the attached image(s) as style reference (apply this visual style): ${finalText}`;
    }
    if (aspectRatio) finalText += `\n\nAspect ratio: ${aspectRatio}.`;
    if (negativePrompt) finalText += `\n\nDo not include: ${negativePrompt}.`;
    setComposerText(composer, finalText);
    await sleep(200);

    const sendBtn = await waitFor(() => queryFirst(SELECTORS.sendButton), { timeout: 5000 });
    if (sendBtn.disabled) {
      throw new Error("Send button is disabled — composer text may not have registered");
    }
    sendBtn.click();
  }

  const REFUSAL_PATTERNS = [
    /can.{0,5}t (create|generate|make|produce).{0,40}image/i,
    /unable to (create|generate|make|produce).{0,40}image/i,
    /not able to (create|generate|make|produce)/i,
    /won.{0,3}t (be able to )?(create|generate|make|produce)/i,
    /violates? (our |the )?(content|usage|community) (policy|guidelines|terms)/i,
    /against (our |the )?(content|usage|community) (policy|guidelines|terms)/i,
    /i (can.{0,5}t|won.{0,3}t|am unable|am not able).{0,30}(help|assist) with that/i,
    /this (request|prompt|content).{0,30}(violates?|against|not allowed|inappropriate)/i,
  ];

  const RATE_LIMIT_PATTERNS = [
    /image.{0,30}limit/i,
    /limit.{0,30}image/i,
    /rate.{0,5}limit/i,
    /try again in \d+/i,
    /come back in \d+/i,
    /you.{0,20}run out/i,
    /you.{0,20}reached.{0,20}limit/i,
    /generation.{0,20}limit/i,
    /can.{0,5}t generate.{0,20}image/i,
  ];

  function parseWaitMs(text) {
    const t = text.toLowerCase();
    const hourMatch = t.match(/(\d+)\s*hour/);
    const minMatch = t.match(/(\d+)\s*min/);
    let ms = 0;
    if (hourMatch) ms += parseInt(hourMatch[1]) * 3600000;
    if (minMatch) ms += parseInt(minMatch[1]) * 60000;
    return ms || 3600000;
  }

  // Fully-loaded, reasonably-large <img> elements anywhere on the page. This
  // sidesteps ChatGPT's frequently-changing message/container markup: instead
  // of locating "the assistant's turn" and looking for an image inside it, we
  // just watch the page's total count of large images and treat a fresh one
  // as the generation result. naturalWidth is 0 until the image has actually
  // finished loading, so a still-decoding image never counts prematurely.
  function getLargeImages(minSize = 150) {
    return [...document.querySelectorAll("img")].filter(
      (img) => img.naturalWidth >= minSize && img.naturalHeight >= minSize
    );
  }

  async function waitForImageResult({ timeout = 180000, stableMs = 1500, preBaselineWait = 0 } = {}) {
    // Snapshot assistant message count NOW (before reference thumbnails load)
    // so we can later identify the response to THIS prompt specifically.
    const assistantMsgSelector = '[data-message-author-role="assistant"]';
    const baselineAssistantMsgs = document.querySelectorAll(assistantMsgSelector).length;

    // If reference images were attached, their thumbnails appear in the chat
    // shortly after submission. Wait for them to fully load before taking the
    // baseline so they are not mistaken for the generated result.
    if (preBaselineWait > 0) await sleep(preBaselineWait);
    const baselineCount = getLargeImages().length;
    const start = Date.now();
    // Rather than trusting a "stop generating" button selector to disappear
    // (fragile — ChatGPT's UI/markup for it changes often and can silently
    // fail to match), treat a new large image whose src stops changing for
    // stableMs as the finished result. This also naturally skips over any
    // progressively-rendered preview frames along the way.
    let candidate = null; // { img, src, since }

    return new Promise((resolve, reject) => {
      const finish = (fn) => {
        observer.disconnect();
        clearInterval(poll);
        fn();
      };

      const check = () => {
        const imgs = getLargeImages();
        const newest = imgs.length > baselineCount ? imgs[imgs.length - 1] : null;

        if (newest) {
          if (!candidate || candidate.img !== newest || candidate.src !== newest.src) {
            candidate = { img: newest, src: newest.src, since: Date.now() };
          } else if (Date.now() - candidate.since >= stableMs) {
            finish(() => resolve({ imageUrl: newest.src, sourceUrl: location.href }));
            return;
          }
        } else {
          candidate = null;
          // After 8 s with no image, check if ChatGPT replied with a rate-limit
          // message instead of generating (only look at the NEW assistant turn).
          if (Date.now() - start > 8000) {
            const msgs = document.querySelectorAll(assistantMsgSelector);
            if (msgs.length > baselineAssistantMsgs) {
              // Only check the opening ~500 chars to avoid false positives further down
              const latestText = (msgs[msgs.length - 1].innerText || "").slice(0, 500);
              if (RATE_LIMIT_PATTERNS.some((p) => p.test(latestText))) {
                const waitMs = parseWaitMs(latestText);
                const err = new Error(`Rate limit: retry after ${Math.round(waitMs / 60000)} min`);
                err.isRateLimit = true;
                err.waitMs = waitMs;
                finish(() => reject(err));
                return;
              }
              if (REFUSAL_PATTERNS.some((p) => p.test(latestText))) {
                const err = new Error("Ditolak GPT: konten tidak diizinkan");
                err.isRefusal = true;
                finish(() => reject(err));
                return;
              }
            }
          }
        }

        if (Date.now() - start > timeout) {
          finish(() => reject(new Error("Timed out waiting for generated image")));
        }
      };

      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"],
      });
      const poll = setInterval(check, 500);
      check();
    });
  }

  console.log("[ChatGPT Image Auto] content script loaded on", location.href);

  let currentAbort = null;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "ABORT_CURRENT") {
      if (currentAbort) currentAbort();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type !== "PROCESS_PROMPT") return false;

    console.log("[ChatGPT Image Auto] received PROCESS_PROMPT:", msg.prompt);

    // Generation can take minutes. Rather than holding this one sendResponse
    // callback open the whole time (fragile: it breaks if the service worker
    // is evicted, the tab is throttled/discarded, or anything else closes
    // the port mid-wait), acknowledge receipt immediately and report the
    // outcome later via a fresh, independent message.
    sendResponse({ ok: true, started: true });

    (async () => {
      let abortReject;
      const abortPromise = new Promise((_, reject) => { abortReject = reject; });
      currentAbort = () => abortReject(Object.assign(new Error("Aborted"), { isAborted: true }));

      try {
        const work = async () => {
          const charUrls = msg.charRefDataUrls || [];
          const styleUrls = msg.styleRefDataUrls || [];
          const allRefUrls = [...charUrls, ...styleUrls];
          let charAttached = 0;
          let styleAttached = 0;
          if (allRefUrls.length > 0) {
            console.log("[ChatGPT Image Auto] attaching", allRefUrls.length, "reference image(s)...");
            const attached = await Promise.race([
              attachReferenceImages(allRefUrls),
              sleep(15000).then(() => "timeout"),
            ]);
            console.log("[ChatGPT Image Auto] reference image attach result:", attached);
            if (attached === true) {
              charAttached = charUrls.length;
              styleAttached = styleUrls.length;
            }
            await sleep(800);
          }
          console.log("[ChatGPT Image Auto] submitting prompt...");
          await submitPrompt(msg.prompt, msg.aspectRatio, charAttached, styleAttached, msg.negativePrompt || "");
          console.log("[ChatGPT Image Auto] prompt submitted, waiting for image...");
          return await waitForImageResult({ preBaselineWait: (charAttached + styleAttached) > 0 ? 3000 : 0 });
        };

        const result = await Promise.race([work(), abortPromise]);
        console.log("[ChatGPT Image Auto] image found:", result.imageUrl);
        chrome.runtime.sendMessage({
          type: "PROMPT_RESULT",
          requestId: msg.requestId,
          ok: true,
          imageUrl: result.imageUrl,
          sourceUrl: result.sourceUrl,
        }).catch(() => {});
      } catch (err) {
        if (err.isAborted) {
          console.log("[ChatGPT Image Auto] operation aborted by user");
          return; // background already reset the item — don't send PROMPT_RESULT
        }
        console.error("[ChatGPT Image Auto] error:", err);
        chrome.runtime.sendMessage({
          type: "PROMPT_RESULT",
          requestId: msg.requestId,
          ok: false,
          error: String(err.message || err),
          isRateLimit: !!err.isRateLimit,
          waitMs: err.waitMs || 0,
          isRefusal: !!err.isRefusal,
        }).catch(() => {});
      } finally {
        currentAbort = null;
      }
    })();

    return false;
  });
}
