"use strict";

const STORAGE_KEY = "terapie-in-orario-v3";
const LEGACY_STORAGE_KEYS = ["terapie-in-orario-v2", "terapie-in-orario-v1"];
const NOTIFIED_KEY = "terapie-notified-v1";
const MEDIA_DB_NAME = "terapie-in-orario-media";
const MEDIA_DB_VERSION = 1;
const MEDIA_STORE = "therapy-images";

const defaultState = {
  therapies: [],
  logs: [],
  settings: {
    telegramEnabled: false,
    apiBase: "",
    appKey: "",
    chatId: "",
    timezone: "Europe/Rome"
  }
};

let state = loadState();
let deferredInstallPrompt = null;
let currentTherapyImageBlob = null;
let currentTherapyImageUrl = "";
let removeCurrentTherapyImage = false;
const therapyImageUrls = new Map();
let scannerStream = null;
let scannerTimer = null;
let barcodeDetector = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function loadState() {
  try {
    const keys = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS];
    let parsed = null;
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (raw) {
        parsed = JSON.parse(raw);
        break;
      }
    }
    return parsed ? {
      ...structuredClone(defaultState),
      ...parsed,
      settings: { ...defaultState.settings, ...(parsed.settings || {}) }
    } : structuredClone(defaultState);
  } catch {
    return structuredClone(defaultState);
  }
}

function serializableState() {
  return {
    ...state,
    therapies: state.therapies.map(({ imageData, ...therapy }) => therapy)
  };
}

function saveState({ sync = true } = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializableState()));
  } catch (error) {
    console.error("Errore salvataggio dati", error);
    showToast("Memoria del browser piena. Le immagini ora vengono salvate separatamente: riprova.");
    return false;
  }
  renderAll();
  if (sync && state.settings.telegramEnabled) {
    syncCloud(false).catch(console.error);
  }
  return true;
}

function openMediaDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_DB_NAME, MEDIA_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        db.createObjectStore(MEDIA_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function mediaRequest(mode, operation) {
  const db = await openMediaDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MEDIA_STORE, mode);
    const store = transaction.objectStore(MEDIA_STORE);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

function putTherapyImage(id, blob) {
  return mediaRequest("readwrite", (store) => store.put(blob, id));
}

function getTherapyImage(id) {
  return mediaRequest("readonly", (store) => store.get(id));
}

function deleteTherapyImage(id) {
  return mediaRequest("readwrite", (store) => store.delete(id));
}

function dataUrlToBlob(dataUrl) {
  const [header, encoded] = dataUrl.split(",");
  const mime = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
  const bytes = atob(encoded);
  const array = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) array[i] = bytes.charCodeAt(i);
  return new Blob([array], { type: mime });
}

function replaceTherapyImageUrl(id, blob) {
  const previous = therapyImageUrls.get(id);
  if (previous) URL.revokeObjectURL(previous);
  if (blob) therapyImageUrls.set(id, URL.createObjectURL(blob));
  else therapyImageUrls.delete(id);
}

async function loadTherapyImages() {
  let migrated = false;
  for (const therapy of state.therapies) {
    try {
      if (therapy.imageData) {
        const blob = dataUrlToBlob(therapy.imageData);
        await putTherapyImage(therapy.id, blob);
        therapy.hasImage = true;
        delete therapy.imageData;
        migrated = true;
      }
      if (therapy.hasImage) {
        const blob = await getTherapyImage(therapy.id);
        if (blob) replaceTherapyImageUrl(therapy.id, blob);
        else therapy.hasImage = false;
      }
    } catch (error) {
      console.error("Errore caricamento immagine", error);
    }
  }
  if (migrated) saveState({ sync: false });
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function localDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatLongDate(date = new Date()) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(date);
}

function timeToMinutes(value) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function therapyApplies(therapy, date) {
  if (!therapy.active) return false;
  const iso = localDateISO(date);
  if (therapy.startDate && iso < therapy.startDate) return false;
  if (therapy.endDate && iso > therapy.endDate) return false;
  return therapy.days.includes(date.getDay());
}

function dosesForDate(date = new Date()) {
  const iso = localDateISO(date);
  return state.therapies
    .filter((therapy) => therapyApplies(therapy, date))
    .flatMap((therapy) => therapy.times.map((time) => {
      const log = state.logs.find((item) => item.therapyId === therapy.id && item.date === iso && item.time === time);
      return { therapy, time, log };
    }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

function doseStatus(dose, now = new Date()) {
  if (dose.log?.status === "taken") return { key: "taken", text: "Presa" };
  if (dose.log?.status === "skipped") return { key: "skipped", text: "Saltata" };
  const today = localDateISO(now);
  const doseDate = dose.log?.date || today;
  if (doseDate !== today) return { key: "next", text: "Programmato" };
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const doseMinutes = timeToMinutes(dose.time);
  const delta = doseMinutes - nowMinutes;
  if (delta > 30) return { key: "next", text: `Tra ${Math.floor(delta / 60) ? `${Math.floor(delta / 60)} h ` : ""}${delta % 60} min` };
  if (delta > 0) return { key: "due", text: `Tra ${delta} min` };
  if (delta >= -30) return { key: "due", text: "Da prendere" };
  return { key: "late", text: "In ritardo" };
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function showView(view) {
  $$(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${view}`));
  $$(".nav-btn").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "history") renderHistory();
}

function imageHTML(src, cls = "med-thumb") {
  if (!src) return "";
  return `<img src="${src}" alt="Immagine farmaco" class="${cls}">`;
}

function renderAll() {
  renderToday();
  renderTherapies();
  renderHistory();
  renderSettings();
}

function renderToday() {
  const now = new Date();
  const doses = dosesForDate(now);
  const completed = doses.filter((dose) => ["taken", "skipped"].includes(dose.log?.status)).length;
  $("#todayDate").textContent = formatLongDate(now);
  $("#progressValue").textContent = `${completed}/${doses.length}`;
  const next = doses.find((dose) => !dose.log && timeToMinutes(dose.time) >= now.getHours() * 60 + now.getMinutes()) || doses.find((dose) => !dose.log);
  $("#nextDoseText").textContent = next ? `Prossima: ${next.therapy.name} alle ${next.time}` : doses.length ? "Programma completato per oggi." : "Aggiungi la prima terapia per iniziare.";
  $("#todayEmpty").classList.toggle("hidden", doses.length > 0);
  const list = $("#todayList");
  list.innerHTML = doses.map((dose) => {
    const status = doseStatus(dose, now);
    return `
      <article class="dose-card">
        <div>
          <div class="time-badge">${escapeHTML(dose.time)}</div>
          ${therapyImageUrls.get(dose.therapy.id) ? imageHTML(therapyImageUrls.get(dose.therapy.id), "med-thumb small") : ""}
        </div>
        <div class="dose-main">
          <div class="therapy-card-top">
            <div>
              <h3>${escapeHTML(dose.therapy.name)}</h3>
              <p class="dose-meta">${escapeHTML(dose.therapy.dose)}</p>
            </div>
            <span class="status-line status-${status.key}">${escapeHTML(status.text)}</span>
          </div>
          ${dose.therapy.barcode ? `<div class="therapy-times"><span class="chip code-chip">Codice: ${escapeHTML(dose.therapy.barcode)}</span></div>` : ""}
          ${dose.therapy.notes ? `<p class="dose-note">${escapeHTML(dose.therapy.notes)}</p>` : ""}
          <div class="dose-actions">
            ${dose.log ? `
              <button class="action-reset" data-action="reset-dose" data-id="${dose.therapy.id}" data-time="${dose.time}" type="button">Annulla registrazione</button>
            ` : `
              <button class="action-taken" data-action="mark-taken" data-id="${dose.therapy.id}" data-time="${dose.time}" type="button">✓ Presa</button>
              <button class="action-skipped" data-action="mark-skipped" data-id="${dose.therapy.id}" data-time="${dose.time}" type="button">Saltata</button>
            `}
          </div>
        </div>
      </article>`;
  }).join("");
}

function renderTherapies() {
  const list = $("#therapyList");
  if (!state.therapies.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">💊</div><h3>Nessuna terapia</h3><p>Premi “Aggiungi” per creare il primo promemoria.</p></div>`;
    return;
  }
  const dayNames = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
  list.innerHTML = state.therapies.map((therapy) => `
    <article class="therapy-card ${therapy.active ? "" : "inactive"}">
      <div class="therapy-card-top">
        <div>
          <h3>${escapeHTML(therapy.name)}</h3>
          <p class="muted">${escapeHTML(therapy.dose)}</p>
        </div>
        <span class="status-pill">${therapy.active ? "Attiva" : "Sospesa"}</span>
      </div>
      <div class="therapy-card-media">
        ${therapyImageUrls.get(therapy.id) ? imageHTML(therapyImageUrls.get(therapy.id), "med-thumb-card") : ""}
        <div class="meta-stack">
          <div class="therapy-times">${therapy.times.map((time) => `<span class="chip">${escapeHTML(time)}</span>`).join("")}</div>
          <p class="small-note">${therapy.days.length === 7 ? "Tutti i giorni" : therapy.days.map((d) => dayNames[d]).join(", ")}</p>
          ${therapy.barcode ? `<div><span class="chip code-chip">Codice a barre: ${escapeHTML(therapy.barcode)}</span></div>` : ""}
          ${therapy.notes ? `<p>${escapeHTML(therapy.notes)}</p>` : ""}
        </div>
      </div>
      <div class="card-menu">
        <button class="secondary small" data-action="edit-therapy" data-id="${therapy.id}" type="button">Modifica</button>
        <button class="secondary small" data-action="toggle-therapy" data-id="${therapy.id}" type="button">${therapy.active ? "Sospendi" : "Riattiva"}</button>
        <button class="text-btn danger-text small" data-action="delete-therapy" data-id="${therapy.id}" type="button">Elimina</button>
      </div>
    </article>
  `).join("");
}

function renderHistory() {
  const selectedDate = $("#historyDate")?.value || "";
  const logs = [...state.logs].filter((log) => !selectedDate || log.date === selectedDate).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const list = $("#historyList");
  if (!list) return;
  if (!logs.length) {
    list.innerHTML = `<div class="empty-state"><h3>Nessuna registrazione</h3><p>Le conferme “Presa” o “Saltata” compariranno qui.</p></div>`;
    return;
  }
  list.innerHTML = logs.map((log) => {
    const therapy = state.therapies.find((item) => item.id === log.therapyId);
    return `
      <article class="history-card">
        <div>
          <h3>${escapeHTML(therapy?.name || log.therapyName || "Terapia eliminata")}</h3>
          <p class="muted">${new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" }).format(new Date(`${log.date}T12:00:00`))} · ${escapeHTML(log.time)}</p>
        </div>
        <span class="status-line status-${log.status}">${log.status === "taken" ? "Presa" : "Saltata"}</span>
      </article>`;
  }).join("");
}

function renderSettings() {
  const s = state.settings;
  $("#telegramEnabled").checked = !!s.telegramEnabled;
  $("#apiBase").value = s.apiBase || "";
  $("#appKey").value = s.appKey || "";
  $("#chatId").value = s.chatId || "";
  $("#timezone").value = s.timezone || "Europe/Rome";
  const permission = "Notification" in window ? Notification.permission : "unsupported";
  const statusMap = { granted: "Attive", denied: "Bloccate", default: "Da autorizzare", unsupported: "Non supportate" };
  $("#notificationStatus").textContent = statusMap[permission] || permission;
}

function addTimeInput(value = "08:00") {
  const row = document.createElement("div");
  row.className = "time-row";
  row.innerHTML = `
    <input class="therapy-time" type="time" value="${escapeHTML(value)}" required aria-label="Orario terapia">
    <button class="remove-time" type="button" aria-label="Rimuovi orario">×</button>`;
  row.querySelector(".remove-time").addEventListener("click", () => {
    if ($$(".therapy-time").length <= 1) return showToast("Deve rimanere almeno un orario.");
    row.remove();
  });
  $("#timesList").appendChild(row);
}

function updateTherapyImagePreview(src = "") {
  currentTherapyImageUrl = src || "";
  const wrap = $("#therapyImagePreviewWrap");
  const img = $("#therapyImagePreview");
  if (src) {
    img.src = src;
    wrap.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    wrap.classList.add("hidden");
  }
}

async function openTherapyDialog(id = "") {
  const therapy = state.therapies.find((item) => item.id === id);
  $("#therapyForm").reset();
  $("#timesList").innerHTML = "";
  $("#therapyId").value = therapy?.id || "";
  $("#dialogTitle").textContent = therapy ? "Modifica terapia" : "Nuova terapia";
  $("#therapyName").value = therapy?.name || "";
  $("#therapyDose").value = therapy?.dose || "";
  $("#therapyBarcode").value = therapy?.barcode || "";
  $("#startDate").value = therapy?.startDate || localDateISO();
  $("#endDate").value = therapy?.endDate || "";
  $("#therapyNotes").value = therapy?.notes || "";
  $("#therapyActive").checked = therapy?.active ?? true;
  $("#therapyImageInput").value = "";
  currentTherapyImageBlob = null;
  removeCurrentTherapyImage = false;
  updateTherapyImagePreview(therapy ? (therapyImageUrls.get(therapy.id) || "") : "");
  $$("input[name='days']").forEach((input) => {
    input.checked = therapy ? therapy.days.includes(Number(input.value)) : true;
  });
  (therapy?.times || ["08:00"]).forEach(addTimeInput);
  $("#therapyDialog").showModal();
}

function closeTherapyDialog() {
  $("#therapyDialog").close();
}

async function fileToCompressedBlob(file, maxSize = 1000, quality = 0.8) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = objectUrl;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Compressione non riuscita")), "image/jpeg", quality);
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function handleTherapyImageSelection(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const compressed = await fileToCompressedBlob(file);
    currentTherapyImageBlob = compressed;
    removeCurrentTherapyImage = false;
    if (currentTherapyImageUrl && currentTherapyImageUrl.startsWith("blob:")) {
      URL.revokeObjectURL(currentTherapyImageUrl);
    }
    updateTherapyImagePreview(URL.createObjectURL(compressed));
    showToast("Immagine del farmaco aggiunta.");
  } catch {
    showToast("Non è stato possibile leggere l'immagine.");
  }
}

async function saveTherapy(event) {
  event.preventDefault();
  const oldId = $("#therapyId").value;
  const therapyId = oldId || uid();
  const existing = state.therapies.find((item) => item.id === oldId);
  const days = $$("input[name='days']:checked").map((el) => Number(el.value));
  const times = [...new Set($$(".therapy-time").map((el) => el.value).filter(Boolean))].sort();
  if (!days.length) return showToast("Seleziona almeno un giorno.");
  if (!times.length) return showToast("Inserisci almeno un orario.");
  if ($("#endDate").value && $("#startDate").value > $("#endDate").value) return showToast("La data finale precede quella iniziale.");

  const therapy = {
    id: therapyId,
    name: $("#therapyName").value.trim(),
    dose: $("#therapyDose").value.trim(),
    barcode: $("#therapyBarcode").value.trim(),
    hasImage: existing?.hasImage || therapyImageUrls.has(therapyId),
    days,
    times,
    startDate: $("#startDate").value,
    endDate: $("#endDate").value,
    notes: $("#therapyNotes").value.trim(),
    active: $("#therapyActive").checked,
    updatedAt: new Date().toISOString()
  };
  if (!therapy.name || !therapy.dose) return showToast("Compila nome e dose.");

  try {
    if (currentTherapyImageBlob) {
      await putTherapyImage(therapyId, currentTherapyImageBlob);
      replaceTherapyImageUrl(therapyId, currentTherapyImageBlob);
      therapy.hasImage = true;
    } else if (removeCurrentTherapyImage) {
      await deleteTherapyImage(therapyId);
      replaceTherapyImageUrl(therapyId, null);
      therapy.hasImage = false;
    }
  } catch (error) {
    console.error(error);
    return showToast("Non è stato possibile salvare l'immagine. Riprova.");
  }

  const index = state.therapies.findIndex((item) => item.id === oldId);
  if (index >= 0) state.therapies[index] = therapy;
  else state.therapies.push(therapy);

  if (!saveState()) return;
  closeTherapyDialog();
  showToast(oldId ? "Terapia aggiornata." : "Terapia aggiunta.");
}

function markDose(therapyId, time, status) {
  const date = localDateISO();
  state.logs = state.logs.filter((item) => !(item.therapyId === therapyId && item.date === date && item.time === time));
  const therapy = state.therapies.find((item) => item.id === therapyId);
  state.logs.push({ id: uid(), therapyId, therapyName: therapy?.name || "", date, time, status, timestamp: new Date().toISOString() });
  saveState({ sync: false });
  showToast(status === "taken" ? "Assunzione registrata." : "Dose segnata come saltata.");
}

function resetDose(therapyId, time) {
  const date = localDateISO();
  state.logs = state.logs.filter((item) => !(item.therapyId === therapyId && item.date === date && item.time === time));
  saveState({ sync: false });
  showToast("Registrazione annullata.");
}

async function requestNotifications() {
  if (!("Notification" in window)) return showToast("Notifiche non supportate su questo dispositivo.");
  const permission = await Notification.requestPermission();
  renderSettings();
  showToast(permission === "granted" ? "Notifiche attivate." : "Autorizzazione non concessa.");
  if (permission === "granted") checkDueNotifications();
}

async function showDeviceNotification(title, options) {
  if (Notification.permission !== "granted") return;
  const registration = await navigator.serviceWorker?.ready;
  if (registration) await registration.showNotification(title, options);
}

function checkDueNotifications() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = new Date();
  const today = localDateISO(now);
  const minute = now.getHours() * 60 + now.getMinutes();
  const notified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || "{}");
  dosesForDate(now).forEach((dose) => {
    const key = `${today}:${dose.therapy.id}:${dose.time}`;
    const dueMinute = timeToMinutes(dose.time);
    if (!dose.log && minute >= dueMinute && minute <= dueMinute + 2 && !notified[key]) {
      notified[key] = new Date().toISOString();
      showDeviceNotification(`È ora di ${dose.therapy.name}`, {
        body: `${dose.therapy.dose}${dose.therapy.notes ? ` · ${dose.therapy.notes}` : ""}`,
        icon: "icon.svg", badge: "icon.svg", tag: key, renotify: true, data: { url: location.href }
      }).catch(console.error);
    }
  });
  const cutoff = Date.now() - 3 * 86400000;
  Object.keys(notified).forEach((key) => { if (new Date(notified[key]).getTime() < cutoff) delete notified[key]; });
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified));
}

function cloudPayload() {
  return {
    appKey: state.settings.appKey.trim(),
    chatId: state.settings.chatId.trim(),
    timezone: state.settings.timezone.trim() || "Europe/Rome",
    enabled: !!state.settings.telegramEnabled,
    therapies: state.therapies.map(({ id, name, dose, barcode, days, times, startDate, endDate, notes, active }) => ({
      id, name, dose, barcode, days, times, startDate, endDate, notes, active
    }))
  };
}

function normalizeApiBase(value) { return value.trim().replace(/\/+$/, ""); }

async function syncCloud(showMessage = true) {
  const apiBase = normalizeApiBase(state.settings.apiBase);
  const payload = cloudPayload();
  if (!apiBase || payload.appKey.length < 8 || !payload.chatId) {
    if (showMessage) showToast("Completa API, chiave personale e Chat ID.");
    throw new Error("Cloud settings incomplete");
  }
  $("#cloudStatus").textContent = "Sincronizzazione in corso…";
  const response = await fetch(`${apiBase}/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Errore ${response.status}`);
  $("#cloudStatus").textContent = `Sincronizzato: ${new Date().toLocaleString("it-IT")}`;
  if (showMessage) showToast("Terapie sincronizzate con Cloudflare.");
  return data;
}

async function testTelegram() {
  try {
    state.settings = readSettingsForm();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializableState()));
    const apiBase = normalizeApiBase(state.settings.apiBase);
    const payload = cloudPayload();
    if (!apiBase || payload.appKey.length < 8 || !payload.chatId) return showToast("Completa API, chiave personale e Chat ID.");
    $("#cloudStatus").textContent = "Invio del messaggio di prova…";
    const response = await fetch(`${apiBase}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Errore ${response.status}`);
    $("#cloudStatus").textContent = "Messaggio di prova inviato.";
    showToast("Controlla Telegram.");
  } catch (error) {
    $("#cloudStatus").textContent = `Errore: ${error.message}`;
    showToast("Invio non riuscito.");
  }
}

function readSettingsForm() {
  return {
    telegramEnabled: $("#telegramEnabled").checked,
    apiBase: normalizeApiBase($("#apiBase").value),
    appKey: $("#appKey").value.trim(),
    chatId: $("#chatId").value.trim(),
    timezone: $("#timezone").value.trim() || "Europe/Rome"
  };
}

function saveCloudSettings() {
  state.settings = readSettingsForm();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializableState()));
  syncCloud(true).catch((error) => {
    $("#cloudStatus").textContent = `Errore: ${error.message}`;
    showToast("Sincronizzazione non riuscita.");
  });
}

function exportBackup() {
  const blob = new Blob([JSON.stringify({ app: "Terapie in Orario", version: 2, exportedAt: new Date().toISOString(), data: state }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `terapie-backup-${localDateISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importBackup(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const imported = parsed.data || parsed;
    if (!Array.isArray(imported.therapies) || !Array.isArray(imported.logs)) throw new Error("Formato non valido");
    state = { ...structuredClone(defaultState), ...imported, settings: { ...defaultState.settings, ...(imported.settings || {}) } };
    saveState();
    showToast("Backup ripristinato.");
  } catch {
    showToast("Il file selezionato non è un backup valido.");
  }
}

async function initBarcodeDetector() {
  if (!("BarcodeDetector" in window)) return null;
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    const preferred = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"];
    const usable = preferred.filter((f) => formats.includes(f));
    return new BarcodeDetector({ formats: usable.length ? usable : formats });
  } catch {
    return new BarcodeDetector();
  }
}

async function openBarcodeScanner() {
  if (!barcodeDetector) barcodeDetector = await initBarcodeDetector();
  if (!barcodeDetector) {
    showToast("Scansione non supportata su questo browser. Inserisci il codice manualmente.");
    return;
  }
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const video = $("#scannerVideo");
    video.srcObject = scannerStream;
    $("#scannerStatus").textContent = "Inquadra il codice a barre…";
    $("#scannerDialog").showModal();
    startScanLoop();
  } catch {
    showToast("Impossibile accedere alla fotocamera.");
  }
}

function startScanLoop() {
  stopScanLoop();
  const video = $("#scannerVideo");
  scannerTimer = setInterval(async () => {
    if (!video.videoWidth || !barcodeDetector) return;
    try {
      const barcodes = await barcodeDetector.detect(video);
      const value = barcodes?.[0]?.rawValue;
      if (value) {
        $("#therapyBarcode").value = value;
        $("#scannerStatus").textContent = `Codice rilevato: ${value}`;
        showToast("Codice a barre acquisito.");
        closeScanner();
      }
    } catch {
      $("#scannerStatus").textContent = "Ricerca del codice in corso…";
    }
  }, 700);
}

function stopScanLoop() {
  if (scannerTimer) {
    clearInterval(scannerTimer);
    scannerTimer = null;
  }
}

function closeScanner() {
  stopScanLoop();
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }
  const video = $("#scannerVideo");
  if (video) video.srcObject = null;
  if ($("#scannerDialog").open) $("#scannerDialog").close();
}

function bindEvents() {
  $$(".nav-btn").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));
  ["#addTherapyBtn", "#addFromTodayBtn", "#emptyAddBtn"].forEach((id) => $(id).addEventListener("click", () => openTherapyDialog()));
  $("#addTimeBtn").addEventListener("click", () => addTimeInput("12:00"));
  $("#closeDialogBtn").addEventListener("click", closeTherapyDialog);
  $("#cancelDialogBtn").addEventListener("click", closeTherapyDialog);
  $("#therapyForm").addEventListener("submit", saveTherapy);
  $("#therapyImageInput").addEventListener("change", handleTherapyImageSelection);
  $("#removeTherapyImageBtn").addEventListener("click", () => {
    $("#therapyImageInput").value = "";
    currentTherapyImageBlob = null;
    removeCurrentTherapyImage = true;
    updateTherapyImagePreview("");
  });
  $("#scanBarcodeBtn").addEventListener("click", openBarcodeScanner);
  $("#closeScannerBtn").addEventListener("click", closeScanner);
  $("#manualCloseScannerBtn").addEventListener("click", closeScanner);
  $("#scannerDialog").addEventListener("close", closeScanner);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id, time } = button.dataset;
    if (action === "mark-taken") markDose(id, time, "taken");
    if (action === "mark-skipped") markDose(id, time, "skipped");
    if (action === "reset-dose") resetDose(id, time);
    if (action === "edit-therapy") openTherapyDialog(id);
    if (action === "toggle-therapy") {
      const therapy = state.therapies.find((item) => item.id === id);
      if (therapy) therapy.active = !therapy.active;
      saveState();
    }
    if (action === "delete-therapy") {
      const therapy = state.therapies.find((item) => item.id === id);
      if (therapy && confirm(`Eliminare la terapia “${therapy.name}”? Lo storico già registrato resterà disponibile.`)) {
        state.therapies = state.therapies.filter((item) => item.id !== id);
        deleteTherapyImage(id).catch(console.error);
        replaceTherapyImageUrl(id, null);
        saveState();
      }
    }
  });

  $("#historyDate").addEventListener("change", renderHistory);
  $("#resetHistoryFilter").addEventListener("click", () => { $("#historyDate").value = ""; renderHistory(); });
  $("#clearHistoryBtn").addEventListener("click", () => { if (state.logs.length && confirm("Vuoi eliminare tutto lo storico?")) { state.logs = []; saveState({ sync: false }); } });
  $("#notificationBtn").addEventListener("click", requestNotifications);
  $("#generateKeyBtn").addEventListener("click", () => { $("#appKey").value = [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join(""); });
  $("#saveCloudBtn").addEventListener("click", saveCloudSettings);
  $("#testTelegramBtn").addEventListener("click", testTelegram);
  $("#exportBtn").addEventListener("click", exportBackup);
  $("#importInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importBackup(file);
    event.target.value = "";
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#installBtn").classList.remove("hidden");
  });
  $("#installBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#installBtn").classList.add("hidden");
  });
}

async function init() {
  bindEvents();
  await loadTherapyImages();
  renderAll();
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (error) { console.error(error); }
  }
  checkDueNotifications();
  setInterval(() => { renderToday(); checkDueNotifications(); }, 30000);
}

init();
