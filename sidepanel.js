const promptInput = document.getElementById("prompt-input");
const addPromptsBtn = document.getElementById("add-prompts-btn");
const clearPromptBtn = document.getElementById("clear-prompt-btn");
const fileImport = document.getElementById("file-import");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const retryAllBtn = document.getElementById("retry-all-btn");
const clearBtn = document.getElementById("clear-btn");
const queueList = document.getElementById("queue-list");
const queueEmpty = document.getElementById("queue-empty");
const queueCount = document.getElementById("queue-count");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const libraryList = document.getElementById("library-list");
const libraryEmpty = document.getElementById("library-empty");
const aspectButtons = document.querySelectorAll(".aspect-btn");
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");
const charRefGrid = document.getElementById("char-ref-grid");
const charRefInput = document.getElementById("char-ref-input");
const styleRefGrid = document.getElementById("style-ref-grid");
const styleRefInput = document.getElementById("style-ref-input");
const MAX_REF_IMAGES = 2;
const themeInput = document.getElementById("theme-input");
const negativePromptInput = document.getElementById("negative-prompt-input");
const autoDownloadToggle = document.getElementById("auto-download-toggle");
const baseFolderInput = document.getElementById("base-folder-input");
const rateLimitBanner = document.getElementById("rate-limit-banner");
const rateLimitCountdown = document.getElementById("rate-limit-countdown");

let rateLimitTimer = null;
function updateRateLimitBanner(retryAt) {
  if (rateLimitTimer) { clearInterval(rateLimitTimer); rateLimitTimer = null; }
  if (!retryAt || retryAt <= Date.now()) {
    rateLimitBanner.classList.add("hidden");
    return;
  }
  rateLimitBanner.classList.remove("hidden");
  const tick = () => {
    const ms = retryAt - Date.now();
    if (ms <= 0) {
      rateLimitBanner.classList.add("hidden");
      clearInterval(rateLimitTimer);
      rateLimitTimer = null;
      return;
    }
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    rateLimitCountdown.textContent = m > 0 ? `${m} menit ${s} detik` : `${s} detik`;
  };
  tick();
  rateLimitTimer = setInterval(tick, 1000);
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    tabPanels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "library") loadLibrary();
  });
});

aspectButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    aspectButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    await send({ type: "SET_ASPECT_RATIO", aspectRatio: btn.dataset.ratio || null });
  });
});

function debounce(fn, delay = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const debouncedSetTheme = debounce((theme) => send({ type: "SET_THEME", theme }));
themeInput.addEventListener("input", () => debouncedSetTheme(themeInput.value));

const debouncedSetNegativePrompt = debounce((negativePrompt) => send({ type: "SET_NEGATIVE_PROMPT", negativePrompt }));
negativePromptInput.addEventListener("input", () => debouncedSetNegativePrompt(negativePromptInput.value));

const debouncedSetBaseFolder = debounce((baseFolder) => send({ type: "SET_BASE_FOLDER", baseFolder }));
baseFolderInput.addEventListener("input", () => debouncedSetBaseFolder(baseFolderInput.value));

autoDownloadToggle.addEventListener("change", () => {
  send({ type: "SET_AUTO_DOWNLOAD", enabled: autoDownloadToggle.checked });
});

charRefInput.addEventListener("change", async () => {
  const files = [...charRefInput.files].slice(0, MAX_REF_IMAGES);
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    await send({ type: "ADD_CHAR_REF_IMAGE", dataUrl });
  }
  charRefInput.value = "";
});

styleRefInput.addEventListener("change", async () => {
  const files = [...styleRefInput.files].slice(0, MAX_REF_IMAGES);
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    await send({ type: "ADD_STYLE_REF_IMAGE", dataUrl });
  }
  styleRefInput.value = "";
});

addPromptsBtn.addEventListener("click", async () => {
  const lines = promptInput.value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  await send({ type: "SET_PROMPTS", prompts: lines });
});

clearPromptBtn.addEventListener("click", () => {
  promptInput.value = "";
});

fileImport.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  promptInput.value = text;
  fileImport.value = "";
});

startBtn.addEventListener("click", async () => {
  const lines = promptInput.value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length) {
    await send({ type: "SET_PROMPTS", prompts: lines });
  }
  send({ type: "START" });
});
stopBtn.addEventListener("click", () => send({ type: "STOP" }));
retryAllBtn.addEventListener("click", () => send({ type: "RETRY_ALL_FAILED" }));
clearBtn.addEventListener("click", () => {
  if (confirm("Hapus semua item di antrian?")) send({ type: "CLEAR_QUEUE" });
});

function statusLabel(status) {
  return { waiting: "Menunggu", generating: "Membuat...", done: "Selesai", error: "Gagal" }[status] || status;
}

function renderQueue(state) {
  queueList.innerHTML = "";
  queueCount.textContent = state.items.length;
  queueEmpty.classList.toggle("visible", state.items.length === 0);
  renderProgress(state.items);
  updateRateLimitBanner(state.rateLimitRetryAt || null);

  for (const item of state.items) {
    const li = document.createElement("li");
    li.className = "item";

    const main = document.createElement("div");
    main.className = "main";

    const prompt = document.createElement("span");
    prompt.className = "prompt";
    prompt.title = item.prompt;
    prompt.textContent = item.prompt;

    const meta = document.createElement("div");
    meta.className = "meta";
    const status = document.createElement("span");
    status.className = `status status-${item.status}`;
    status.textContent = statusLabel(item.status);
    if (item.status === "error" && item.error) status.title = item.error;
    meta.appendChild(status);

    main.appendChild(prompt);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "actions";

    if (item.status === "error") {
      const retryBtn = document.createElement("button");
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", () => send({ type: "RETRY_ITEM", id: item.id }));
      actions.appendChild(retryBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "✕";
    delBtn.title = "Hapus";
    delBtn.addEventListener("click", () => send({ type: "DELETE_ITEM", id: item.id }));
    actions.appendChild(delBtn);

    li.appendChild(main);
    li.appendChild(actions);
    queueList.appendChild(li);
  }

  startBtn.disabled = state.running;
  stopBtn.disabled = !state.running;

  aspectButtons.forEach((b) => {
    b.classList.toggle("active", (b.dataset.ratio || null) === (state.aspectRatio || null));
  });

  renderRefGrid(charRefGrid, charRefInput, state.charRefImages || [], "CHAR");
  renderRefGrid(styleRefGrid, styleRefInput, state.styleRefImages || [], "STYLE");
}

function renderProgress(items) {
  const total = items.length;
  const done = items.filter((i) => i.status === "done").length;
  const errored = items.filter((i) => i.status === "error").length;
  const finished = done + errored;
  const pct = total ? Math.round((finished / total) * 100) : 0;

  progressFill.style.width = `${pct}%`;
  progressFill.classList.toggle("has-errors", errored > 0);

  progressLabel.textContent = total
    ? `${finished}/${total} selesai${errored ? ` (${errored} gagal)` : ""}`
    : "Tidak ada antrian";
}

function renderRefGrid(grid, input, images, type) {
  const removeMsg = type === "CHAR" ? "REMOVE_CHAR_REF_IMAGE" : "REMOVE_STYLE_REF_IMAGE";
  grid.innerHTML = "";

  images.forEach((dataUrl, index) => {
    const slot = document.createElement("div");
    slot.className = "ref-slot";

    const img = document.createElement("img");
    img.src = dataUrl;
    slot.appendChild(img);

    const removeBtn = document.createElement("button");
    removeBtn.className = "ref-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = "Hapus reference ini";
    removeBtn.addEventListener("click", () => send({ type: removeMsg, index }));
    slot.appendChild(removeBtn);

    grid.appendChild(slot);
  });

  if (images.length < MAX_REF_IMAGES) {
    const addSlot = document.createElement("button");
    addSlot.className = "ref-slot-add";
    addSlot.textContent = "+";
    addSlot.title = "Tambah reference image";
    addSlot.addEventListener("click", () => input.click());
    grid.appendChild(addSlot);
  }
}

async function loadLibrary() {
  const { library } = await send({ type: "GET_LIBRARY" });
  libraryList.innerHTML = "";
  libraryEmpty.classList.toggle("visible", library.length === 0);

  for (const entry of library) {
    const li = document.createElement("li");
    li.className = "item lib-item";

    const img = document.createElement("img");
    img.src = entry.imageUrl;

    const info = document.createElement("div");
    info.className = "main";
    const prompt = document.createElement("span");
    prompt.className = "prompt";
    prompt.title = entry.prompt;
    prompt.textContent = entry.prompt;
    info.appendChild(prompt);

    li.appendChild(img);
    li.appendChild(info);

    if (entry.sourceUrl) {
      const link = document.createElement("a");
      link.href = entry.sourceUrl;
      link.target = "_blank";
      link.textContent = "Buka chat";
      li.appendChild(link);
    }

    libraryList.appendChild(li);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATE_UPDATE") renderQueue(msg.state);
});

(async () => {
  const { state } = await send({ type: "GET_STATE" });
  themeInput.value = state.theme || "";
  negativePromptInput.value = state.negativePrompt || "";
  autoDownloadToggle.checked = state.autoDownload !== false;
  baseFolderInput.value = state.baseFolder || "ChatGPT Image Auto";
  renderQueue(state);
})();
