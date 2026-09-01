"use strict";

const STORAGE_KEY = "terapie-in-orario-v5";
const LEGACY_STORAGE_KEYS = ["terapie-in-orario-v4", "terapie-in-orario-v3", "terapie-in-orario-v2", "terapie-in-orario-v1"];
const NOTIFIED_KEY = "terapie-notified-v1";
const PENDING_DOSE_SYNC_KEY = "terapie-dose-sync-pending-v1";
const MEDIA_DB_NAME = "terapie-in-orario-media";
const MEDIA_DB_VERSION = 1;
const MEDIA_STORE = "therapy-images";

const defaultState = {
  therapies: [],
  logs: [],
  snoozes: [],
  scheduleOverrides: [],
  settings: {
    telegramEnabled: false,
    apiBase: "",
    appKey: "",
    chatId: "",
    timezone: "Europe/Rome",
    cloudBackupLast: "",
    cloudBackupBytes: 0,
    recoveryCode: "",
    backupId: "",
    autoBackupEnabled: true,
    telegramRecoverySentFor: "",
    multiDeviceSyncEnabled: true,
    lastDeviceSyncAt: ""
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
let autoBackupTimer = null;
let autoBackupInFlight = false;
let autoBackupDirty = false;
let autoBackupSuspended = false;
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let deviceSyncInFlight = false;
let selectedCalendarTherapyId = "";
let calendarSwipeStartX = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];


function normalizeTherapyRecord(therapy = {}) {
  const days = [...new Set(
    (Array.isArray(therapy.days) ? therapy.days : [])
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  )].sort((a, b) => a - b);

  const times = [...new Set(
    (Array.isArray(therapy.times) ? therapy.times : [])
      .map((time) => String(time || "").trim())
      .filter((time) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
  )].sort();

  const normalizeDate = (value) => {
    const text = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
  };

  return {
    ...therapy,
    id: String(therapy.id || ""),
    name: String(therapy.name || ""),
    dose: String(therapy.dose || ""),
    days,
    times,
    startDate: normalizeDate(therapy.startDate),
    endDate: normalizeDate(therapy.endDate),
    active: therapy.active !== false,
    archived: therapy.archived === true,
    archivedAt: therapy.archivedAt || "",
    monthInterval: Math.max(1, Number.parseInt(therapy.monthInterval || 1, 10) || 1),
    scheduleType: therapy.scheduleType === "manual" ? "manual" : therapy.scheduleType === "cyclic" ? "cyclic" : "standard",
    cycleDurationDays: Math.max(1, Number.parseInt(therapy.cycleDurationDays || 14, 10) || 14),
    cycleIntervalMonths: Math.max(1, Number.parseInt(therapy.cycleIntervalMonths || 2, 10) || 2),
    cycleCount: Math.max(1, Number.parseInt(therapy.cycleCount || 3, 10) || 3),
    stockUnits: therapy.stockUnits === "" || therapy.stockUnits == null ? "" : Math.max(0, Number(therapy.stockUnits) || 0),
    doseUnits: Math.max(0.1, Number(therapy.doseUnits) || 1),
    lowStockThreshold: Math.max(0, Number(therapy.lowStockThreshold) || 5)
  };
}

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
    if (!parsed) return structuredClone(defaultState);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      therapies: Array.isArray(parsed.therapies) ? parsed.therapies.map(normalizeTherapyRecord) : [],
      snoozes: Array.isArray(parsed.snoozes) ? parsed.snoozes : [],
      scheduleOverrides: Array.isArray(parsed.scheduleOverrides)
        ? parsed.scheduleOverrides.map(normalizeScheduleOverride).filter(Boolean)
        : [],
      settings: { ...defaultState.settings, ...(parsed.settings || {}) }
    };
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

function removeLegacyStorageKeys() {
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.warn(`Impossibile rimuovere la vecchia memoria ${key}`, error);
    }
  }
}

function writeStateToLocalStorage() {
  const serialized = JSON.stringify(serializableState());

  try {
    localStorage.setItem(STORAGE_KEY, serialized);
    // Le versioni precedenti potevano contenere fotografie Base64 molto grandi.
    // Dopo un salvataggio valido vengono eliminate per liberare spazio.
    removeLegacyStorageKeys();
    return true;
  } catch (firstError) {
    console.warn("Primo tentativo di salvataggio non riuscito: pulizia vecchi dati", firstError);

    // Recupero automatico: libera le vecchie chiavi e riprova una sola volta.
    removeLegacyStorageKeys();

    try {
      localStorage.setItem(STORAGE_KEY, serialized);
      return true;
    } catch (secondError) {
      console.error("Errore salvataggio dati", secondError);
      return false;
    }
  }
}

function saveState({ sync = true } = {}) {
  if (!writeStateToLocalStorage()) {
    showToast("Spazio del browser esaurito. Esporta un backup e libera i dati del sito.");
    return false;
  }

  renderAll();
  if (sync && state.settings.telegramEnabled) {
    syncCloud(false).catch(console.error);
  }
  scheduleAutoBackup();
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

function clearTherapyImages() {
  return mediaRequest("readwrite", (store) => store.clear());
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Lettura immagine non riuscita"));
    reader.readAsDataURL(blob);
  });
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

function monthIntervalValue(therapy) {
  return Math.max(1, Number.parseInt(therapy?.monthInterval || 1, 10) || 1);
}

function monthIntervalApplies(therapy, date) {
  const interval = monthIntervalValue(therapy);
  if (interval <= 1 || !therapy.startDate) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(therapy.startDate);
  if (!match) return true;
  const startYear = Number(match[1]);
  const startMonth = Number(match[2]) - 1;
  const difference = (date.getFullYear() - startYear) * 12 + (date.getMonth() - startMonth);
  return difference >= 0 && difference % interval === 0;
}

function addDaysToIso(iso, days) {
  if (!iso || !Number.isFinite(days)) return "";
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + days);
  return localDateISO(date);
}


function parseIsoDateLocal(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
}

function addCalendarMonths(date, months) {
  const originalDay = date.getDate();
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1, 12, 0, 0);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12, 0, 0).getDate();
  first.setDate(Math.min(originalDay, lastDay));
  return first;
}

function cyclicSchedule(therapy) {
  const normalized = normalizeTherapyRecord(therapy);
  if (normalized.scheduleType !== "cyclic" || !normalized.startDate) return [];
  const firstStart = parseIsoDateLocal(normalized.startDate);
  if (!firstStart) return [];
  const windows = [];
  for (let index = 0; index < normalized.cycleCount; index += 1) {
    const start = addCalendarMonths(firstStart, index * normalized.cycleIntervalMonths);
    const end = new Date(start);
    end.setDate(end.getDate() + normalized.cycleDurationDays - 1);
    windows.push({
      index: index + 1,
      startDate: localDateISO(start),
      endDate: localDateISO(end)
    });
  }
  return windows;
}

function cyclicApplies(therapy, date) {
  const iso = localDateISO(date);
  return cyclicSchedule(therapy).some((window) => iso >= window.startDate && iso <= window.endDate);
}

function cyclicFinalEndDate(therapy) {
  const windows = cyclicSchedule(therapy);
  return windows.length ? windows[windows.length - 1].endDate : "";
}

function formatShortIso(iso) {
  const parts = String(iso || "").split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : iso;
}

function updateCycleFields() {
  const type = $("#scheduleType")?.value || "standard";
  const cyclic = type === "cyclic";
  const manual = type === "manual";
  $("#cycleFields")?.classList.toggle("hidden", !cyclic);
  $("#standardScheduleFields")?.classList.toggle("hidden", cyclic || manual);
  $("#weekdayFields")?.classList.toggle("hidden", manual);
  $("#dateRangeFields")?.classList.toggle("hidden", manual);
  $("#manualScheduleNote")?.classList.toggle("hidden", !manual);

  const endInput = $("#endDate");
  const endLabel = $("#endDateLabel");
  if (endInput && endLabel) {
    endInput.readOnly = cyclic;
    endLabel.childNodes[0].textContent = cyclic ? "Fine complessiva (automatica) " : "Data fine ";
  }

  if (manual) return;
  if (!cyclic) return;

  const draft = {
    scheduleType: "cyclic",
    startDate: $("#startDate")?.value || localDateISO(),
    cycleDurationDays: Math.max(1, Number.parseInt($("#cycleDurationDays")?.value || "14", 10) || 14),
    cycleIntervalMonths: Math.max(1, Number.parseInt($("#cycleIntervalMonths")?.value || "2", 10) || 2),
    cycleCount: Math.max(1, Number.parseInt($("#cycleCount")?.value || "3", 10) || 3)
  };
  const windows = cyclicSchedule(draft);
  if (endInput) endInput.value = windows.length ? windows[windows.length - 1].endDate : "";
  const preview = $("#cyclePreview");
  if (preview) {
    preview.innerHTML = windows.length
      ? `<strong>Cicli programmati:</strong> ${windows.map((w) => `${formatShortIso(w.startDate)}–${formatShortIso(w.endDate)}`).join(" · ")}`
      : "Inserisci una data di inizio valida.";
  }
}

function inclusiveDurationDays(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = new Date(`${startIso}T12:00:00`);
  const end = new Date(`${endIso}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  return Math.round((end - start) / 86400000);
}



function normalizeScheduleOverride(item = {}) {
  const therapyId = String(item?.therapyId || "").trim();
  const date = String(item?.date || "").trim();
  const mode = item?.mode === "exclude" ? "exclude" : item?.mode === "include" ? "include" : "";
  const times = [...new Set((Array.isArray(item?.times) ? item.times : [])
    .map((time) => String(time || "").trim())
    .filter((time) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)))].sort();
  if (!therapyId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !mode) return null;
  return { therapyId, date, mode, times, updatedAt: item?.updatedAt || "" };
}

function getScheduleOverride(therapyId, dateIso) {
  return (state.scheduleOverrides || []).find((item) =>
    item.therapyId === therapyId && item.date === dateIso
  ) || null;
}

function removeScheduleOverride(therapyId, dateIso) {
  state.scheduleOverrides = (state.scheduleOverrides || []).filter((item) =>
    !(item.therapyId === therapyId && item.date === dateIso)
  );
}

function upsertScheduleOverride(override) {
  const normalized = normalizeScheduleOverride(override);
  if (!normalized) return;
  removeScheduleOverride(normalized.therapyId, normalized.date);
  state.scheduleOverrides.push(normalized);
}

function sameTimes(a, b) {
  const first = [...new Set((a || []).map(String))].sort();
  const second = [...new Set((b || []).map(String))].sort();
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function parseManualTimes(value) {
  return [...new Set(String(value || "")
    .split(/[\s,;]+/)
    .map((time) => time.trim())
    .filter(Boolean))]
    .filter((time) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    .sort();
}

function normalizeTherapyText(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("it-IT")
    .replace(/\s+/g, " ");
}

function normalizedDays(therapy) {
  return [...new Set((therapy?.days || []).map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
}

function normalizedTimes(therapy) {
  return [...new Set((therapy?.times || []).map(String))].sort();
}

function sameArrayValues(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function dateRangesOverlap(first, second) {
  const firstStart = first?.startDate || "0000-01-01";
  const firstEnd = first?.endDate || "9999-12-31";
  const secondStart = second?.startDate || "0000-01-01";
  const secondEnd = second?.endDate || "9999-12-31";
  return firstStart <= secondEnd && secondStart <= firstEnd;
}

function sameTherapySchedule(first, second) {
  return (
    normalizeTherapyText(first?.name) === normalizeTherapyText(second?.name) &&
    normalizeTherapyText(first?.dose) === normalizeTherapyText(second?.dose) &&
    sameArrayValues(normalizedDays(first), normalizedDays(second)) &&
    sameArrayValues(normalizedTimes(first), normalizedTimes(second)) &&
    monthIntervalValue(first) === monthIntervalValue(second) &&
    normalizeTherapyRecord(first).scheduleType === normalizeTherapyRecord(second).scheduleType &&
    (normalizeTherapyRecord(first).scheduleType !== "cyclic" || (
      normalizeTherapyRecord(first).cycleDurationDays === normalizeTherapyRecord(second).cycleDurationDays &&
      normalizeTherapyRecord(first).cycleIntervalMonths === normalizeTherapyRecord(second).cycleIntervalMonths &&
      normalizeTherapyRecord(first).cycleCount === normalizeTherapyRecord(second).cycleCount
    ))
  );
}

function findDuplicateTherapy(candidate, excludeId = "") {
  return state.therapies.find((other) =>
    !other.archived &&
    other.id !== excludeId &&
    sameTherapySchedule(candidate, other) &&
    dateRangesOverlap(candidate, other)
  ) || null;
}

function todayDoseDuplicateKey(dose) {
  return [
    normalizeTherapyText(dose?.therapy?.name),
    normalizeTherapyText(dose?.therapy?.dose),
    String(dose?.time || "")
  ].join("|");
}

function baseTherapyApplies(therapy, date) {
  const normalized = normalizeTherapyRecord(therapy);
  if (normalized.archived || !normalized.active) return false;
  if (normalized.scheduleType === "manual") return false;
  const iso = localDateISO(date);
  if (normalized.startDate && iso < normalized.startDate) return false;
  if (normalized.scheduleType === "cyclic") {
    const finalEnd = cyclicFinalEndDate(normalized);
    if (finalEnd && iso > finalEnd) return false;
    if (!cyclicApplies(normalized, date)) return false;
  } else {
    if (normalized.endDate && iso > normalized.endDate) return false;
    if (!monthIntervalApplies(normalized, date)) return false;
  }
  return normalized.days.includes(date.getDay());
}

function therapyApplies(therapy, date) {
  const normalized = normalizeTherapyRecord(therapy);
  if (normalized.archived || !normalized.active) return false;
  const iso = localDateISO(date);
  const override = getScheduleOverride(normalized.id, iso);
  if (override?.mode === "exclude") return false;
  if (override?.mode === "include") return true;
  return baseTherapyApplies(normalized, date);
}

function effectiveTimesForDate(therapy, date) {
  const normalized = normalizeTherapyRecord(therapy);
  const override = getScheduleOverride(normalized.id, localDateISO(date));
  if (override?.mode === "include" && override.times?.length) return override.times;
  return normalizedTimes(normalized);
}

function therapyTodayReason(therapy, date = new Date()) {
  const normalized = normalizeTherapyRecord(therapy);
  const iso = localDateISO(date);

  if (normalized.archived) return { key: "archived", text: "Archiviata", detail: "La terapia è nell’archivio." };
  if (!normalized.active) return { key: "paused", text: "Sospesa", detail: "La terapia è sospesa." };
  const manualOverride = getScheduleOverride(normalized.id, iso);
  if (manualOverride?.mode === "exclude") {
    return { key: "manual-off", text: "Tolto oggi", detail: "Rimosso manualmente dal calendario per oggi." };
  }
  if (manualOverride?.mode === "include") {
    return { key: "manual-on", text: "Manuale oggi", detail: "Aggiunto o modificato manualmente dal calendario per oggi." };
  }
  if (normalized.scheduleType === "manual") {
    return { key: "manual-off", text: "Non selezionata", detail: "Questa terapia usa il calendario manuale e oggi non è stato selezionato." };
  }
  if (normalized.startDate && iso < normalized.startDate) {
    return { key: "future", text: "Non iniziata", detail: `Inizia il ${normalized.startDate.split("-").reverse().join("/")}.` };
  }
  if (normalized.scheduleType === "cyclic") {
    const windows = cyclicSchedule(normalized);
    const finalEnd = windows.length ? windows[windows.length - 1].endDate : "";
    if (finalEnd && iso > finalEnd) {
      return { key: "ended", text: "Terminata", detail: `Tutti i ${normalized.cycleCount} cicli sono conclusi.` };
    }
    const activeWindow = windows.find((window) => iso >= window.startDate && iso <= window.endDate);
    if (!activeWindow) {
      const nextWindow = windows.find((window) => iso < window.startDate);
      return {
        key: "cycle-pause",
        text: "Pausa ciclo",
        detail: nextWindow ? `Prossimo ciclo dal ${formatShortIso(nextWindow.startDate)}.` : "Ciclo non attivo oggi."
      };
    }
  } else {
    if (normalized.endDate && iso > normalized.endDate) {
      return { key: "ended", text: "Terminata", detail: `Data fine ${normalized.endDate.split("-").reverse().join("/")}. Usa “Ripeti” per impostarla nuovamente.` };
    }
    if (!monthIntervalApplies(normalized, date)) {
      return { key: "offmonth", text: "Pausa mensile", detail: "La periodicità a mesi alterni esclude il mese corrente." };
    }
  }
  if (!normalized.days.includes(date.getDay())) {
    return { key: "not-today", text: "Attiva", detail: "Oggi non è tra i giorni selezionati." };
  }
  if (!normalized.times.length) {
    return { key: "no-time", text: "Da correggere", detail: "Non è presente alcun orario valido." };
  }
  return { key: "today", text: "Oggi", detail: "È programmata per oggi." };
}

function dosesForDate(date = new Date()) {
  const iso = localDateISO(date);
  const regular = state.therapies
    .filter((therapy) => therapyApplies(therapy, date))
    .flatMap((therapy) => effectiveTimesForDate(therapy, date).map((time) => {
      const log = state.logs.find((item) => item.therapyId === therapy.id && item.date === iso && item.time === time);
      const snooze = getSnooze(therapy.id, iso, time);
      return { therapy, time, originalDate: iso, log, snooze };
    }));

  const movedHere = (state.snoozes || [])
    .filter((item) => item.snoozeDate === iso && item.originalDate !== iso)
    .map((item) => {
      const therapy = state.therapies.find((t) => t.id === item.therapyId);
      if (!therapy || therapy.archived || !therapy.active) return null;
      const log = state.logs.find((entry) => entry.therapyId === item.therapyId && entry.date === item.originalDate && entry.time === item.originalTime);
      return { therapy, time: item.originalTime, originalDate: item.originalDate, log, snooze: item };
    })
    .filter(Boolean);

  return [...regular, ...movedHere].sort((a, b) => doseMoment(a, date) - doseMoment(b, date));
}

function doseStatus(dose, now = new Date()) {
  if (dose.log?.status === "taken") return { key: "taken", text: "Presa" };
  if (dose.log?.status === "skipped") return { key: "skipped", text: "Saltata" };
  const moment = doseMoment(dose, now);
  const delta = Math.round((moment.getTime() - now.getTime()) / 60000);
  if (dose.snooze && delta > 0) return { key: "next", text: `Posticipata · ${doseDisplayTime(dose)}` };
  if (delta > 30) return { key: "next", text: `Tra ${Math.floor(delta / 60) ? `${Math.floor(delta / 60)} h ` : ""}${Math.abs(delta % 60)} min` };
  if (delta > 0) return { key: "due", text: `Tra ${delta} min` };
  if (delta >= -30) return { key: "due", text: dose.snooze ? "Promemoria posticipato" : "Da prendere" };
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
  if (view === "archive") renderArchive();
  if (view === "calendar") renderCalendar();
}

function imageHTML(src, cls = "med-thumb") {
  if (!src) return "";
  return `<img src="${src}" alt="Immagine farmaco" class="${cls}">`;
}


function getSnooze(therapyId, originalDate, originalTime) {
  return (state.snoozes || []).find((item) =>
    item.therapyId === therapyId && item.originalDate === originalDate && item.originalTime === originalTime
  ) || null;
}

function removeLocalSnooze(therapyId, originalDate, originalTime) {
  state.snoozes = (state.snoozes || []).filter((item) =>
    !(item.therapyId === therapyId && item.originalDate === originalDate && item.originalTime === originalTime)
  );
}

function doseOriginalDate(dose, fallbackDate = new Date()) {
  return dose.originalDate || localDateISO(fallbackDate);
}

function doseDisplayDate(dose, fallbackDate = new Date()) {
  return dose.snooze?.snoozeDate || doseOriginalDate(dose, fallbackDate);
}

function doseDisplayTime(dose) {
  return dose.snooze?.snoozeTime || dose.time;
}

function doseMoment(dose, fallbackDate = new Date()) {
  return new Date(`${doseDisplayDate(dose, fallbackDate)}T${doseDisplayTime(dose)}:00`);
}

function stockEnabled(therapy) {
  return therapy?.stockUnits !== "" && therapy?.stockUnits != null && Number.isFinite(Number(therapy.stockUnits));
}

function stockText(therapy) {
  if (!stockEnabled(therapy)) return "";
  const value = Math.max(0, Number(therapy.stockUnits) || 0);
  return Number.isInteger(value) ? String(value) : value.toLocaleString("it-IT", { maximumFractionDigits: 1 });
}

function isLowStock(therapy) {
  return stockEnabled(therapy) && Number(therapy.stockUnits) <= Math.max(0, Number(therapy.lowStockThreshold) || 0);
}

function scheduledDosesForDate(date) {
  return dosesForDate(date).filter((dose, index, all) => {
    const key = `${dose.therapy.id}|${doseOriginalDate(dose, date)}|${dose.time}`;
    return all.findIndex((other) => `${other.therapy.id}|${doseOriginalDate(other, date)}|${other.time}` === key) === index;
  });
}

function monthStatistics(cursor = calendarCursor) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const last = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  let taken = 0, skipped = 0, missed = 0, scheduled = 0;
  const missedByTherapy = new Map();
  for (let day = 1; day <= last; day += 1) {
    const date = new Date(year, month, day, 12, 0, 0);
    const doses = scheduledDosesForDate(date);
    scheduled += doses.length;
    if (date > today) continue;
    for (const dose of doses) {
      if (dose.log?.status === "taken") taken += 1;
      else if (dose.log?.status === "skipped") skipped += 1;
      else if (doseMoment(dose, date) < today) {
        missed += 1;
        missedByTherapy.set(dose.therapy.name, (missedByTherapy.get(dose.therapy.name) || 0) + 1);
      }
    }
  }
  const denominator = taken + skipped + missed;
  const adherence = denominator ? Math.round((taken / denominator) * 100) : 100;
  const worst = [...missedByTherapy.entries()].sort((a,b) => b[1]-a[1])[0] || null;
  return { taken, skipped, missed, scheduled, adherence, worst };
}


function calendarTherapySummaries(date) {
  const doses = scheduledDosesForDate(date);
  const groups = new Map();
  for (const dose of doses) {
    const current = groups.get(dose.therapy.id) || { therapy: dose.therapy, times: [], doses: [] };
    current.times.push(doseDisplayTime(dose));
    current.doses.push(dose);
    groups.set(dose.therapy.id, current);
  }
  return [...groups.values()].map((item) => ({
    ...item,
    times: [...new Set(item.times)].sort()
  }));
}

function openCalendarDayDialog(dateIso) {
  const date = parseIsoDateLocal(dateIso);
  if (!date) return;
  $("#calendarDayDate").value = dateIso;
  $("#calendarDayTitle").textContent = new Intl.DateTimeFormat("it-IT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(date);
  $("#calendarDaySubtitle").textContent = "Seleziona manualmente quali terapie devono comparire in questo giorno.";

  const therapies = state.therapies
    .filter((therapy) => !therapy.archived)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "it"));

  if (!therapies.length) {
    $("#calendarDayTherapies").innerHTML = `<div class="empty-state"><p>Nessuna terapia disponibile.</p></div>`;
  } else {
    $("#calendarDayTherapies").innerHTML = therapies.map((therapy) => {
      const normalized = normalizeTherapyRecord(therapy);
      const baseScheduled = baseTherapyApplies(normalized, date);
      const override = getScheduleOverride(normalized.id, dateIso);
      const checked = normalized.active && !normalized.archived && (
        override?.mode === "include" || (override?.mode !== "exclude" && baseScheduled)
      );
      const times = override?.mode === "include" && override.times?.length
        ? override.times
        : normalizedTimes(normalized);
      const sourceText = override?.mode === "include"
        ? "Impostazione manuale"
        : override?.mode === "exclude"
          ? "Tolto manualmente"
          : baseScheduled
            ? "Prevista dal programma"
            : "Non prevista dal programma";
      return `
        <article class="calendar-day-therapy-row ${checked ? "selected" : ""}" data-calendar-therapy="${escapeHTML(normalized.id)}">
          <div class="calendar-day-therapy-head">
            <label class="calendar-day-toggle">
              <input class="calendar-day-therapy-check" type="checkbox" data-id="${escapeHTML(normalized.id)}" ${checked ? "checked" : ""} ${normalized.active ? "" : "disabled"}>
              <span></span>
              <div>
                <strong>${escapeHTML(normalized.name)}</strong>
                <small>${escapeHTML(normalized.dose)}</small>
              </div>
            </label>
            <button class="text-btn calendar-edit-full" data-action="edit-therapy-from-calendar" data-id="${escapeHTML(normalized.id)}" type="button">Modifica terapia</button>
          </div>
          <div class="calendar-day-source ${override ? "manual" : ""}">${escapeHTML(normalized.active ? sourceText : "Terapia sospesa")}</div>
          <label class="calendar-time-label">Orari per questo giorno
            <input class="calendar-day-times" data-id="${escapeHTML(normalized.id)}" type="text" inputmode="numeric"
              value="${escapeHTML(times.join(", "))}" placeholder="08:00, 20:00" ${checked ? "" : "disabled"}>
          </label>
        </article>`;
    }).join("");
  }

  $("#calendarDayDialog").showModal();
}

function closeCalendarDayDialog() {
  if ($("#calendarDayDialog")?.open) $("#calendarDayDialog").close();
}

function saveCalendarDay(event) {
  event.preventDefault();
  const dateIso = $("#calendarDayDate").value;
  const date = parseIsoDateLocal(dateIso);
  if (!date) return showToast("Data non valida.");

  const therapies = state.therapies.filter((therapy) => !therapy.archived);
  for (const therapy of therapies) {
    const normalized = normalizeTherapyRecord(therapy);
    const check = $(`.calendar-day-therapy-check[data-id="${CSS.escape(normalized.id)}"]`);
    const timeInput = $(`.calendar-day-times[data-id="${CSS.escape(normalized.id)}"]`);
    if (!check) continue;

    const baseScheduled = baseTherapyApplies(normalized, date);
    const selected = check.checked && normalized.active;
    const enteredTimes = parseManualTimes(timeInput?.value || "");
    const baseTimes = normalizedTimes(normalized);

    if (selected && !enteredTimes.length) {
      timeInput?.focus();
      return showToast(`Inserisci almeno un orario valido per ${normalized.name}.`);
    }

    removeScheduleOverride(normalized.id, dateIso);

    if (!selected && baseScheduled) {
      upsertScheduleOverride({
        therapyId: normalized.id,
        date: dateIso,
        mode: "exclude",
        times: [],
        updatedAt: new Date().toISOString()
      });
    } else if (selected && (!baseScheduled || !sameTimes(enteredTimes, baseTimes))) {
      upsertScheduleOverride({
        therapyId: normalized.id,
        date: dateIso,
        mode: "include",
        times: enteredTimes,
        updatedAt: new Date().toISOString()
      });
    }
  }

  saveState();
  closeCalendarDayDialog();
  showToast("Programmazione del giorno aggiornata.");
}

function resetCalendarDay() {
  const dateIso = $("#calendarDayDate").value;
  if (!dateIso) return;
  const countBefore = (state.scheduleOverrides || []).length;
  state.scheduleOverrides = (state.scheduleOverrides || []).filter((item) => item.date !== dateIso);
  if (state.scheduleOverrides.length === countBefore) {
    showToast("Il giorno usa già il programma automatico.");
  } else {
    saveState();
    showToast("Ripristinato il programma automatico.");
  }
  openCalendarDayDialog(dateIso);
}


function duplicateIdentityKey(therapy) {
  return [
    normalizeTherapyText(therapy?.name),
    normalizeTherapyText(therapy?.dose)
  ].join("|");
}

function duplicateGroupForTherapy(therapy) {
  if (!therapy) return [];
  const key = duplicateIdentityKey(therapy);
  return (state.therapies || []).filter((item) =>
    !item.archived && duplicateIdentityKey(item) === key
  );
}

function exactDuplicateGroupForTherapy(therapy) {
  if (!therapy) return [];
  return (state.therapies || []).filter((item) =>
    !item.archived &&
    item.id !== therapy.id &&
    sameTherapySchedule(item, therapy) &&
    dateRangesOverlap(item, therapy)
  );
}

async function removeTherapyCopyById(id, { removeLogs = true } = {}) {
  const therapy = state.therapies.find((item) => item.id === id);
  if (!therapy) return false;

  state.therapies = state.therapies.filter((item) => item.id !== id);
  state.scheduleOverrides = (state.scheduleOverrides || []).filter((item) => item.therapyId !== id);
  state.snoozes = (state.snoozes || []).filter((item) => item.therapyId !== id);
  if (removeLogs) {
    state.logs = (state.logs || []).filter((item) => item.therapyId !== id);
  }

  try {
    await deleteTherapyImage(id);
  } catch (error) {
    console.warn("Immagine della copia non rimossa", error);
  }
  replaceTherapyImageUrl(id, null);

  if (selectedCalendarTherapyId === id) selectedCalendarTherapyId = "";
  return saveState();
}

async function deleteSelectedCalendarCopy() {
  const therapy = selectedCalendarTherapy();
  if (!therapy) return;

  const group = duplicateGroupForTherapy(therapy);
  if (group.length <= 1) {
    showToast("Questo medicinale non risulta avere copie.");
    return;
  }

  const exact = exactDuplicateGroupForTherapy(therapy);
  const detail = exact.length
    ? "Questa voce risulta sovrapposta a un’altra copia con la stessa programmazione."
    : "Esistono più voci con lo stesso nome e la stessa dose.";

  const ok = confirm(
    `Eliminare definitivamente questa copia?\n\n${therapy.name} — ${therapy.dose}\n${normalizedTimes(therapy).join(", ")}\n\n${detail}\n\nSaranno eliminate anche le registrazioni e le modifiche calendario appartenenti soltanto a questa copia. Le altre copie resteranno invariate.`
  );
  if (!ok) return;

  await removeTherapyCopyById(therapy.id, { removeLogs: true });
  renderCalendar();
  showToast("Copia eliminata.");
}

async function cleanExactDuplicateCopies() {
  const therapy = selectedCalendarTherapy();
  if (!therapy) return;

  const exact = exactDuplicateGroupForTherapy(therapy);
  if (!exact.length) {
    showToast("Non ci sono copie identiche da eliminare automaticamente.");
    return;
  }

  const list = exact.map((item, index) =>
    `${index + 1}. ${item.name} — ${item.dose} · ${normalizedTimes(item).join(", ")}`
  ).join("\n");

  const ok = confirm(
    `Ho trovato ${exact.length} ${exact.length === 1 ? "copia identica" : "copie identiche"} della terapia selezionata.\n\nVerrà mantenuta la voce attualmente selezionata e saranno eliminate queste copie:\n\n${list}\n\nContinuare?`
  );
  if (!ok) return;

  for (const duplicate of exact) {
    await removeTherapyCopyById(duplicate.id, { removeLogs: true });
  }
  selectedCalendarTherapyId = therapy.id;
  renderCalendar();
  showToast(exact.length === 1 ? "Copia duplicata eliminata." : `${exact.length} copie duplicate eliminate.`);
}

function updateCalendarDuplicateControls(therapy) {
  const deleteBtn = $("#calendarDeleteCopyBtn");
  const cleanBtn = $("#calendarCleanCopiesBtn");
  const hint = $("#calendarDuplicateHint");
  if (!deleteBtn || !cleanBtn || !hint) return;

  if (!therapy) {
    deleteBtn.classList.add("hidden");
    cleanBtn.classList.add("hidden");
    hint.classList.add("hidden");
    return;
  }

  const group = duplicateGroupForTherapy(therapy);
  const exact = exactDuplicateGroupForTherapy(therapy);

  deleteBtn.classList.toggle("hidden", group.length <= 1);
  cleanBtn.classList.toggle("hidden", exact.length === 0);

  if (group.length > 1) {
    hint.classList.remove("hidden");
    hint.innerHTML = exact.length
      ? `⚠️ <strong>${group.length} copie</strong> di ${escapeHTML(therapy.name)}. ${exact.length} ${exact.length === 1 ? "è identica" : "sono identiche"} alla voce selezionata.`
      : `ℹ️ Sono presenti <strong>${group.length} voci</strong> con lo stesso nome e la stessa dose. Controlla prima di eliminarle.`;
  } else {
    hint.classList.add("hidden");
  }
}

function availableCalendarTherapies() {
  return (state.therapies || [])
    .filter((therapy) => !therapy.archived)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "it"));
}

function selectedCalendarTherapy() {
  const therapies = availableCalendarTherapies();
  if (!therapies.length) {
    selectedCalendarTherapyId = "";
    return null;
  }
  if (!therapies.some((therapy) => therapy.id === selectedCalendarTherapyId)) {
    selectedCalendarTherapyId = therapies.find((therapy) => therapy.active)?.id || therapies[0].id;
  }
  return therapies.find((therapy) => therapy.id === selectedCalendarTherapyId) || therapies[0];
}

function renderCalendarTherapyPicker() {
  const select = $("#calendarTherapySelect");
  if (!select) return null;
  const therapies = availableCalendarTherapies();
  const selected = selectedCalendarTherapy();

  if (!therapies.length) {
    select.innerHTML = `<option value="">Nessuna terapia</option>`;
    select.disabled = true;
    $("#calendarEditTherapyBtn").disabled = true;
    $("#calendarManualModeBtn").disabled = true;
    updateCalendarDuplicateControls(null);
    return null;
  }

  select.disabled = false;
  const nameCounts = new Map();
  therapies.forEach((therapy) => {
    const key = `${normalizeTherapyText(therapy.name)}|${normalizeTherapyText(therapy.dose)}`;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  });
  const seen = new Map();

  select.innerHTML = therapies.map((therapy) => {
    const key = `${normalizeTherapyText(therapy.name)}|${normalizeTherapyText(therapy.dose)}`;
    const total = nameCounts.get(key) || 1;
    const current = (seen.get(key) || 0) + 1;
    seen.set(key, current);
    const copy = total > 1 ? ` · copia ${current}` : "";
    const paused = therapy.active ? "" : " · sospesa";
    const times = normalizedTimes(therapy).length ? ` · ${normalizedTimes(therapy).join(", ")}` : "";
    return `<option value="${escapeHTML(therapy.id)}">${escapeHTML(therapy.name)} — ${escapeHTML(therapy.dose)}${escapeHTML(times)}${escapeHTML(copy)}${escapeHTML(paused)}</option>`;
  }).join("");

  select.value = selected?.id || therapies[0].id;
  selectedCalendarTherapyId = select.value;
  $("#calendarEditTherapyBtn").disabled = !selected;
  $("#calendarManualModeBtn").disabled = !selected || !selected.active;
  updateCalendarDuplicateControls(selected);
  return selected;
}

function updateCalendarModeInfo(therapy) {
  const modeText = $("#calendarModeText");
  const modeHelp = $("#calendarModeHelp");
  const modeButton = $("#calendarManualModeBtn");
  if (!modeText || !modeHelp || !modeButton) return;

  if (!therapy) {
    modeText.textContent = "Nessun medicinale";
    modeHelp.textContent = "Aggiungi prima una terapia.";
    modeButton.textContent = "Usa solo giorni scelti";
    return;
  }

  const normalized = normalizeTherapyRecord(therapy);
  if (!normalized.active) {
    modeText.textContent = "Terapia sospesa";
    modeHelp.textContent = "Riattivala da Modifica medicinale prima di programmare i giorni.";
    modeButton.textContent = "Terapia sospesa";
    return;
  }

  if (normalized.scheduleType === "manual") {
    modeText.textContent = "Solo giorni scelti manualmente";
    modeHelp.textContent = "Il medicinale compare soltanto nei giorni che tocchi nel calendario.";
    modeButton.textContent = "Torna al programma automatico";
  } else {
    modeText.textContent = normalized.scheduleType === "cyclic" ? "Programma ciclico + modifiche manuali" : "Programma automatico + modifiche manuali";
    modeHelp.textContent = "I giorni previsti dal programma sono già selezionati; puoi toccarli per toglierli o aggiungerne altri.";
    modeButton.textContent = "Usa solo giorni scelti";
  }
}

function calendarSelectedDateState(therapy, date) {
  const iso = localDateISO(date);
  const override = therapy ? getScheduleOverride(therapy.id, iso) : null;
  const selected = therapy ? therapyApplies(therapy, date) : false;
  return { selected, override };
}

function toggleSelectedTherapyDate(dateIso) {
  const therapy = selectedCalendarTherapy();
  if (!therapy) return showToast("Seleziona prima un medicinale.");
  const normalized = normalizeTherapyRecord(therapy);
  if (!normalized.active) return showToast("Questa terapia è sospesa. Riattivala prima di programmare i giorni.");

  const date = parseIsoDateLocal(dateIso);
  if (!date) return;
  const override = getScheduleOverride(normalized.id, dateIso);
  const baseScheduled = baseTherapyApplies(normalized, date);
  const currentlySelected = therapyApplies(normalized, date);

  removeScheduleOverride(normalized.id, dateIso);

  if (normalized.scheduleType === "manual") {
    if (!currentlySelected) {
      upsertScheduleOverride({
        therapyId: normalized.id,
        date: dateIso,
        mode: "include",
        times: normalizedTimes(normalized),
        updatedAt: new Date().toISOString()
      });
    }
  } else if (currentlySelected) {
    if (baseScheduled) {
      upsertScheduleOverride({
        therapyId: normalized.id,
        date: dateIso,
        mode: "exclude",
        times: [],
        updatedAt: new Date().toISOString()
      });
    }
  } else {
    if (!baseScheduled) {
      upsertScheduleOverride({
        therapyId: normalized.id,
        date: dateIso,
        mode: "include",
        times: normalizedTimes(normalized),
        updatedAt: new Date().toISOString()
      });
    }
  }

  saveState();
  renderCalendar();
}

function switchSelectedTherapyCalendarMode() {
  const therapy = selectedCalendarTherapy();
  if (!therapy) return;
  if (!therapy.active) return showToast("Riattiva prima questa terapia.");

  const normalized = normalizeTherapyRecord(therapy);

  if (normalized.scheduleType === "manual") {
    if (!confirm("Vuoi tornare al programma automatico settimanale? Le date scelte manualmente resteranno come eccezioni finché non le togli dal calendario.")) return;
    therapy.scheduleType = "standard";
    if (!therapy.days?.length) therapy.days = [0,1,2,3,4,5,6];
    if (!therapy.startDate) therapy.startDate = localDateISO();
    therapy.updatedAt = new Date().toISOString();
    saveState();
    renderCalendar();
    showToast("Programma automatico riattivato.");
    return;
  }

  if (!confirm("Vuoi usare SOLO i giorni che selezioni manualmente nel calendario per questo medicinale? I giorni automatici non saranno più considerati.")) return;

  therapy.scheduleType = "manual";
  therapy.days = [];
  therapy.startDate = "";
  therapy.endDate = "";
  therapy.monthInterval = 1;

  // Manteniamo solo inclusioni manuali già esistenti; le esclusioni non servono più.
  state.scheduleOverrides = (state.scheduleOverrides || []).filter((item) =>
    item.therapyId !== therapy.id || item.mode === "include"
  );

  therapy.updatedAt = new Date().toISOString();
  saveState();
  renderCalendar();
  showToast("Calendario manuale attivato. Tocca i giorni in cui devi assumere il medicinale.");
}

function renderCalendar() {
  const grid = $("#calendarGrid");
  if (!grid) return;

  const therapy = renderCalendarTherapyPicker();
  updateCalendarModeInfo(therapy);

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const first = new Date(year, month, 1, 12, 0, 0);
  const lastDay = new Date(year, month + 1, 0).getDate();
  $("#calendarMonthLabel").textContent = new Intl.DateTimeFormat("it-IT", {
    month: "long", year: "numeric"
  }).format(first);

  const offset = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < offset; i += 1) {
    cells.push('<div class="calendar-day empty"></div>');
  }

  const now = new Date();
  let selectedInMonth = 0;
  let manualChangesInMonth = 0;

  for (let day = 1; day <= lastDay; day += 1) {
    const date = new Date(year, month, day, 12, 0, 0);
    const iso = localDateISO(date);
    const today = iso === localDateISO(now);
    const { selected, override } = calendarSelectedDateState(therapy, date);
    const allDoses = scheduledDosesForDate(date);
    const totalTherapies = new Set(allDoses.map((dose) => dose.therapy.id)).size;
    const effectiveTimes = therapy && selected ? effectiveTimesForDate(therapy, date) : [];

    if (selected) selectedInMonth += 1;
    if (override) manualChangesInMonth += 1;

    const selectedClass = selected ? " therapy-date-selected" : "";
    const manualClass = override ? " therapy-date-manual" : "";
    const todayClass = today ? " today" : "";

    cells.push(`
      <button class="calendar-day therapy-picker-day${selectedClass}${manualClass}${todayClass}"
        data-calendar-toggle-date="${iso}" type="button"
        aria-pressed="${selected ? "true" : "false"}"
        aria-label="${day} ${$("#calendarMonthLabel").textContent}${selected ? ", terapia impostata" : ""}">
        <span class="picker-day-number">${day}</span>
        <span class="picker-check">${selected ? "✓" : ""}</span>
        ${selected && effectiveTimes.length ? `<span class="picker-time">${escapeHTML(effectiveTimes.join(" · "))}</span>` : ""}
        ${totalTherapies ? `<span class="picker-total">${totalTherapies} ${totalTherapies === 1 ? "terapia" : "terapie"}</span>` : ""}
        ${override ? `<span class="picker-manual-mark">✎</span>` : ""}
      </button>`);
  }

  grid.innerHTML = cells.join("");

  const summary = $("#calendarSelectedSummary");
  if (summary) {
    if (!therapy) {
      summary.innerHTML = `<strong>Nessun medicinale disponibile</strong><p>Aggiungi una terapia e poi seleziona i giorni.</p>`;
    } else {
      const normalized = normalizeTherapyRecord(therapy);
      const mode = normalized.scheduleType === "manual"
        ? "Calendario manuale"
        : normalized.scheduleType === "cyclic"
          ? "Terapia ciclica"
          : "Programma automatico";
      summary.innerHTML = `
        <div>
          <span class="small-note">Medicinale selezionato</span>
          <strong>${escapeHTML(normalized.name)}</strong>
          <p>${escapeHTML(normalized.dose)} · ${escapeHTML(normalizedTimes(normalized).join(", ") || "nessun orario")}</p>
        </div>
        <div class="calendar-summary-numbers">
          <span><strong>${selectedInMonth}</strong> giorni nel mese</span>
          <span><strong>${manualChangesInMonth}</strong> modifiche manuali</span>
          <span class="summary-mode">${escapeHTML(mode)}</span>
        </div>`;
    }
  }

  const stats = monthStatistics(calendarCursor);
  $("#statsGrid").innerHTML = `
    <div class="stat-card adherence-card">
      <div class="adherence-ring" style="--value:${stats.adherence}"><div><strong>${stats.adherence}%</strong><span>Aderenza</span></div></div>
      <p>del mese selezionato</p>
    </div>
    <div class="stat-card stat-taken"><span class="stat-icon">✓</span><strong>${stats.taken}</strong><span>Prese</span></div>
    <div class="stat-card stat-skipped"><span class="stat-icon">−</span><strong>${stats.skipped}</strong><span>Saltate</span></div>
    <div class="stat-card stat-missed"><span class="stat-icon">!</span><strong>${stats.missed}</strong><span>Non registrate</span></div>`;

  const worst = $("#worstTherapyCard");
  if (stats.worst) {
    worst.classList.remove("hidden");
    worst.innerHTML = `<h3>Da controllare</h3><p><strong>${escapeHTML(stats.worst[0])}</strong> è la terapia con più assunzioni non registrate nel mese (${stats.worst[1]}). È una statistica organizzativa, non una valutazione medica.</p>`;
  } else {
    worst.classList.add("hidden");
  }
}

function renderAll() {
  renderToday();
  renderTherapies();
  renderArchive();
  renderCalendar();
  renderHistory();
  renderSettings();
}

function renderToday() {
  const now = new Date();
  const doses = dosesForDate(now);
  const completed = doses.filter((dose) => ["taken", "skipped"].includes(dose.log?.status)).length;
  $("#todayDate").textContent = formatLongDate(now);
  $("#progressValue").textContent = `${completed}/${doses.length}`;
  const progressFill = $("#progressFill");
  if (progressFill) progressFill.style.width = `${doses.length ? Math.round((completed / doses.length) * 100) : 0}%`;
  const next = doses.filter((dose) => !dose.log).sort((a,b) => doseMoment(a,now)-doseMoment(b,now))[0];
  const nextKey = next ? `${next.therapy.id}|${doseOriginalDate(next, now)}|${next.time}` : "";
  $("#nextDoseText").textContent = next ? `Prossima: ${next.therapy.name} alle ${doseDisplayTime(next)}` : doses.length ? "Programma completato per oggi." : "Aggiungi la prima terapia per iniziare.";
  $("#todayEmpty").classList.toggle("hidden", doses.length > 0);

  const duplicateCounts = new Map();
  doses.forEach((dose) => {
    const key = todayDoseDuplicateKey({ ...dose, time: doseDisplayTime(dose) });
    duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
  });
  const alreadyRendered = new Set();
  const list = $("#todayList");
  list.innerHTML = doses.map((dose) => {
    const status = doseStatus(dose, now);
    const displayTime = doseDisplayTime(dose);
    const originalDate = doseOriginalDate(dose, now);
    const duplicateKey = todayDoseDuplicateKey({ ...dose, time: displayTime });
    const isDuplicate = (duplicateCounts.get(duplicateKey) || 0) > 1 && alreadyRendered.has(duplicateKey);
    alreadyRendered.add(duplicateKey);
    const stock = stockText(dose.therapy);
    const doseKey = `${dose.therapy.id}|${originalDate}|${dose.time}`;
    const isNextDose = !!nextKey && doseKey === nextKey;
    return `
      <article class="dose-card ${isNextDose ? "featured-dose" : ""} ${dose.log ? "completed-dose" : ""} ${isDuplicate ? "duplicate-dose-card" : ""}">
        ${isNextDose ? `<div class="featured-kicker"><span></span> Prossima terapia</div>` : ""}
        <div class="dose-side">
          <div class="time-badge">${escapeHTML(displayTime)}${dose.snooze ? `<small>era ${escapeHTML(dose.time)}</small>` : ""}</div>
          ${therapyImageUrls.get(dose.therapy.id) ? imageHTML(therapyImageUrls.get(dose.therapy.id), "med-thumb small") : ""}
        </div>
        <div class="dose-main">
          <div class="therapy-card-top"><div><h3>${escapeHTML(dose.therapy.name)}</h3><p class="dose-meta">${escapeHTML(dose.therapy.dose)}</p></div><span class="status-line status-${status.key}">${escapeHTML(status.text)}</span></div>
          <div class="therapy-times">
            ${dose.snooze ? `<span class="chip snooze-chip">⏰ Posticipata a ${escapeHTML(dose.snooze.snoozeDate === originalDate ? displayTime : `${dose.snooze.snoozeDate} ${displayTime}`)}</span>` : ""}
            ${stock ? `<span class="chip stock-chip ${isLowStock(dose.therapy) ? "low" : ""}">Scorta: ${escapeHTML(stock)}</span>` : ""}
            ${dose.therapy.barcode ? `<span class="chip code-chip">Codice: ${escapeHTML(dose.therapy.barcode)}</span>` : ""}
          </div>
          ${isLowStock(dose.therapy) ? `<div class="stock-warning">⚠️ Scorta bassa: restano ${escapeHTML(stock)} unità.</div>` : ""}
          ${dose.therapy.notes ? `<p class="dose-note">${escapeHTML(dose.therapy.notes)}</p>` : ""}
          ${isDuplicate ? `<div class="duplicate-warning"><strong>⚠️ Possibile duplicato</strong><span>Questa terapia è già presente oggi allo stesso orario.</span><button class="action-remove-duplicate" data-action="remove-duplicate-therapy" data-id="${dose.therapy.id}" type="button">Rimuovi questa copia</button></div>` : ""}
          <div class="dose-actions">
            ${dose.log ? `<button class="action-reset" data-action="reset-dose" data-id="${dose.therapy.id}" data-time="${dose.time}" data-date="${originalDate}" type="button">Annulla registrazione</button>` : `
              <button class="action-taken" data-action="mark-taken" data-id="${dose.therapy.id}" data-time="${dose.time}" data-date="${originalDate}" type="button">✓ Presa</button>
              <button class="action-skipped" data-action="mark-skipped" data-id="${dose.therapy.id}" data-time="${dose.time}" data-date="${originalDate}" type="button">Saltata</button>`}
          </div>
          ${!dose.log ? `<div class="snooze-actions"><span class="small-note">Posticipa:</span><button class="snooze-button" data-action="snooze-dose" data-minutes="10" data-id="${dose.therapy.id}" data-time="${dose.time}" data-date="${originalDate}" type="button">+10 min</button><button class="snooze-button" data-action="snooze-dose" data-minutes="30" data-id="${dose.therapy.id}" data-time="${dose.time}" data-date="${originalDate}" type="button">+30 min</button><button class="snooze-button" data-action="snooze-dose" data-minutes="60" data-id="${dose.therapy.id}" data-time="${dose.time}" data-date="${originalDate}" type="button">+1 ora</button></div>` : ""}
        </div>
      </article>`;
  }).join("");
}

function therapyCardHtml(therapy, { archived = false } = {}) {
  const dayNames = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
  const archivedDate = therapy.archivedAt
    ? new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" }).format(new Date(therapy.archivedAt))
    : "";
  const image = therapyImageUrls.get(therapy.id);
  const initial = escapeHTML(String(therapy.name || "T").trim().charAt(0).toUpperCase());

  return `
    <article class="therapy-card ${therapy.active && !archived ? "" : "inactive"}">
      <div class="therapy-card-top">
        <div class="therapy-title-row">
          ${image ? imageHTML(image, "med-thumb-card") : `<div class="therapy-placeholder" aria-hidden="true">${initial}</div>`}
          <div class="therapy-heading-copy">
            <h3>${escapeHTML(therapy.name)}</h3>
            <p class="muted">${escapeHTML(therapy.dose)}</p>
          </div>
        </div>
        ${(() => {
          const todayState = therapyTodayReason(therapy);
          const cls = archived ? "archived" : todayState.key === "today" ? "active" : todayState.key === "ended" ? "ended" : todayState.key === "paused" ? "paused" : "scheduled";
          return `<span class="status-pill ${cls}">${escapeHTML(archived ? "Archiviata" : todayState.text)}</span>`;
        })()}
      </div>
      <div class="therapy-card-body">
        <div class="therapy-times">${therapy.times.map((time) => `<span class="chip time-chip">${escapeHTML(time)}</span>`).join("")}</div>
        <p class="schedule-copy">${therapy.days.length === 7 ? "Tutti i giorni" : therapy.days.map((d) => dayNames[d]).join(", ")}</p>
        <div class="therapy-badges">
          ${normalizeTherapyRecord(therapy).scheduleType === "manual"
            ? `<span class="chip recurrence-chip">Calendario manuale</span>`
            : normalizeTherapyRecord(therapy).scheduleType === "cyclic"
              ? `<span class="chip recurrence-chip">Ciclo ${normalizeTherapyRecord(therapy).cycleDurationDays} gg · ogni ${normalizeTherapyRecord(therapy).cycleIntervalMonths} mesi · ${normalizeTherapyRecord(therapy).cycleCount} volte</span>`
              : monthIntervalValue(therapy) === 2 ? `<span class="chip recurrence-chip">Mesi alterni</span>` : ""}
          ${stockEnabled(therapy) ? `<span class="chip stock-chip ${isLowStock(therapy) ? "low" : ""}">Scorta ${escapeHTML(stockText(therapy))}</span>` : ""}
          ${therapy.barcode ? `<span class="chip code-chip">Cod. ${escapeHTML(therapy.barcode)}</span>` : ""}
        </div>
        ${isLowStock(therapy) ? `<div class="stock-warning">⚠️ Scorta bassa: valuta il rifornimento.</div>` : ""}
        ${therapy.notes ? `<p class="therapy-note">${escapeHTML(therapy.notes)}</p>` : ""}
        ${!archived ? (() => {
          const todayState = therapyTodayReason(therapy);
          return todayState.key === "today"
            ? `<p class="today-schedule-note">✓ Prevista oggi</p>`
            : `<p class="schedule-explanation">${escapeHTML(todayState.detail)}</p>`;
        })() : ""}
        ${archivedDate ? `<p class="small-note">Archiviata il ${escapeHTML(archivedDate)}</p>` : ""}
      </div>
      <div class="card-menu modern-card-menu">
        ${archived ? `
          <button class="primary small" data-action="restore-therapy" data-id="${therapy.id}" type="button">Ripristina</button>
          <details class="card-more"><summary aria-label="Altre azioni">•••</summary><div class="card-more-menu">
            <button data-action="edit-therapy" data-id="${therapy.id}" type="button">Consulta / modifica</button>
            <button class="danger-text" data-action="delete-forever" data-id="${therapy.id}" type="button">Elimina definitivamente</button>
          </div></details>
        ` : `
          <button class="secondary small" data-action="edit-therapy" data-id="${therapy.id}" type="button">Modifica</button>
          <button class="secondary small repeat-button" data-action="repeat-therapy" data-id="${therapy.id}" type="button">↻ Ripeti</button>
          <details class="card-more"><summary aria-label="Altre azioni">•••</summary><div class="card-more-menu">
            <button data-action="toggle-therapy" data-id="${therapy.id}" type="button">${therapy.active ? "Sospendi" : "Riattiva"}</button>
            <button data-action="archive-therapy" data-id="${therapy.id}" type="button">Archivia</button>
          </div></details>
        `}
      </div>
    </article>`;
}

function renderTherapies() {
  const list = $("#therapyList");
  const therapies = state.therapies.filter((therapy) => !therapy.archived);
  if (!therapies.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">💊</div><h3>Nessuna terapia corrente</h3><p>Premi “Aggiungi” per creare una terapia oppure controlla l’Archivio.</p></div>`;
    return;
  }
  list.innerHTML = therapies.map((therapy) => therapyCardHtml(therapy)).join("");
}

function renderArchive() {
  const list = $("#archiveList");
  if (!list) return;
  const term = ($("#archiveSearch")?.value || "").trim().toLowerCase();
  const archived = state.therapies
    .filter((therapy) => therapy.archived)
    .filter((therapy) => {
      if (!term) return true;
      return [therapy.name, therapy.dose, therapy.barcode, therapy.notes]
        .some((value) => String(value || "").toLowerCase().includes(term));
    })
    .sort((a, b) => String(b.archivedAt || "").localeCompare(String(a.archivedAt || "")));

  const total = state.therapies.filter((therapy) => therapy.archived).length;
  if ($("#archiveCount")) $("#archiveCount").textContent = `${total} ${total === 1 ? "archiviata" : "archiviate"}`;

  if (!archived.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🗃️</div><h3>${term ? "Nessun risultato" : "Archivio vuoto"}</h3><p>${term ? "Prova con un altro termine di ricerca." : "Quando archivi una terapia, resterà conservata qui con tutti i suoi dati."}</p></div>`;
    return;
  }
  list.innerHTML = archived.map((therapy) => therapyCardHtml(therapy, { archived: true })).join("");
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
  const headerSync = $("#headerSyncStatus");
  if (headerSync) {
    const cloudReady = !!(s.apiBase && (s.backupId || s.appKey));
    const synced = !!s.lastDeviceSyncAt || !!s.cloudBackupLast;
    headerSync.innerHTML = `<span class="sync-dot ${cloudReady ? "online" : ""}"></span>${cloudReady ? (synced ? "Sincronizzato" : "Cloud") : "Locale"}`;
  }
  $("#telegramEnabled").checked = !!s.telegramEnabled;
  if ($("#multiDeviceSyncEnabled")) $("#multiDeviceSyncEnabled").checked = s.multiDeviceSyncEnabled !== false;
  if ($("#multiDeviceSyncStatus") && s.lastDeviceSyncAt) {
    $("#multiDeviceSyncStatus").textContent = `Aggiornata ${new Date(s.lastDeviceSyncAt).toLocaleTimeString("it-IT", {hour:"2-digit", minute:"2-digit"})}`;
    $("#multiDeviceSyncStatus").className = "status-pill success";
  }
  if ($("#autoBackupEnabled")) $("#autoBackupEnabled").checked = s.autoBackupEnabled !== false;
  $("#apiBase").value = s.apiBase || "";
  $("#appKey").value = s.appKey || "";
  $("#chatId").value = s.chatId || "";
  $("#timezone").value = s.timezone || "Europe/Rome";

  const permission = "Notification" in window ? Notification.permission : "unsupported";
  const statusMap = {
    granted: "Attive",
    denied: "Bloccate",
    default: "Da autorizzare",
    unsupported: "Non supportate"
  };
  $("#notificationStatus").textContent = statusMap[permission] || permission;

  const recoveryInput = $("#recoveryCodeInput");
  if (recoveryInput && document.activeElement !== recoveryInput) {
    recoveryInput.value = s.recoveryCode || "";
  }

  const backupStatus = $("#cloudBackupStatus");
  if (backupStatus) {
    backupStatus.className = "backup-status";
    backupStatus.textContent = s.cloudBackupLast
      ? `Ultimo backup online: ${new Date(s.cloudBackupLast).toLocaleString("it-IT")} · ${formatBytes(Number(s.cloudBackupBytes) || 0)}`
      : "Nessun backup cloud registrato su questo dispositivo.";
  }
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
  $("#stockUnits").value = stockEnabled(therapy) ? therapy.stockUnits : "";
  $("#doseUnits").value = therapy?.doseUnits || 1;
  $("#lowStockThreshold").value = therapy?.lowStockThreshold ?? 5;
  $("#therapyBarcode").value = therapy?.barcode || "";
  $("#startDate").value = therapy?.startDate || localDateISO();
  $("#endDate").value = therapy?.endDate || "";
  $("#therapyNotes").value = therapy?.notes || "";
  $("#scheduleType").value = normalizeTherapyRecord(therapy).scheduleType;
  $("#monthInterval").value = String(monthIntervalValue(therapy));
  $("#cycleDurationDays").value = normalizeTherapyRecord(therapy).cycleDurationDays;
  $("#cycleIntervalMonths").value = normalizeTherapyRecord(therapy).cycleIntervalMonths;
  $("#cycleCount").value = normalizeTherapyRecord(therapy).cycleCount;
  $("#therapyActive").checked = therapy?.active ?? true;
  $("#therapyImageInput").value = "";
  currentTherapyImageBlob = null;
  removeCurrentTherapyImage = false;
  updateTherapyImagePreview(therapy ? (therapyImageUrls.get(therapy.id) || "") : "");
  $$("input[name='days']").forEach((input) => {
    input.checked = therapy ? normalizedDays(therapy).includes(Number(input.value)) : true;
  });
  (therapy?.times || ["08:00"]).forEach(addTimeInput);
  updateCycleFields();
  $("#therapyDialog").showModal();
}

function closeTherapyDialog() {
  $("#therapyDialog").close();
}

async function openRepeatTherapyDialog(id) {
  const therapy = state.therapies.find((item) => item.id === id);
  if (!therapy) return;

  $("#therapyForm").reset();
  $("#timesList").innerHTML = "";
  $("#therapyId").value = "";
  $("#dialogTitle").textContent = `Ripeti: ${therapy.name}`;
  $("#therapyName").value = therapy.name || "";
  $("#therapyDose").value = therapy.dose || "";
  $("#stockUnits").value = stockEnabled(therapy) ? therapy.stockUnits : "";
  $("#doseUnits").value = therapy.doseUnits || 1;
  $("#lowStockThreshold").value = therapy.lowStockThreshold ?? 5;
  $("#therapyBarcode").value = therapy.barcode || "";
  $("#therapyNotes").value = therapy.notes || "";
  $("#scheduleType").value = normalizeTherapyRecord(therapy).scheduleType;
  $("#monthInterval").value = String(monthIntervalValue(therapy));
  $("#cycleDurationDays").value = normalizeTherapyRecord(therapy).cycleDurationDays;
  $("#cycleIntervalMonths").value = normalizeTherapyRecord(therapy).cycleIntervalMonths;
  $("#cycleCount").value = normalizeTherapyRecord(therapy).cycleCount;
  $("#therapyActive").checked = true;
  $("#therapyImageInput").value = "";
  currentTherapyImageBlob = null;
  removeCurrentTherapyImage = false;

  const today = localDateISO();
  $("#startDate").value = today;
  const duration = inclusiveDurationDays(therapy.startDate, therapy.endDate);
  $("#endDate").value = duration === null ? "" : addDaysToIso(today, duration);
  updateCycleFields();

  $$("input[name='days']").forEach((input) => {
    input.checked = (therapy.days || []).includes(Number(input.value));
  });
  (therapy.times?.length ? therapy.times : ["08:00"]).forEach(addTimeInput);

  if (therapy.hasImage) {
    try {
      const blob = await getTherapyImage(therapy.id);
      if (blob) {
        currentTherapyImageBlob = blob;
        updateTherapyImagePreview(URL.createObjectURL(blob));
      } else {
        updateTherapyImagePreview("");
      }
    } catch (error) {
      console.error("Immagine non copiata nella terapia ripetuta", error);
      updateTherapyImagePreview("");
    }
  } else {
    updateTherapyImagePreview("");
  }

  $("#therapyDialog").showModal();
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
  const selectedScheduleType = $("#scheduleType")?.value || "standard";
  if (selectedScheduleType !== "manual" && !days.length) return showToast("Seleziona almeno un giorno.");
  if (!times.length) return showToast("Inserisci almeno un orario.");
  if (selectedScheduleType !== "manual" && $("#endDate").value && $("#startDate").value > $("#endDate").value) return showToast("La data finale precede quella iniziale.");

  const therapy = {
    id: therapyId,
    name: $("#therapyName").value.trim(),
    dose: $("#therapyDose").value.trim(),
    barcode: $("#therapyBarcode").value.trim(),
    stockUnits: $("#stockUnits").value === "" ? "" : Math.max(0, Number($("#stockUnits").value) || 0),
    doseUnits: Math.max(0.1, Number($("#doseUnits").value) || 1),
    lowStockThreshold: Math.max(0, Number($("#lowStockThreshold").value) || 0),
    hasImage: existing?.hasImage || therapyImageUrls.has(therapyId),
    days,
    times,
    startDate: $("#startDate").value,
    endDate: $("#endDate").value,
    notes: $("#therapyNotes").value.trim(),
    scheduleType: selectedScheduleType === "manual" ? "manual" : selectedScheduleType === "cyclic" ? "cyclic" : "standard",
    cycleDurationDays: Math.max(1, Number.parseInt($("#cycleDurationDays")?.value || "14", 10) || 14),
    cycleIntervalMonths: Math.max(1, Number.parseInt($("#cycleIntervalMonths")?.value || "2", 10) || 2),
    cycleCount: Math.max(1, Number.parseInt($("#cycleCount")?.value || "3", 10) || 3),
    monthInterval: selectedScheduleType === "cyclic" || selectedScheduleType === "manual" ? 1 : Math.max(1, Number.parseInt($("#monthInterval").value || "1", 10) || 1),
    active: existing?.archived ? false : $("#therapyActive").checked,
    archived: existing?.archived === true,
    archivedAt: existing?.archivedAt || "",
    updatedAt: new Date().toISOString()
  };
  if (therapy.scheduleType === "cyclic") {
    therapy.endDate = cyclicFinalEndDate(therapy);
  }
  if (therapy.scheduleType === "manual") {
    therapy.days = [];
    therapy.startDate = "";
    therapy.endDate = "";
  }
  if (!therapy.name || !therapy.dose) return showToast("Compila nome e dose.");

  const duplicate = findDuplicateTherapy(therapy, oldId);
  if (duplicate && !oldId) {
    const duplicateMessage = `La terapia “${duplicate.name}” è già presente con gli stessi giorni e gli stessi orari in un periodo sovrapposto. Non serve crearne una seconda copia. Apri “Modifica” sulla terapia esistente oppure usa il Calendario per cambiare soltanto alcuni giorni.`;
    showToast("Terapia duplicata: salvataggio bloccato.");
    window.alert(duplicateMessage);
    return;
  }
  if (duplicate && oldId) {
    console.warn("Modifica consentita nonostante una vecchia terapia sovrapposta", duplicate.id);
  }

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
  if ($("#view-calendar")?.classList.contains("active")) selectedCalendarTherapyId = therapyId;
  closeTherapyDialog();
  showToast(oldId ? "Terapia aggiornata." : "Terapia aggiunta.");
}


function doseSyncPayload(therapyId, time, status, date = localDateISO(), extra = {}) {
  return { appKey: state.settings.appKey.trim(), therapyId, date, time, status, ...extra };
}

function readPendingDoseSync() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_DOSE_SYNC_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePendingDoseSync(queue) {
  localStorage.setItem(PENDING_DOSE_SYNC_KEY, JSON.stringify(queue));
}

function queueDoseStatusSync(therapyId, time, status, date = localDateISO(), extra = {}) {
  if (!state.settings.telegramEnabled) return;

  const payload = doseSyncPayload(therapyId, time, status, date, extra);
  if (!payload.appKey || payload.appKey.length < 8 || !state.settings.apiBase) return;

  const key = `${date}:${therapyId}:${time}`;
  const queue = readPendingDoseSync()
    .filter((item) => `${item.date}:${item.therapyId}:${item.time}` !== key);

  queue.push(payload);
  writePendingDoseSync(queue);

  flushDoseStatusSync().catch((error) => {
    console.warn("Sincronizzazione stato dose rimandata", error);
  });
}

async function flushDoseStatusSync() {
  if (!state.settings.telegramEnabled) return;

  const apiBase = normalizeApiBase(state.settings.apiBase);
  const appKey = state.settings.appKey.trim();
  if (!apiBase || appKey.length < 8) return;

  let queue = readPendingDoseSync();
  if (!queue.length) return;

  const remaining = [];

  for (const item of queue) {
    try {
      const response = await fetch(`${apiBase}/dose-status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...item,
          appKey
        })
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || `Errore ${response.status}`);
      }
    } catch (error) {
      console.warn("Stato dose non sincronizzato", item, error);
      remaining.push(item);
    }
  }

  writePendingDoseSync(remaining);
}

function updateLocalNotificationMemory(therapyId, time, completed, date = localDateISO()) {
  const key = `${date}:${therapyId}:${time}`;
  const notified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || "{}");

  if (completed) {
    notified[key] = new Date().toISOString();
  } else {
    delete notified[key];
  }

  localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified));
}

async function closeVisibleDoseNotification(therapyId, time, date = localDateISO()) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const prefix = `${date}:${therapyId}:${time}`;
    const notifications = await registration.getNotifications();
    notifications.filter((notification) => String(notification.tag || "").startsWith(prefix)).forEach((notification) => notification.close());
  } catch (error) { console.warn("Impossibile chiudere la notifica locale", error); }
}

function markDose(therapyId, time, status, date = localDateISO()) {
  const previous = state.logs.find((item) => item.therapyId === therapyId && item.date === date && item.time === time);
  const therapy = state.therapies.find((item) => item.id === therapyId);
  if (previous?.status !== "taken" && status === "taken" && therapy && stockEnabled(therapy)) {
    therapy.stockUnits = Math.max(0, Number(therapy.stockUnits) - Math.max(0.1, Number(therapy.doseUnits) || 1));
  } else if (previous?.status === "taken" && status !== "taken" && therapy && stockEnabled(therapy)) {
    therapy.stockUnits = Number(therapy.stockUnits) + Math.max(0.1, Number(therapy.doseUnits) || 1);
  }
  state.logs = state.logs.filter((item) => !(item.therapyId === therapyId && item.date === date && item.time === time));
  state.logs.push({ id: uid(), therapyId, therapyName: therapy?.name || "", date, time, status, timestamp: new Date().toISOString() });
  removeLocalSnooze(therapyId, date, time);
  saveState({ sync: false });
  updateLocalNotificationMemory(therapyId, time, true, date);
  closeVisibleDoseNotification(therapyId, time, date);
  queueDoseStatusSync(therapyId, time, status, date);
  showToast(status === "taken" ? "Assunzione registrata e scorta aggiornata." : "Dose segnata come saltata e promemoria disattivato.");
}

function resetDose(therapyId, time, date = localDateISO()) {
  const previous = state.logs.find((item) => item.therapyId === therapyId && item.date === date && item.time === time);
  const therapy = state.therapies.find((item) => item.id === therapyId);
  if (previous?.status === "taken" && therapy && stockEnabled(therapy)) {
    therapy.stockUnits = Number(therapy.stockUnits) + Math.max(0.1, Number(therapy.doseUnits) || 1);
  }
  state.logs = state.logs.filter((item) => !(item.therapyId === therapyId && item.date === date && item.time === time));
  removeLocalSnooze(therapyId, date, time);
  saveState({ sync: false });
  updateLocalNotificationMemory(therapyId, time, false, date);
  queueDoseStatusSync(therapyId, time, "reset", date);
  showToast("Registrazione annullata. Il promemoria può essere inviato di nuovo.");
}

function snoozeDose(therapyId, originalTime, minutes, originalDate = localDateISO()) {
  const base = new Date(`${originalDate}T${originalTime}:00`);
  const now = new Date();
  const anchor = base > now ? base : now;
  const target = new Date(anchor.getTime() + Math.max(1, Number(minutes) || 10) * 60000);
  const snoozeDate = localDateISO(target);
  const snoozeTime = `${String(target.getHours()).padStart(2,"0")}:${String(target.getMinutes()).padStart(2,"0")}`;
  removeLocalSnooze(therapyId, originalDate, originalTime);
  state.snoozes.push({ therapyId, originalDate, originalTime, snoozeDate, snoozeTime, createdAt: new Date().toISOString() });
  saveState({ sync: false });
  updateLocalNotificationMemory(therapyId, originalTime, true, originalDate);
  closeVisibleDoseNotification(therapyId, originalTime, originalDate);
  queueDoseStatusSync(therapyId, originalTime, "snoozed", originalDate, { snoozeDate, snoozeTime });
  showToast(`Promemoria posticipato alle ${snoozeTime}.`);
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
  const notified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || "{}");
  dosesForDate(now).forEach((dose) => {
    if (dose.log) return;
    const originalDate = doseOriginalDate(dose, now);
    const effectiveDate = doseDisplayDate(dose, now);
    if (effectiveDate !== localDateISO(now)) return;
    const effectiveTime = doseDisplayTime(dose);
    const key = `${originalDate}:${dose.therapy.id}:${dose.time}:at:${effectiveDate}:${effectiveTime}`;
    const delta = Math.round((doseMoment(dose, now) - now) / 60000);
    if (delta <= 0 && delta >= -2 && !notified[key]) {
      notified[key] = new Date().toISOString();
      showDeviceNotification(`È ora di ${dose.therapy.name}`, {
        body: `${dose.therapy.dose}${dose.snooze ? " · promemoria posticipato" : ""}${dose.therapy.notes ? ` · ${dose.therapy.notes}` : ""}`,
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
    scheduleOverrides: (state.scheduleOverrides || []).map((item) => ({
      therapyId: item.therapyId,
      date: item.date,
      mode: item.mode,
      times: Array.isArray(item.times) ? item.times : []
    })),
    therapies: state.therapies
      .filter((therapy) => !therapy.archived)
      .map(({ id, name, dose, barcode, days, times, startDate, endDate, notes, monthInterval, scheduleType, cycleDurationDays, cycleIntervalMonths, cycleCount, active }) => ({
        id, name, dose, barcode, days, times, startDate, endDate, notes,
        monthInterval: monthIntervalValue({ monthInterval }),
        scheduleType: scheduleType === "manual" ? "manual" : scheduleType === "cyclic" ? "cyclic" : "standard",
        cycleDurationDays: Math.max(1, Number.parseInt(cycleDurationDays || 14, 10) || 14),
        cycleIntervalMonths: Math.max(1, Number.parseInt(cycleIntervalMonths || 2, 10) || 2),
        cycleCount: Math.max(1, Number.parseInt(cycleCount || 3, 10) || 3),
        active
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

function setTelegramHealthStatus(text, type = "", details = "") {
  const status = $("#telegramHealthStatus");
  const info = $("#telegramHealthDetails");
  if (status) {
    status.textContent = text;
    status.className = `status-pill${type ? ` ${type}` : ""}`;
  }
  if (info && details) info.textContent = details;
}

function telegramConfigReady() {
  const apiBase = normalizeApiBase(state.settings.apiBase || "");
  const appKey = String(state.settings.appKey || "").trim();
  const chatId = String(state.settings.chatId || "").trim();
  return !!apiBase && appKey.length >= 8 && /^-?\d+$/.test(chatId);
}

async function fetchTelegramHealth() {
  const apiBase = normalizeApiBase(state.settings.apiBase || "");
  const response = await fetch(`${apiBase}/telegram-health?_=${Date.now()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appKey: String(state.settings.appKey || "").trim(),
      chatId: String(state.settings.chatId || "").trim()
    }),
    cache: "no-store"
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Errore ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function ensureTelegramProfile({ showMessage = false } = {}) {
  if (!state.settings.telegramEnabled || !telegramConfigReady()) return false;
  try {
    await syncCloud(false);
    await flushDoseStatusSync();
    if (showMessage) showToast("Profilo Telegram sincronizzato.");
    return true;
  } catch (error) {
    console.warn("Ripristino automatico profilo Telegram non riuscito", error);
    return false;
  }
}

async function checkAndRepairTelegram({ sendTest = false, showMessage = true } = {}) {
  state.settings = readSettingsForm();
  writeStateToLocalStorage();

  if (!state.settings.telegramEnabled) {
    setTelegramHealthStatus("Disattivato", "warning", "Attiva Promemoria Telegram per ricevere gli avvisi.");
    if (showMessage) showToast("Promemoria Telegram disattivato.");
    return false;
  }
  if (!telegramConfigReady()) {
    setTelegramHealthStatus("Configurazione incompleta", "error", "Apri Configurazione tecnica e controlla API, Chiave personale e Chat ID.");
    if (showMessage) showToast("Configurazione Telegram incompleta.");
    return false;
  }

  setTelegramHealthStatus("Controllo…", "syncing", "Verifica del Worker Cloudflare e del profilo Telegram in corso…");
  try {
    let health;
    try {
      health = await fetchTelegramHealth();
    } catch (error) {
      // Se il Worker non ha ancora l'endpoint v19, proviamo comunque a
      // risincronizzare il profilo e poi segnaliamo che va aggiornato.
      if (error?.status === 404) {
        await ensureTelegramProfile({ showMessage: false });
        throw new Error("Worker Cloudflare da aggiornare alla v19 per la diagnostica Telegram.");
      }
      if (error instanceof TypeError && /fetch/i.test(String(error.message || ""))) {
        throw new Error("Connessione al Worker bloccata dal browser (CORS/rete). Aggiorna il Worker alla v20 e riprova.");
      }
      throw error;
    }

    const localTherapies = state.therapies.filter((therapy) => !therapy.archived).length;
    const needsRepair = !health.profileExists || !health.profileEnabled || health.chatMatches === false || Number(health.profileTherapies || 0) !== localTherapies;
    if (needsRepair) {
      setTelegramHealthStatus("Riparazione…", "syncing", "Il profilo Cloudflare non era allineato. Lo sto ricreando automaticamente…");
      await syncCloud(false);
      health = await fetchTelegramHealth();
    }

    if (!health.telegramConfigured) {
      throw new Error("TELEGRAM_BOT_TOKEN non configurato nel Worker Cloudflare.");
    }
    if (!health.profileExists || !health.profileEnabled) {
      throw new Error("Profilo Telegram non attivo su Cloudflare.");
    }
    if (health.chatMatches === false) {
      throw new Error("Il Chat ID salvato nell'app non coincide con quello del profilo Cloudflare.");
    }

    const cronAge = Number(health.cronAgeMinutes);
    if (!health.lastCronAt || !Number.isFinite(cronAge) || cronAge > 20) {
      setTelegramHealthStatus("Cron da controllare", "warning", health.lastCronAt
        ? `Ultimo controllo automatico ${Math.round(cronAge)} minuti fa. Il Cron è previsto ogni 15 minuti.`
        : "Il Worker non registra ancora esecuzioni del Cron Trigger. Verifica il Cron su Cloudflare.");
      if (showMessage) showToast("Telegram collegato, ma il Cron Cloudflare va controllato.");
      return false;
    }

    setTelegramHealthStatus("Funzionante", "success", `Profilo attivo · ${health.profileTherapies} terapie · ultimo Cron ${Math.max(0, Math.round(cronAge))} min fa.`);
    if (sendTest) await testTelegram();
    else if (showMessage) showToast("Telegram e promemoria Cloudflare risultano attivi.");
    return true;
  } catch (error) {
    console.error("Diagnostica Telegram", error);
    setTelegramHealthStatus("Errore", "error", error?.message || "Controllo Telegram non riuscito.");
    if (showMessage) showToast(error?.message || "Controllo Telegram non riuscito.");
    return false;
  }
}

async function testTelegram() {
  try {
    state.settings = readSettingsForm();
    writeStateToLocalStorage();
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
    timezone: $("#timezone").value.trim() || "Europe/Rome",
    cloudBackupLast: state.settings.cloudBackupLast || "",
    cloudBackupBytes: Number(state.settings.cloudBackupBytes) || 0,
    recoveryCode: state.settings.recoveryCode || "",
    backupId: state.settings.backupId || "",
    autoBackupEnabled: $("#autoBackupEnabled") ? $("#autoBackupEnabled").checked : state.settings.autoBackupEnabled !== false,
    telegramRecoverySentFor: state.settings.telegramRecoverySentFor || "",
    multiDeviceSyncEnabled: $("#multiDeviceSyncEnabled") ? $("#multiDeviceSyncEnabled").checked : state.settings.multiDeviceSyncEnabled !== false,
    lastDeviceSyncAt: state.settings.lastDeviceSyncAt || ""
  };
}

function saveCloudSettings() {
  state.settings = readSettingsForm();
  writeStateToLocalStorage();

  syncCloud(true)
    .then(async () => {
      await flushDoseStatusSync();
      if (state.settings.telegramEnabled) checkAndRepairTelegram({ sendTest: false, showMessage: false }).catch(console.warn);
    })
    .catch((error) => {
      $("#cloudStatus").textContent = `Errore: ${error.message}`;
      showToast("Sincronizzazione non riuscita.");
    });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value.toLocaleString("it-IT", { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
}

function setCloudBackupStatus(message, type = "") {
  const element = $("#cloudBackupStatus");
  if (!element) return;
  element.textContent = message;
  element.className = `backup-status${type ? ` ${type}` : ""}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function buildCompleteBackup() {
  const images = {};
  for (const therapy of state.therapies) {
    if (!therapy.hasImage) continue;
    try {
      const blob = await getTherapyImage(therapy.id);
      if (blob) images[therapy.id] = await blobToDataUrl(blob);
    } catch (error) {
      console.error(`Immagine non inclusa nel backup per ${therapy.id}`, error);
    }
  }

  return {
    app: "Terapie in Orario",
    version: 5,
    exportedAt: new Date().toISOString(),
    data: serializableState(),
    images
  };
}

async function restoreBackupPackage(packageData, { preserveConnection = false } = {}) {
  const imported = packageData?.data || packageData;
  if (!Array.isArray(imported?.therapies) || !Array.isArray(imported?.logs)) {
    throw new Error("Formato di backup non valido");
  }

  const currentConnection = {};
  if (preserveConnection) {
    const apiBase = normalizeApiBase($("#apiBase")?.value || state.settings.apiBase || "");
    const appKey = $("#appKey")?.value?.trim() || state.settings.appKey || "";
    const chatId = $("#chatId")?.value?.trim() || state.settings.chatId || "";
    const timezone = $("#timezone")?.value?.trim() || state.settings.timezone || "";

    // Sul nuovo dispositivo API e chiave arrivano dal codice di ripristino.
    // Il Chat ID viene sovrascritto soltanto se sul dispositivo è già presente:
    // in caso contrario resta quello incluso nel backup originale.
    if (apiBase) currentConnection.apiBase = apiBase;
    if (appKey) currentConnection.appKey = appKey;
    if (chatId) currentConnection.chatId = chatId;
    if (timezone) currentConnection.timezone = timezone;
  }

  for (const url of therapyImageUrls.values()) URL.revokeObjectURL(url);
  therapyImageUrls.clear();
  await clearTherapyImages();

  const restoredTherapies = imported.therapies.map((therapy) => ({
    ...normalizeTherapyRecord(therapy),
    hasImage: false
  }));

  const images = packageData?.images && typeof packageData.images === "object"
    ? packageData.images
    : {};

  for (const therapy of restoredTherapies) {
    const dataUrl = images[therapy.id];
    if (!dataUrl) continue;
    try {
      const blob = dataUrlToBlob(dataUrl);
      await putTherapyImage(therapy.id, blob);
      replaceTherapyImageUrl(therapy.id, blob);
      therapy.hasImage = true;
    } catch (error) {
      console.error(`Immagine non ripristinata per ${therapy.id}`, error);
    }
  }

  state = {
    ...structuredClone(defaultState),
    ...imported,
    therapies: restoredTherapies,
    logs: imported.logs,
    settings: {
      ...defaultState.settings,
      ...(imported.settings || {}),
      ...currentConnection
    }
  };

  if (!saveState({ sync: false })) throw new Error("Salvataggio locale non riuscito");
  await loadTherapyImages();
  renderAll();
  loadRecoveryCodeFromUrl();
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function compressBytes(bytes) {
  if (!("CompressionStream" in window)) return { bytes, compressed: false };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), compressed: true };
}

async function decompressBytes(bytes, compressed) {
  if (!compressed) return bytes;
  if (!("DecompressionStream" in window)) {
    throw new Error("Questo browser non può decomprimere il backup. Aggiorna il browser.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deriveBackupKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptBackupPackage(packageData, password) {
  if (!crypto?.subtle) throw new Error("Cifratura non supportata da questo browser");
  const iterations = 250000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(packageData));
  const compressedResult = await compressBytes(encoded);
  const key = await deriveBackupKey(password, salt, iterations);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    compressedResult.bytes
  );

  return {
    format: "terapie-encrypted-backup",
    version: 1,
    algorithm: "AES-GCM-256",
    kdf: "PBKDF2-SHA-256",
    iterations,
    compressed: compressedResult.compressed,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted))
  };
}

async function decryptBackupEnvelope(envelope, password) {
  if (!envelope || envelope.format !== "terapie-encrypted-backup") {
    throw new Error("Backup cloud non riconosciuto");
  }
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    const key = await deriveBackupKey(password, salt, Number(envelope.iterations) || 250000);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const decompressed = await decompressBytes(new Uint8Array(decrypted), envelope.compressed === true);
    return JSON.parse(new TextDecoder().decode(decompressed));
  } catch (error) {
    console.error(error);
    throw new Error("Password errata oppure backup danneggiato");
  }
}


function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return base64ToBytes(padded);
}

function randomHex(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function randomRecoverySecret() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function createRecoveryCode({ apiBase, appKey, password }) {
  // Compatibilità con i vecchi backup TIO1.
  const payload = {
    v: 1,
    api: normalizeApiBase(apiBase),
    key: String(appKey || "").trim(),
    secret: String(password || "")
  };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  return `TIO1.${bytesToBase64Url(encoded)}`;
}

function createRecoveryCodeV2({ apiBase, backupId, password }) {
  const payload = {
    v: 2,
    api: normalizeApiBase(apiBase),
    backup: String(backupId || "").trim(),
    secret: String(password || "")
  };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  return `TIO2.${bytesToBase64Url(encoded)}`;
}

function normalizeRecoveryInput(value) {
  let clean = String(value || "").trim();
  if (!clean) throw new Error("Inserisci il codice di ripristino");

  try {
    if (/^https?:\/\//i.test(clean)) {
      const url = new URL(clean);
      const fromUrl = url.searchParams.get("restore");
      if (fromUrl) clean = fromUrl;
    }
  } catch {
    // Continuiamo a trattarlo come codice.
  }

  clean = clean.replace(/\s+/g, "");

  if (!clean.startsWith("TIO1.") && !clean.startsWith("TIO2.")) {
    try {
      const candidate = JSON.parse(new TextDecoder().decode(base64UrlToBytes(clean)));
      if (candidate?.v === 2 && candidate?.api && candidate?.backup && candidate?.secret) {
        clean = `TIO2.${clean}`;
      } else if (candidate?.v === 1 && candidate?.api && candidate?.key && candidate?.secret) {
        clean = `TIO1.${clean}`;
      }
    } catch {
      // Errore esplicito sotto.
    }
  }

  if (!clean.startsWith("TIO1.") && !clean.startsWith("TIO2.")) {
    throw new Error("Codice di ripristino non riconosciuto");
  }
  return clean;
}

function decodeRecoveryCode(code) {
  const clean = normalizeRecoveryInput(code);
  try {
    const isV2 = clean.startsWith("TIO2.");
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(clean.slice(5))));
    const apiBase = normalizeApiBase(payload?.api || "");
    const password = String(payload?.secret || "");

    if (isV2) {
      const backupId = String(payload?.backup || "").trim();
      if (payload?.v !== 2 || !apiBase || backupId.length < 16 || password.length < 8) {
        throw new Error("Dati incompleti");
      }
      return { version: 2, apiBase, backupId, password, code: clean };
    }

    const appKey = String(payload?.key || "").trim();
    if (payload?.v !== 1 || !apiBase || appKey.length < 8 || password.length < 8) {
      throw new Error("Dati incompleti");
    }
    return { version: 1, apiBase, appKey, password, code: clean };
  } catch (error) {
    console.error(error);
    throw new Error("Codice di ripristino non valido o danneggiato");
  }
}

function setRecoveryCode(code) {
  const clean = String(code || "").trim();
  state.settings.recoveryCode = clean;
  const input = $("#recoveryCodeInput");
  if (input) input.value = clean;
  writeStateToLocalStorage();
}

function getEasyBackupCredentials() {
  state.settings = readSettingsForm();
  const apiBase = normalizeApiBase(state.settings.apiBase);
  if (!apiBase) throw new Error("Inserisci prima l’indirizzo API Cloudflare nelle impostazioni");

  let backupId = String(state.settings.backupId || "").trim();
  let password = "";
  const currentCode = $("#recoveryCodeInput")?.value.trim() || state.settings.recoveryCode || "";

  if (currentCode) {
    try {
      const decoded = decodeRecoveryCode(currentCode);
      if (decoded.version === 2) {
        backupId = decoded.backupId;
        password = decoded.password;
      }
    } catch {
      // Se il codice non è valido, ne viene creato uno nuovo.
    }
  }

  if (backupId.length < 16) backupId = randomHex(20);
  if (password.length < 8) password = randomRecoverySecret();

  const code = createRecoveryCodeV2({ apiBase, backupId, password });
  state.settings.apiBase = apiBase;
  state.settings.backupId = backupId;
  state.settings.recoveryCode = code;
  $("#apiBase").value = apiBase;
  $("#cloudBackupPassword").value = password;
  setRecoveryCode(code);
  return { version: 2, apiBase, backupId, password, code };
}

async function performOnlineBackup(credentials) {
  const { apiBase, password } = credentials;
  setCloudBackupStatus("Preparazione e cifratura del backup…", "working");
  const packageData = await buildCompleteBackup();
  const envelope = await encryptBackupPackage(packageData, password);

  const isV2 = credentials.version === 2 || credentials.backupId;
  const endpoint = isV2 ? `${apiBase}/backup2` : `${apiBase}/backup`;
  const body = isV2
    ? { backupId: credentials.backupId, envelope }
    : { appKey: credentials.appKey, envelope };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Errore ${response.status}`);

  state.settings.cloudBackupLast = result.updatedAt || new Date().toISOString();
  state.settings.cloudBackupBytes = Number(result.bytes) || 0;
  if (isV2) state.settings.backupId = credentials.backupId;
  writeStateToLocalStorage();

  setCloudBackupStatus("Backup salvato. Verifica disponibilità…", "working");
  await fetchBackupWithRetry(credentials, 4);

  setCloudBackupStatus(
    `Backup online completato e verificato: ${new Date(state.settings.cloudBackupLast).toLocaleString("it-IT")} · ${formatBytes(state.settings.cloudBackupBytes)}`,
    "success"
  );
  return result;
}

async function checkBackupWorker(apiBase, requireV2 = false) {
  let response;
  try {
    response = await fetch(`${apiBase}/check?backup=${Date.now()}`, { cache: "no-store" });
  } catch {
    throw new Error("Impossibile raggiungere Cloudflare. Controlla la connessione Internet.");
  }
  const info = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(info.error || `Worker non raggiungibile (${response.status})`);
  if (info.kvConfigured === false) throw new Error("Archivio Cloudflare KV non collegato al Worker.");
  if (info.backupSupported === false) throw new Error("Il Worker Cloudflare non è aggiornato alla versione con Backup.");
  if (requireV2 && info.backupV2Supported !== true) {
    throw new Error("Il Worker Cloudflare deve essere aggiornato alla nuova versione Backup V2.");
  }
  return info;
}

async function fetchBackupWithRetry(credentials, attempts = 6) {
  const isV2 = credentials.version === 2 || credentials.backupId;
  const apiBase = normalizeApiBase(credentials.apiBase);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const url = isV2
        ? `${apiBase}/backup2?backupId=${encodeURIComponent(credentials.backupId)}&_=${Date.now()}`
        : `${apiBase}/backup?appKey=${encodeURIComponent(credentials.appKey)}&_=${Date.now()}`;
      const response = await fetch(url, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (response.ok) return result;
      const message = result.error || `Errore ${response.status}`;
      if (response.status !== 404 && response.status < 500) throw new Error(message);
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      setCloudBackupStatus(`Backup non ancora disponibile, nuovo tentativo ${attempt + 1}/${attempts}…`, "working");
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
  }
  throw lastError || new Error("Backup non trovato su Cloudflare");
}

async function performOnlineRestore(credentials) {
  const { apiBase, password } = credentials;
  const isV2 = credentials.version === 2 || credentials.backupId;
  setCloudBackupStatus("Verifica del Worker Cloudflare…", "working");
  await checkBackupWorker(apiBase, isV2);
  setCloudBackupStatus("Download e decifratura del backup…", "working");
  const result = await fetchBackupWithRetry(credentials);
  const packageData = await decryptBackupEnvelope(result.envelope, password);
  autoBackupSuspended = true;
  try {
    await restoreBackupPackage(packageData, { preserveConnection: true });
  } finally {
    autoBackupSuspended = false;
  }
  state.settings.cloudBackupLast = result.updatedAt || packageData.exportedAt || new Date().toISOString();
  state.settings.cloudBackupBytes = Number(result.bytes) || 0;
  if (isV2) state.settings.backupId = credentials.backupId;
  writeStateToLocalStorage();
  setCloudBackupStatus(
    `Backup ripristinato: ${new Date(state.settings.cloudBackupLast).toLocaleString("it-IT")} · ${formatBytes(state.settings.cloudBackupBytes)}`,
    "success"
  );
  return result;
}



function setDeviceSyncStatus(text, type = "") {
  const el = $("#multiDeviceSyncStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `status-pill${type ? ` ${type}` : ""}`;
}

async function fetchBackupMetadata(credentials) {
  if (credentials.version !== 2) return null;
  const response = await fetch(`${credentials.apiBase}/backup2?backupId=${encodeURIComponent(credentials.backupId)}&meta=1&_=${Date.now()}`, { cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Errore sincronizzazione ${response.status}`);
  return result;
}

async function maybeSyncFromCloud(force = false) {
  if (deviceSyncInFlight || state.settings.multiDeviceSyncEnabled === false || autoBackupSuspended) return false;
  const code = state.settings.recoveryCode || "";
  if (!code) return false;
  let credentials;
  try { credentials = decodeRecoveryCode(code); } catch { return false; }
  if (credentials.version !== 2) return false;
  if (!force && (autoBackupDirty || autoBackupInFlight)) return false;
  deviceSyncInFlight = true;
  setDeviceSyncStatus("Controllo…", "syncing");
  try {
    const meta = await fetchBackupMetadata(credentials);
    const remoteTime = new Date(meta.updatedAt || 0).getTime();
    const localTime = new Date(state.settings.cloudBackupLast || 0).getTime();
    if (force || remoteTime > localTime + 1000) {
      autoBackupSuspended = true;
      await performOnlineRestore(credentials);
      autoBackupSuspended = false;
      state.settings.lastDeviceSyncAt = new Date().toISOString();
      writeStateToLocalStorage();
      renderAll();
      setDeviceSyncStatus("Sincronizzata", "success");
      if (force) showToast("Dati aggiornati dal cloud.");
      return true;
    }
    state.settings.lastDeviceSyncAt = new Date().toISOString();
    writeStateToLocalStorage();
    setDeviceSyncStatus("Già aggiornata", "success");
    if (force) showToast("Questo dispositivo è già aggiornato.");
    return false;
  } catch (error) {
    autoBackupSuspended = false;
    setDeviceSyncStatus("Errore", "error");
    if (force) showToast(error?.message || "Sincronizzazione non riuscita.");
    return false;
  } finally { deviceSyncInFlight = false; }
}

function canAutoBackup() {
  if (autoBackupSuspended || state.settings.autoBackupEnabled === false) return false;
  const apiBase = normalizeApiBase(state.settings.apiBase || "");
  if (!apiBase) return false;
  if (!state.therapies.length && !state.logs.length) return false;
  return true;
}

function scheduleAutoBackup(delay = 3500) {
  if (!canAutoBackup()) return;
  autoBackupDirty = true;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(runAutoBackup, Math.max(500, delay));
}

async function runAutoBackup() {
  if (!canAutoBackup()) return;
  if (autoBackupInFlight) {
    autoBackupDirty = true;
    return;
  }

  autoBackupInFlight = true;
  autoBackupDirty = false;
  try {
    const credentials = getEasyBackupCredentials();
    await checkBackupWorker(credentials.apiBase, true);
    await performOnlineBackup(credentials);
    setRecoveryCode(credentials.code);
    await sendRecoveryLinkToTelegram(credentials, { force: false }).catch((error) => {
      console.warn("Link di recupero Telegram non inviato", error);
    });
  } catch (error) {
    console.warn("Backup automatico non riuscito", error);
    setCloudBackupStatus(`Backup automatico in attesa: ${error?.message || "errore"}`, "error");
  } finally {
    autoBackupInFlight = false;
    if (autoBackupDirty) scheduleAutoBackup(2500);
  }
}

async function sendRecoveryLinkToTelegram(credentials, { force = false } = {}) {
  const apiBase = normalizeApiBase(credentials?.apiBase || state.settings.apiBase || "");
  const recoveryCode = credentials?.code || state.settings.recoveryCode || "";
  const chatId = String($("#chatId")?.value || state.settings.chatId || "").trim();

  if (!apiBase) throw new Error("Indirizzo Cloudflare mancante");
  if (!recoveryCode) throw new Error("Prima crea almeno un backup");
  if (!/^-?\d+$/.test(chatId)) throw new Error("Chat ID Telegram non configurato");

  if (!force && state.settings.telegramRecoverySentFor === recoveryCode) {
    return { ok: true, skipped: true };
  }

  const response = await fetch(`${apiBase}/recovery-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatId,
      recoveryCode,
      updatedAt: state.settings.cloudBackupLast || new Date().toISOString()
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Errore Telegram ${response.status}`);

  state.settings.telegramRecoverySentFor = recoveryCode;
  writeStateToLocalStorage();
  return result;
}

async function sendRecoveryLinkNow() {
  try {
    const credentials = getEasyBackupCredentials();
    await sendRecoveryLinkToTelegram(credentials, { force: true });
    showToast("Link di recupero inviato su Telegram.");
    setCloudBackupStatus("Link di recupero inviato su Telegram. Conservalo nella chat del bot.", "success");
  } catch (error) {
    const message = error?.message || "Invio non riuscito";
    setCloudBackupStatus(`Errore Telegram: ${message}`, "error");
    showToast(message);
  }
}

async function easyBackup() {
  try {
    const credentials = getEasyBackupCredentials();
    await checkBackupWorker(credentials.apiBase, true);
    await performOnlineBackup(credentials);
    setRecoveryCode(credentials.code);
    try {
      await sendRecoveryLinkToTelegram(credentials, { force: true });
      showToast("Backup completato. Link di recupero inviato su Telegram.");
    } catch (telegramError) {
      console.warn(telegramError);
      showToast("Backup completato. Il link Telegram non è stato inviato.");
    }
  } catch (error) {
    const message = error?.message || "Errore sconosciuto";
    setCloudBackupStatus(`Errore: ${message}`, "error");
    showToast(message.length > 70 ? "Backup non riuscito: controlla il messaggio in rosso." : message);
  }
}

async function verifyRecoveryBackup() {
  try {
    const credentials = decodeRecoveryCode($("#recoveryCodeInput")?.value || "");
    setCloudBackupStatus("Verifica del codice e del backup…", "working");
    await checkBackupWorker(credentials.apiBase, credentials.version === 2);
    const result = await fetchBackupWithRetry(credentials, 2);
    await decryptBackupEnvelope(result.envelope, credentials.password);
    setCloudBackupStatus(
      `Backup verificato: disponibile e decifrabile · ${formatBytes(Number(result.bytes) || 0)}`,
      "success"
    );
    showToast("Backup verificato correttamente.");
    return true;
  } catch (error) {
    const message = error?.message || "Errore sconosciuto";
    setCloudBackupStatus(`Errore verifica: ${message}`, "error");
    showToast(message.length > 70 ? "Verifica non riuscita: controlla il messaggio in rosso." : message);
    return false;
  }
}

async function restoreWithRecoveryCode() {
  const previousSettings = structuredClone(state.settings);
  try {
    const credentials = decodeRecoveryCode($("#recoveryCodeInput")?.value || "");
    if (!confirm("Il ripristino sostituirà terapie, archivio, storico e fotografie presenti su questo dispositivo. Continuare?")) return;

    $("#apiBase").value = credentials.apiBase;
    $("#cloudBackupPassword").value = credentials.password;
    state.settings.apiBase = credentials.apiBase;
    state.settings.recoveryCode = credentials.code;

    if (credentials.version === 1) {
      $("#appKey").value = credentials.appKey;
      state.settings.appKey = credentials.appKey;
    } else {
      state.settings.backupId = credentials.backupId;
    }

    await performOnlineRestore(credentials);
    setRecoveryCode(credentials.code);
    if (state.settings.telegramEnabled) {
      await ensureTelegramProfile({ showMessage: false });
      checkAndRepairTelegram({ sendTest: false, showMessage: false }).catch(console.warn);
    }
    showToast("Backup ripristinato correttamente.");
  } catch (error) {
    console.error("Ripristino backup fallito", error);
    state.settings = { ...previousSettings };
    renderSettings();
    const message = error?.message || "Errore sconosciuto";
    setCloudBackupStatus(`Errore: ${message}`, "error");
    const status = $("#cloudBackupStatus");
    status?.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast(message.length > 70 ? "Ripristino non riuscito: controlla il messaggio in rosso." : message);
  }
}

async function copyRecoveryCode() {
  const code = $("#recoveryCodeInput")?.value.trim() || state.settings.recoveryCode || "";
  if (!code) return showToast("Prima crea un backup e il relativo codice.");
  try {
    await navigator.clipboard.writeText(code);
    showToast("Codice copiato.");
  } catch {
    const input = $("#recoveryCodeInput");
    input.focus();
    input.select();
    document.execCommand("copy");
    showToast("Codice copiato.");
  }
}

function buildRecoveryLink(code) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("restore", code);
  return url.toString();
}

async function shareRecoveryCode() {
  const code = $("#recoveryCodeInput")?.value.trim() || state.settings.recoveryCode || "";
  if (!code) return showToast("Prima crea un backup e il relativo codice.");
  const url = buildRecoveryLink(code);
  try {
    if (navigator.share) {
      await navigator.share({
        title: "Ripristino Terapie in Orario",
        text: "Apri questo collegamento sul nuovo telefono per recuperare il backup. Conservalo in modo riservato.",
        url
      });
    } else {
      await navigator.clipboard.writeText(url);
      showToast("Collegamento di ripristino copiato.");
    }
  } catch (error) {
    if (error?.name !== "AbortError") showToast("Condivisione non riuscita.");
  }
}

function loadRecoveryCodeFromUrl() {
  const url = new URL(location.href);
  const code = url.searchParams.get("restore");
  if (!code) return false;
  try {
    decodeRecoveryCode(code);
    setRecoveryCode(code);
    showView("settings");
    setCloudBackupStatus("Backup trovato dal link Telegram. Conferma per ripristinarlo.", "working");
    autoBackupSuspended = true;
    setTimeout(async () => {
      try {
        await restoreWithRecoveryCode();
      } finally {
        autoBackupSuspended = false;
      }
    }, 250);
    return true;
  } catch (error) {
    autoBackupSuspended = false;
    setCloudBackupStatus(`Errore: ${error.message}`, "error");
    return false;
  } finally {
    url.searchParams.delete("restore");
    history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
}

function readBackupConnection({ requirePassword = true } = {}) {
  state.settings = readSettingsForm();
  writeStateToLocalStorage();
  const apiBase = normalizeApiBase(state.settings.apiBase);
  const appKey = state.settings.appKey.trim();
  const password = $("#cloudBackupPassword").value;
  if (!apiBase) throw new Error("Inserisci l’indirizzo API Cloudflare");
  if (appKey.length < 8) throw new Error("Inserisci o genera una chiave personale valida");
  if (requirePassword && password.length < 8) throw new Error("La password del backup deve avere almeno 8 caratteri");
  return { apiBase, appKey, password };
}

async function saveOnlineBackup() {
  try {
    const credentials = readBackupConnection();
    await performOnlineBackup(credentials);
    const code = createRecoveryCode(credentials);
    setRecoveryCode(code);
    showToast("Backup esterno completato.");
  } catch (error) {
    setCloudBackupStatus(`Errore: ${error.message}`, "error");
    showToast("Backup online non riuscito.");
  }
}

async function restoreOnlineBackup() {
  try {
    const credentials = readBackupConnection();
    if (!confirm("Il ripristino sostituirà terapie, archivio, storico e fotografie presenti su questo dispositivo. Continuare?")) return;
    await performOnlineRestore(credentials);
    const code = createRecoveryCode(credentials);
    setRecoveryCode(code);
    showToast("Backup cloud ripristinato.");
  } catch (error) {
    setCloudBackupStatus(`Errore: ${error.message}`, "error");
    showToast("Ripristino non riuscito.");
  }
}

async function deleteOnlineBackup() {
  try {
    const { apiBase, appKey } = readBackupConnection({ requirePassword: false });
    if (!confirm("Eliminare definitivamente il backup esterno conservato su Cloudflare?")) return;
    setCloudBackupStatus("Eliminazione del backup online…", "working");
    const response = await fetch(`${apiBase}/backup?appKey=${encodeURIComponent(appKey)}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Errore ${response.status}`);
    state.settings.cloudBackupLast = "";
    state.settings.cloudBackupBytes = 0;
    writeStateToLocalStorage();
    setCloudBackupStatus("Backup cloud eliminato.", "success");
    showToast("Backup esterno eliminato.");
  } catch (error) {
    setCloudBackupStatus(`Errore: ${error.message}`, "error");
    showToast("Eliminazione non riuscita.");
  }
}

async function exportBackup() {
  try {
    const packageData = await buildCompleteBackup();
    const blob = new Blob([JSON.stringify(packageData, null, 2)], { type: "application/json" });
    downloadBlob(blob, `terapie-backup-completo-${localDateISO()}.json`);
    showToast("Backup JSON completo esportato.");
  } catch (error) {
    console.error(error);
    showToast("Esportazione JSON non riuscita.");
  }
}

async function importBackup(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!confirm("Importare questo backup e sostituire i dati presenti sul dispositivo?")) return;
    await restoreBackupPackage(parsed, { preserveConnection: true });
    showToast("Backup JSON ripristinato.");
  } catch (error) {
    console.error(error);
    showToast("Il file selezionato non è un backup valido.");
  }
}

function csvCell(value) {
  const normalized = String(value ?? "").replace(/\r?\n/g, " ");
  return `"${normalized.replace(/"/g, '""')}"`;
}

function exportCsv() {
  const dayNames = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
  const rows = [[
    "Tipo record", "ID terapia", "Nome", "Dose", "Codice a barre", "Stato terapia",
    "Archiviata", "Giorni", "Orari", "Periodicità mesi", "Data inizio", "Data fine", "Note",
    "Data evento", "Ora evento", "Esito"
  ]];

  for (const therapy of state.therapies) {
    rows.push([
      "TERAPIA", therapy.id, therapy.name, therapy.dose, therapy.barcode || "",
      therapy.active ? "Attiva" : "Sospesa", therapy.archived ? "Sì" : "No",
      (therapy.days || []).map((day) => dayNames[day]).join(", "),
      (therapy.times || []).join(", "), monthIntervalValue(therapy) === 2 ? "Mesi alterni" : "Ogni mese",
      therapy.startDate || "", therapy.endDate || "", therapy.notes || "", "", "", ""
    ]);
  }

  for (const log of state.logs) {
    const therapy = state.therapies.find((item) => item.id === log.therapyId);
    rows.push([
      "ASSUNZIONE", log.therapyId, therapy?.name || log.therapyName || "", therapy?.dose || "",
      therapy?.barcode || "", "", therapy?.archived ? "Sì" : "No", "", "", "", "", "", "",
      log.date || "", log.time || "", log.status === "taken" ? "Presa" : "Saltata"
    ]);
  }

  const content = "\ufeff" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
  downloadBlob(new Blob([content], { type: "text/csv;charset=utf-8" }), `terapie-e-storico-${localDateISO()}.csv`);
  showToast("Archivio CSV esportato.");
}

function printPdfReport() {
  const popup = window.open("", "_blank");
  if (!popup) return showToast("Consenti l’apertura delle finestre per creare il PDF.");
  const dayNames = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
  const therapiesHtml = state.therapies.map((therapy) => `
    <section class="therapy">
      <h2>${escapeHTML(therapy.name)}</h2>
      <p><strong>Dose:</strong> ${escapeHTML(therapy.dose)}</p>
      <p><strong>Stato:</strong> ${therapy.archived ? "Archiviata" : therapy.active ? "Attiva" : "Sospesa"}</p>
      <p><strong>Giorni:</strong> ${(therapy.days || []).map((day) => dayNames[day]).join(", ")}</p>
      <p><strong>Orari:</strong> ${(therapy.times || []).map(escapeHTML).join(", ")}</p>
      <p><strong>Periodicità:</strong> ${monthIntervalValue(therapy) === 2 ? "Mesi alterni" : "Ogni mese"}</p>
      ${therapy.barcode ? `<p><strong>Codice:</strong> ${escapeHTML(therapy.barcode)}</p>` : ""}
      ${therapy.notes ? `<p><strong>Note:</strong> ${escapeHTML(therapy.notes)}</p>` : ""}
    </section>
  `).join("");
  const logsHtml = [...state.logs].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((log) => `
    <tr><td>${escapeHTML(log.date)}</td><td>${escapeHTML(log.time)}</td><td>${escapeHTML(log.therapyName || "")}</td><td>${log.status === "taken" ? "Presa" : "Saltata"}</td></tr>
  `).join("");

  popup.document.write(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Report terapie</title>
    <style>
      body{font-family:Arial,sans-serif;color:#17332e;margin:28px;line-height:1.4}h1{margin-bottom:4px}h2{font-size:18px;margin:0 0 8px}.muted{color:#657b76}.therapy{border:1px solid #ccdcd7;border-radius:12px;padding:14px;margin:12px 0;break-inside:avoid}.therapy p{margin:4px 0}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:12px}th,td{border:1px solid #ccdcd7;padding:7px;text-align:left}th{background:#eef4f2}@media print{button{display:none}body{margin:12mm}}
    </style></head><body>
    <button onclick="window.print()">Stampa / Salva PDF</button>
    <h1>Terapie in Orario</h1><p class="muted">Report generato il ${new Date().toLocaleString("it-IT")}</p>
    <h2>Terapie</h2>${therapiesHtml || "<p>Nessuna terapia.</p>"}
    <h2>Storico assunzioni</h2><table><thead><tr><th>Data</th><th>Ora</th><th>Terapia</th><th>Esito</th></tr></thead><tbody>${logsHtml || '<tr><td colspan="4">Nessuna registrazione.</td></tr>'}</tbody></table>
    </body></html>`);
  popup.document.close();
  popup.focus();
  setTimeout(() => popup.print(), 500);
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
  ["#scheduleType", "#startDate", "#cycleDurationDays", "#cycleIntervalMonths", "#cycleCount"].forEach((selector) => {
    $(selector)?.addEventListener("change", updateCycleFields);
    $(selector)?.addEventListener("input", updateCycleFields);
  });
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
  $("#archiveSearch").addEventListener("input", renderArchive);
  $("#clearArchiveSearch").addEventListener("click", () => {
    $("#archiveSearch").value = "";
    renderArchive();
  });
  $("#calendarPrevBtn")?.addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1); renderCalendar(); });
  $("#calendarNextBtn")?.addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1); renderCalendar(); });
  $("#calendarTodayBtn")?.addEventListener("click", () => { const now = new Date(); calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1); renderCalendar(); });
  $("#calendarTherapySelect")?.addEventListener("change", (event) => { selectedCalendarTherapyId = event.target.value; renderCalendar(); });
  $("#calendarEditTherapyBtn")?.addEventListener("click", () => { const therapy = selectedCalendarTherapy(); if (therapy) openTherapyDialog(therapy.id); });
  $("#calendarDeleteCopyBtn")?.addEventListener("click", deleteSelectedCalendarCopy);
  $("#calendarCleanCopiesBtn")?.addEventListener("click", cleanExactDuplicateCopies);
  $("#calendarAddTherapyBtn")?.addEventListener("click", () => openTherapyDialog());
  $("#calendarManualModeBtn")?.addEventListener("click", switchSelectedTherapyCalendarMode);
  $("#calendarGrid")?.addEventListener("touchstart", (event) => { calendarSwipeStartX = event.touches?.[0]?.clientX ?? null; }, { passive: true });
  $("#calendarGrid")?.addEventListener("touchend", (event) => {
    if (calendarSwipeStartX == null) return;
    const endX = event.changedTouches?.[0]?.clientX ?? calendarSwipeStartX;
    const delta = endX - calendarSwipeStartX;
    calendarSwipeStartX = null;
    if (Math.abs(delta) < 70) return;
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + (delta < 0 ? 1 : -1), 1);
    renderCalendar();
  }, { passive: true });
  $("#calendarDayForm")?.addEventListener("submit", saveCalendarDay);
  $("#closeCalendarDayBtn")?.addEventListener("click", closeCalendarDayDialog);
  $("#cancelCalendarDayBtn")?.addEventListener("click", closeCalendarDayDialog);
  $("#resetCalendarDayBtn")?.addEventListener("click", resetCalendarDay);
  $("#calendarDayTherapies")?.addEventListener("change", (event) => {
    const check = event.target.closest(".calendar-day-therapy-check");
    if (!check) return;
    const row = check.closest(".calendar-day-therapy-row");
    row?.classList.toggle("selected", check.checked);
    const input = row?.querySelector(".calendar-day-times");
    if (input) input.disabled = !check.checked;
  });

  document.addEventListener("click", async (event) => {
    const calendarToggleDay = event.target.closest("[data-calendar-toggle-date]");
    if (calendarToggleDay) {
      toggleSelectedTherapyDate(calendarToggleDay.dataset.calendarToggleDate);
      return;
    }
    const calendarDay = event.target.closest("[data-calendar-date]");
    if (calendarDay) {
      openCalendarDayDialog(calendarDay.dataset.calendarDate);
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id, time, date, minutes } = button.dataset;
    if (action === "edit-therapy-from-calendar") {
      closeCalendarDayDialog();
      setTimeout(() => openTherapyDialog(id), 30);
      return;
    }
    if (action === "mark-taken") markDose(id, time, "taken", date || localDateISO());
    if (action === "mark-skipped") markDose(id, time, "skipped", date || localDateISO());
    if (action === "reset-dose") resetDose(id, time, date || localDateISO());
    if (action === "snooze-dose") snoozeDose(id, time, Number(minutes) || 10, date || localDateISO());
    if (action === "edit-therapy") openTherapyDialog(id);
    if (action === "repeat-therapy") openRepeatTherapyDialog(id);
    if (action === "remove-duplicate-therapy") {
      const therapy = state.therapies.find((item) => item.id === id);
      if (therapy && confirm(`Rimuovere la copia duplicata “${therapy.name}”? Verrà eliminata da tutte le giornate future e saranno rimossi anche gli eventuali eventi registrati per questa copia.`)) {
        state.therapies = state.therapies.filter((item) => item.id !== id);
        state.logs = state.logs.filter((log) => log.therapyId !== id);
        state.scheduleOverrides = (state.scheduleOverrides || []).filter((item) => item.therapyId !== id);
        try {
          await deleteTherapyImage(id);
        } catch (error) {
          console.warn("Immagine duplicata non rimossa", error);
        }
        replaceTherapyImageUrl(id, null);
        if (saveState()) {
          showToast("Copia duplicata rimossa.");
        }
      }
    }
    if (action === "toggle-therapy") {
      const therapy = state.therapies.find((item) => item.id === id);
      if (therapy) therapy.active = !therapy.active;
      saveState();
    }
    if (action === "archive-therapy") {
      const therapy = state.therapies.find((item) => item.id === id);
      if (therapy && confirm(`Archiviare la terapia “${therapy.name}”? Non riceverai più promemoria, ma tutti i dati resteranno conservati.`)) {
        therapy.archived = true;
        therapy.archivedAt = new Date().toISOString();
        therapy.active = false;
        saveState();
        showToast("Terapia spostata nell’archivio.");
      }
    }
    if (action === "restore-therapy") {
      const therapy = state.therapies.find((item) => item.id === id);
      if (therapy) {
        therapy.archived = false;
        therapy.archivedAt = "";
        therapy.active = false;
        therapy.updatedAt = new Date().toISOString();
        saveState();
        showToast("Terapia ripristinata come sospesa. Riattivala solo se ancora prescritta.");
        showView("therapies");
      }
    }
    if (action === "delete-forever") {
      const therapy = state.therapies.find((item) => item.id === id);
      if (therapy && confirm(`Eliminare definitivamente “${therapy.name}”? Questa operazione non può essere annullata. Lo storico delle assunzioni resterà comunque disponibile.`)) {
        state.therapies = state.therapies.filter((item) => item.id !== id);
        state.scheduleOverrides = (state.scheduleOverrides || []).filter((item) => item.therapyId !== id);
        deleteTherapyImage(id).catch(console.error);
        replaceTherapyImageUrl(id, null);
        saveState();
        showToast("Terapia eliminata definitivamente.");
      }
    }
  });

  $("#historyDate").addEventListener("change", renderHistory);
  $("#resetHistoryFilter").addEventListener("click", () => { $("#historyDate").value = ""; renderHistory(); });
  $("#clearHistoryBtn").addEventListener("click", () => { if (state.logs.length && confirm("Vuoi eliminare tutto lo storico?")) { state.logs = []; saveState({ sync: false }); } });
  $("#notificationBtn").addEventListener("click", requestNotifications);
  $("#generateKeyBtn").addEventListener("click", () => { $("#appKey").value = [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join(""); });
  $("#telegramEnabled")?.addEventListener("change", async (event) => {
    state.settings = readSettingsForm();
    state.settings.telegramEnabled = event.target.checked;
    writeStateToLocalStorage();
    if (telegramConfigReady()) {
      try {
        await syncCloud(false);
        if (event.target.checked) await checkAndRepairTelegram({ sendTest: false, showMessage: true });
        else {
          setTelegramHealthStatus("Disattivato", "warning", "Promemoria Telegram disattivato e profilo Cloudflare aggiornato.");
          showToast("Promemoria Telegram disattivato.");
        }
      } catch (error) {
        setTelegramHealthStatus("Errore", "error", error?.message || "Sincronizzazione non riuscita.");
      }
    }
  });
  $("#telegramHealthBtn")?.addEventListener("click", () => checkAndRepairTelegram({ sendTest: true, showMessage: true }));
  $("#saveCloudBtn").addEventListener("click", saveCloudSettings);
  $("#testTelegramBtn").addEventListener("click", testTelegram);
  $("#easyBackupBtn").addEventListener("click", easyBackup);
  $("#sendRecoveryTelegramBtn")?.addEventListener("click", sendRecoveryLinkNow);
  $("#autoBackupEnabled")?.addEventListener("change", (event) => {
    state.settings.autoBackupEnabled = event.target.checked;
    writeStateToLocalStorage();
    if (event.target.checked) scheduleAutoBackup(500);
  });
  $("#multiDeviceSyncEnabled")?.addEventListener("change", (event) => {
    state.settings.multiDeviceSyncEnabled = event.target.checked;
    writeStateToLocalStorage();
    if (event.target.checked) maybeSyncFromCloud(false);
  });
  $("#syncDevicesNowBtn")?.addEventListener("click", () => maybeSyncFromCloud(true));
  window.addEventListener("online", () => maybeSyncFromCloud(false));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") maybeSyncFromCloud(false); });
  $("#copyRecoveryCodeBtn").addEventListener("click", copyRecoveryCode);
  $("#shareRecoveryCodeBtn").addEventListener("click", shareRecoveryCode);
  $("#restoreWithCodeBtn").addEventListener("click", restoreWithRecoveryCode);
  $("#verifyRecoveryCodeBtn")?.addEventListener("click", verifyRecoveryBackup);
  $("#recoveryCodeInput").addEventListener("change", (event) => {
    state.settings.recoveryCode = event.target.value.trim();
    writeStateToLocalStorage();
  });
  $("#saveOnlineBackupBtn").addEventListener("click", saveOnlineBackup);
  $("#restoreOnlineBackupBtn").addEventListener("click", restoreOnlineBackup);
  $("#deleteOnlineBackupBtn").addEventListener("click", deleteOnlineBackup);
  $("#exportJsonBtn").addEventListener("click", exportBackup);
  $("#exportCsvBtn").addEventListener("click", exportCsv);
  $("#printPdfBtn").addEventListener("click", printPdfReport);
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
  // v22: normalizza i dati provenienti da vecchi backup/versioni.
  state.therapies = (state.therapies || []).map(normalizeTherapyRecord);
  state.scheduleOverrides = (state.scheduleOverrides || []).map(normalizeScheduleOverride).filter(Boolean);
  bindEvents();
  await loadTherapyImages();
  // Libera automaticamente eventuali dati pesanti lasciati dalle vecchie versioni.
  writeStateToLocalStorage();
  renderAll();
  const recoveryLinkOpened = loadRecoveryCodeFromUrl();
  if (!recoveryLinkOpened) scheduleAutoBackup(5000);
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (error) { console.error(error); }
  }
  checkDueNotifications();
  flushDoseStatusSync().catch(console.warn);
  // v19: ad ogni apertura ricrea/allinea il profilo Cloudflare se Telegram è attivo.
  // Questo risolve i casi in cui un ripristino o un cambio dispositivo lascia
  // il profilo remoto assente, disattivato o non aggiornato.
  if (state.settings.telegramEnabled) {
    setTimeout(() => {
      ensureTelegramProfile({ showMessage: false })
        .then(() => checkAndRepairTelegram({ sendTest: false, showMessage: false }))
        .catch(console.warn);
    }, 1200);
  } else {
    setTelegramHealthStatus("Disattivato", "warning", "Attiva Promemoria Telegram per ricevere gli avvisi.");
  }

  setInterval(() => {
    renderToday();
    renderCalendar();
    checkDueNotifications();
    flushDoseStatusSync().catch(console.warn);
  }, 30000);
  setTimeout(() => maybeSyncFromCloud(false), 2500);
  setInterval(() => maybeSyncFromCloud(false), 120000);
}

init();
