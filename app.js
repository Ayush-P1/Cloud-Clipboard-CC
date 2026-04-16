// Loaded from local config files ignored by git.
const firebaseConfig = window.FIREBASE_CONFIG;
const supabaseConfig = window.SUPABASE_CONFIG;

const MAX_HISTORY = 5;
const USER_STORAGE_KEY = "cloud-clipboard-user-id";
const SYNC_DELAY_MS = 250;
const STATUS_RESET_MS = 1800;
const COPY_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const OPEN_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';
const DOWNLOAD_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
const COPY_BUTTON_DEFAULT = `${COPY_ICON} Copy`;
const OPEN_IMAGE_BUTTON = `${OPEN_ICON} Open Image`;
const DOWNLOAD_FILE_BUTTON = `${DOWNLOAD_ICON} Download File`;

const clipboardInput = document.querySelector("#clipboardInput");
const receivedText = document.querySelector("#receivedText");
const clearButton = document.querySelector("#clearButton");
const copyButton = document.querySelector("#copyButton");
const uploadTrigger = document.querySelector("#uploadTrigger");
const fileInput = document.querySelector("#fileInput");
const uploadStatus = document.querySelector("#uploadStatus");
const historyList = document.querySelector("#historyList");
const lastUpdated = document.querySelector("#lastUpdated");
const lastUpdatedBy = document.querySelector("#lastUpdatedBy");
const currentType = document.querySelector("#currentType");
const outputTypeBadge = document.querySelector("#outputTypeBadge");
const syncState = document.querySelector("#syncState");
const setupNotice = document.querySelector("#setupNotice");
const activeUsers = document.querySelector("#activeUsers");

let syncTimeoutId = null;
let copyResetTimeoutId = null;
let uploadResetTimeoutId = null;
let currentClipboardItem = createEmptyClipboardItem();
let latestHistoryEntries = [];
let rootRef = null;
let supabaseClient = null;

const userId = getOrCreateUserId();

if (!hasValidFirebaseConfig(firebaseConfig)) {
  setSetupMode("Add your Firebase config to enable syncing.");
} else {
  initializeClipboardApp();
}

function initializeClipboardApp() {
  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();
  rootRef = db.ref();

  const clipboardRef = db.ref("clipboard");
  const historyRef = db.ref("history");
  const presenceRef = db.ref(`presence/${userId}`);
  const presenceListRef = db.ref("presence");
  const connectedRef = db.ref(".info/connected");

  if (hasValidSupabaseConfig(supabaseConfig)) {
    supabaseClient = window.supabase.createClient(
      supabaseConfig.url,
      supabaseConfig.anonKey,
    );
    uploadStatus.textContent = "Ready for image/file uploads.";
  } else {
    uploadTrigger.disabled = true;
    uploadStatus.textContent = "Add Supabase config to enable uploads.";
    setupNotice.classList.remove("hidden");
  }

  syncState.textContent = userId;
  setPrimaryActionButton(createEmptyClipboardItem());

  connectedRef.on("value", async (snapshot) => {
    if (snapshot.val() !== true) {
      activeUsers.textContent = "0 online";
      return;
    }

    await presenceRef.onDisconnect().remove();
    await presenceRef.set({
      user: userId,
      connectedAt: Date.now(),
    });
  });

  clipboardRef.on("value", (snapshot) => {
    renderClipboard(normalizeClipboardItem(snapshot.val()));
  });

  historyRef.on("value", (snapshot) => {
    renderHistory(normalizeHistory(snapshot.val()));
  });

  presenceListRef.on("value", (snapshot) => {
    activeUsers.textContent = `${normalizePresence(snapshot.val()).length} online`;
  });

  clipboardInput.addEventListener("input", () => {
    syncState.textContent = "Syncing...";
    window.clearTimeout(syncTimeoutId);
    syncTimeoutId = window.setTimeout(() => {
      syncClipboard(createTextEntry(clipboardInput.value));
    }, SYNC_DELAY_MS);
  });

  uploadTrigger.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    await handleFileUpload(file);
    fileInput.value = "";
  });

  clearButton.addEventListener("click", () => {
    window.clearTimeout(syncTimeoutId);
    clipboardInput.value = "";
    syncClipboard(createEmptyClipboardItem(), { preserveHistory: true });
  });

  copyButton.addEventListener("click", async () => {
    await handlePrimaryAction();
  });

  historyList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-index]");
    if (!button) {
      return;
    }

    const entry = latestHistoryEntries[Number(button.dataset.index)];
    if (!entry) {
      return;
    }

    restoreHistoryEntry(entry);
  });
}

async function handleFileUpload(file) {
  if (!supabaseClient) {
    setUploadStatus("Supabase is not configured yet.");
    return;
  }

  setUploadStatus(`Uploading ${file.name}...`);
  toggleUploadControls(true);

  try {
    const entry = await uploadFileAndBuildEntry(file);
    clipboardInput.value = "";
    await syncClipboard(entry);
    setUploadStatus(`${entry.type === "image" ? "Image" : "File"} synced.`);
  } catch (error) {
    console.error("Upload failed:", error);
    setUploadStatus("Upload failed. Check Supabase bucket policies.");
    syncState.textContent = "Upload failed";
  } finally {
    toggleUploadControls(false);
  }
}

async function uploadFileAndBuildEntry(file) {
  const timestamp = Date.now();
  const safeName = sanitizeFileName(file.name);
  const objectPath = `clipboard/${userId}/${timestamp}-${safeName}`;
  const bucket = supabaseConfig.bucket || "clipboard-assets";

  const { error: uploadError } = await supabaseClient.storage
    .from(bucket)
    .upload(objectPath, file, {
      cacheControl: "3600",
      upsert: true,
      contentType: file.type || undefined,
    });

  if (uploadError) {
    throw uploadError;
  }

  const { data } = supabaseClient.storage.from(bucket).getPublicUrl(objectPath);
  const type = file.type.startsWith("image/") ? "image" : "file";

  return normalizeClipboardItem({
    type,
    content: type === "image" ? "" : file.name,
    fileName: file.name,
    fileUrl: data.publicUrl,
    mimeType: file.type || "application/octet-stream",
  });
}

async function syncClipboard(item, options = {}) {
  if (!rootRef) {
    return;
  }

  const timestamp = Date.now();
  const { preserveHistory = false } = options;
  const nextClipboard = normalizeClipboardItem({
    ...item,
    timestamp,
    user: userId,
  });

  try {
    await rootRef.transaction((currentState) => {
      const safeState = currentState || {};
      const previousClipboard = normalizeClipboardItem(safeState.clipboard);
      const history = normalizeHistory(safeState.history);

      const shouldAddHistory =
        !preserveHistory &&
        hasClipboardPayload(nextClipboard) &&
        !isSameClipboardItem(nextClipboard, previousClipboard);

      return {
        ...safeState,
        clipboard: nextClipboard,
        history: shouldAddHistory
          ? [nextClipboard, ...history].slice(0, MAX_HISTORY)
          : history.slice(0, MAX_HISTORY),
      };
    });

    syncState.textContent = userId;
  } catch (error) {
    console.error("Sync failed:", error);
    syncState.textContent = "Sync failed";
  }
}

function renderClipboard(clipboard) {
  currentClipboardItem = normalizeClipboardItem(clipboard);
  const { type, content, timestamp, user } = currentClipboardItem;

  clipboardInput.value = type === "text" || type === "link" ? content : "";
  receivedText.classList.remove("has-rich-content");
  renderOutputContent(currentClipboardItem);
  receivedText.classList.toggle("empty", !hasClipboardPayload(currentClipboardItem));
  receivedText.classList.remove("flash");
  void receivedText.offsetWidth;
  receivedText.classList.add("flash");

  lastUpdated.textContent = timestamp ? formatTimestamp(timestamp) : "—";
  lastUpdatedBy.textContent = user || "—";
  currentType.textContent = formatType(type);
  outputTypeBadge.textContent = type === "empty" ? "live" : formatType(type);

  setPrimaryActionButton(currentClipboardItem);
  clearButton.disabled = false;
}

function renderHistory(entries) {
  latestHistoryEntries = entries;

  if (!entries.length) {
    historyList.innerHTML =
      '<li class="history-placeholder">Entries will appear here as you type.</li>';
    return;
  }

  historyList.innerHTML = entries
    .map((entry, index) => {
      const preview = getHistoryPreview(entry);
      const updatedAt = entry.timestamp
        ? formatTimestamp(entry.timestamp)
        : "Unknown time";

      return `
        <li>
          <button class="history-entry${isSameClipboardItem(entry, currentClipboardItem) ? " active" : ""}" type="button" data-index="${index}">
            <span class="history-num">#${index + 1}</span>
            <span class="history-type">${escapeHtml(formatType(entry.type))}</span>
            <span class="history-text">${escapeHtml(preview)}</span>
            <span class="history-time">${updatedAt} · ${escapeHtml(entry.user || "—")}</span>
          </button>
        </li>
      `;
    })
    .join("");
}

function renderOutputContent(item) {
  if (!hasClipboardPayload(item)) {
    receivedText.textContent = "Nothing here yet.";
    return;
  }

  if (item.type === "text") {
    receivedText.textContent = item.content;
    return;
  }

  receivedText.classList.add("has-rich-content");

  if (item.type === "link") {
    receivedText.innerHTML = `
      <div class="link-preview">
        <span class="preview-label">Link</span>
        <a class="preview-link" href="${escapeAttribute(item.fileUrl || item.content)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.content)}</a>
        <span class="preview-domain">${escapeHtml(getDomain(item.fileUrl || item.content))}</span>
      </div>
    `;
    return;
  }

  if (item.type === "image") {
    receivedText.innerHTML = `
      <div class="media-preview">
        <img src="${escapeAttribute(item.fileUrl)}" alt="${escapeAttribute(item.fileName || "Shared image")}" />
        <div class="preview-meta">${escapeHtml(item.fileName || "Image")} · ${escapeHtml(item.mimeType || "image")}</div>
      </div>
    `;
    return;
  }

  receivedText.innerHTML = `
    <div class="file-preview">
      <span class="preview-label">File</span>
      <span class="preview-link">${escapeHtml(item.fileName || "Shared file")}</span>
      <span class="preview-meta">${escapeHtml(item.mimeType || "Unknown type")}</span>
      <div class="preview-actions">
        <a class="btn btn-primary" href="${escapeAttribute(item.fileUrl)}" target="_blank" rel="noopener noreferrer" download="${escapeAttribute(item.fileName || "download")}">
          ${DOWNLOAD_ICON}
          Download
        </a>
      </div>
    </div>
  `;
}

function setPrimaryActionButton(item) {
  if (item.type === "image") {
    copyButton.disabled = !item.fileUrl;
    copyButton.innerHTML = OPEN_IMAGE_BUTTON;
    return;
  }

  if (item.type === "file") {
    copyButton.disabled = !item.fileUrl;
    copyButton.innerHTML = DOWNLOAD_FILE_BUTTON;
    return;
  }

  copyButton.disabled = !item.content.trim();
  copyButton.innerHTML = COPY_BUTTON_DEFAULT;
}

async function handlePrimaryAction() {
  if (!hasClipboardPayload(currentClipboardItem)) {
    return;
  }

  if (currentClipboardItem.type === "image" || currentClipboardItem.type === "file") {
    window.open(currentClipboardItem.fileUrl, "_blank", "noopener,noreferrer");
    return;
  }

  try {
    await navigator.clipboard.writeText(
      currentClipboardItem.type === "link"
        ? currentClipboardItem.fileUrl || currentClipboardItem.content
        : currentClipboardItem.content,
    );
    copyButton.innerHTML = "Copied!";
    resetPrimaryActionButtonSoon();
  } catch (error) {
    console.error("Copy failed:", error);
    copyButton.innerHTML = "Copy failed";
    resetPrimaryActionButtonSoon();
  }
}

function resetPrimaryActionButtonSoon() {
  window.clearTimeout(copyResetTimeoutId);
  copyResetTimeoutId = window.setTimeout(() => {
    setPrimaryActionButton(currentClipboardItem);
  }, STATUS_RESET_MS);
}

function restoreHistoryEntry(entry) {
  const normalizedEntry = normalizeClipboardItem(entry);

  if (normalizedEntry.type === "text" || normalizedEntry.type === "link") {
    clipboardInput.value = normalizedEntry.content;
  } else {
    clipboardInput.value = "";
  }

  syncClipboard(normalizedEntry);
}

function getHistoryPreview(entry) {
  if (entry.type === "image") {
    return entry.fileName || "Shared image";
  }

  if (entry.type === "file") {
    return entry.fileName || "Shared file";
  }

  return truncateText(entry.content || "", 100) || "(empty)";
}

function setSetupMode(message) {
  setupNotice.classList.remove("hidden");
  setupNotice.innerHTML = `<span class="banner-dot"></span>${escapeHtml(message)}`;
  clipboardInput.disabled = true;
  clearButton.disabled = true;
  copyButton.disabled = true;
  uploadTrigger.disabled = true;
  syncState.textContent = "Offline";
  activeUsers.textContent = "—";
  currentType.textContent = "Unavailable";
  outputTypeBadge.textContent = "offline";
  uploadStatus.textContent = "Add Supabase config to enable uploads.";
}

function getOrCreateUserId() {
  const savedId = window.localStorage.getItem(USER_STORAGE_KEY);
  if (savedId) {
    return savedId;
  }

  const generatedId = `User-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  window.localStorage.setItem(USER_STORAGE_KEY, generatedId);
  return generatedId;
}

function normalizeHistory(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(normalizeClipboardItem);
  }

  if (value && typeof value === "object") {
    return Object.values(value).filter(Boolean).map(normalizeClipboardItem);
  }

  return [];
}

function normalizePresence(value) {
  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.values(value).filter(Boolean);
}

function normalizeClipboardItem(value) {
  if (!value || typeof value !== "object") {
    return createEmptyClipboardItem();
  }

  const type = ["text", "link", "image", "file"].includes(value.type)
    ? value.type
    : inferClipboardType(value);

  return {
    type,
    content: typeof value.content === "string" ? value.content : "",
    fileName: typeof value.fileName === "string" ? value.fileName : "",
    fileUrl:
      typeof value.fileUrl === "string"
        ? value.fileUrl
        : typeof value.linkUrl === "string"
          ? value.linkUrl
          : "",
    mimeType: typeof value.mimeType === "string" ? value.mimeType : "",
    timestamp: typeof value.timestamp === "number" ? value.timestamp : 0,
    user: typeof value.user === "string" ? value.user : "",
  };
}

function createEmptyClipboardItem() {
  return {
    type: "empty",
    content: "",
    fileName: "",
    fileUrl: "",
    mimeType: "",
    timestamp: 0,
    user: "",
  };
}

function createTextEntry(value) {
  const content = typeof value === "string" ? value : "";
  const trimmed = content.trim();

  if (!trimmed) {
    return createEmptyClipboardItem();
  }

  if (isProbablyUrl(trimmed)) {
    return {
      type: "link",
      content: trimmed,
      fileName: "",
      fileUrl: trimmed,
      mimeType: "text/uri-list",
    };
  }

  return {
    type: "text",
    content,
    fileName: "",
    fileUrl: "",
    mimeType: "text/plain",
  };
}

function inferClipboardType(value) {
  if (value.fileUrl && String(value.mimeType || "").startsWith("image/")) {
    return "image";
  }

  if (value.fileUrl && isProbablyUrl(value.fileUrl) && value.mimeType !== "text/uri-list") {
    return "file";
  }

  if (value.fileUrl && isProbablyUrl(value.fileUrl)) {
    return "link";
  }

  return "text";
}

function hasClipboardPayload(item) {
  return Boolean(item.content.trim() || item.fileUrl.trim() || item.fileName.trim());
}

function isSameClipboardItem(left, right) {
  return (
    left.type === right.type &&
    left.content === right.content &&
    left.fileName === right.fileName &&
    left.fileUrl === right.fileUrl &&
    left.mimeType === right.mimeType
  );
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function formatType(type) {
  if (type === "link") {
    return "Link";
  }

  if (type === "image") {
    return "Image";
  }

  if (type === "file") {
    return "File";
  }

  if (type === "text") {
    return "Text";
  }

  return "Empty";
}

function getDomain(value) {
  try {
    return new URL(value).hostname;
  } catch (error) {
    return value;
  }
}

function isProbablyUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    return false;
  }
}

function toggleUploadControls(disabled) {
  uploadTrigger.disabled = disabled || !supabaseClient;
  clipboardInput.disabled = disabled;
}

function setUploadStatus(message) {
  uploadStatus.textContent = message;
  window.clearTimeout(uploadResetTimeoutId);

  if (message === "Ready for image/file uploads." || message === "Add Supabase config to enable uploads.") {
    return;
  }

  uploadResetTimeoutId = window.setTimeout(() => {
    uploadStatus.textContent = supabaseClient
      ? "Ready for image/file uploads."
      : "Add Supabase config to enable uploads.";
  }, 2600);
}

function sanitizeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function hasValidFirebaseConfig(config) {
  if (!config || typeof config !== "object") {
    return false;
  }

  return Object.values(config).every(
    (value) => typeof value === "string" && value && !value.startsWith("YOUR_"),
  );
}

function hasValidSupabaseConfig(config) {
  if (!config || typeof config !== "object") {
    return false;
  }

  const values = [config.url, config.anonKey, config.bucket];
  return values.every(
    (value) => typeof value === "string" && value && !value.startsWith("YOUR_"),
  );
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}
