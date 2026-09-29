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

  async function submitPrompt(promptText, aspectRatio, hasReferenceImages) {
    const composer = await waitFor(() => queryFirst(SELECTORS.composer), { timeout: 15000 });
    let finalText = promptText;
    if (hasReferenceImages) {
      finalText =
        `Use the attached reference image(s) as the visual reference (style, character, subject) ` +
        `for this image: ${finalText}`;
    }
    if (aspectRatio) finalText += `\n\nAspect ratio: ${aspectRatio}.`;
    setComposerText(composer, finalText);
    await sleep(200);

    const sendBtn = await waitFor(() => queryFirst(SELECTORS.sendButton), { timeout: 5000 });
    if (sendBtn.disabled) {
      throw new Error("Send button is disabled — composer text may not have registered");
    }
    sendBtn.click();
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

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "PROCESS_PROMPT") return false;

    console.log("[ChatGPT Image Auto] received PROCESS_PROMPT:", msg.prompt);

    // Generation can take minutes. Rather than holding this one sendResponse
    // callback open the whole time (fragile: it breaks if the service worker
    // is evicted, the tab is throttled/discarded, or anything else closes
    // the port mid-wait), acknowledge receipt immediately and report the
    // outcome later via a fresh, independent message.
    sendResponse({ ok: true, started: true });

    (async () => {
      try {
        const hasRefImages = !!(msg.refImageDataUrls && msg.refImageDataUrls.length);
        let refImagesAttached = false;
        if (hasRefImages) {
          console.log("[ChatGPT Image Auto] attaching", msg.refImageDataUrls.length, "reference image(s)...");
          const attached = await Promise.race([
            attachReferenceImages(msg.refImageDataUrls),
            sleep(15000).then(() => "timeout"),
          ]);
          console.log("[ChatGPT Image Auto] reference image attach result:", attached);
          refImagesAttached = attached === true;
          // give ChatGPT's uploader a moment to finish registering the
          // attachment(s) before we start typing the prompt text
          await sleep(800);
        }
        console.log("[ChatGPT Image Auto] submitting prompt...");
        await submitPrompt(msg.prompt, msg.aspectRatio, refImagesAttached);
        console.log("[ChatGPT Image Auto] prompt submitted, waiting for image...");
        const result = await waitForImageResult({ preBaselineWait: refImagesAttached ? 3000 : 0 });
        console.log("[ChatGPT Image Auto] image found:", result.imageUrl);
        chrome.runtime.sendMessage({
          type: "PROMPT_RESULT",
          requestId: msg.requestId,
          ok: true,
          imageUrl: result.imageUrl,
          sourceUrl: result.sourceUrl,
        }).catch(() => {});
      } catch (err) {
        console.error("[ChatGPT Image Auto] error:", err);
        chrome.runtime.sendMessage({
          type: "PROMPT_RESULT",
          requestId: msg.requestId,
          ok: false,
          error: String(err.message || err),
        }).catch(() => {});
      }
    })();

    return false;
  });
}
