// ─── Базовый словарь ────────────────────────────────────────────────────────
const BASE_TRANSLATIONS = [
  { ru: "кот", en: "cat" },
  { ru: "собака", en: "dog" },
  { ru: "дом", en: "house" },
  { ru: "книга", en: "book" },
  { ru: "вода", en: "water" },
  { ru: "время", en: "time" },
  { ru: "работа", en: "work" },
  { ru: "школа", en: "school" },
  { ru: "друг", en: "friend" },
  { ru: "семья", en: "family" },
];

const STORAGE_KEY     = "typing-trainer-vocab-v2";
const BEST_SCORE_KEY  = "typing-trainer-best-score-v3";
const BEST_SCORE_META = "typing-trainer-best-score-meta-v3";

// ─── Состояние ───────────────────────────────────────────────────────────────
let vocab         = [];
let filteredVocab = [];
let currentCard   = null;
let roundStartTime= null;
let sessionEndAt  = 0;
let sessionRunning= false;
let roundHadMistake   = false;
let roundErrorCount   = 0;
let prevInputLength   = 0;
let rafId         = 0;
let waitingForSpace   = false;
let readyToSubmit = false;
let sortState     = { key: "weight", dir: "desc" };
let hintRevealCount   = 0;
let flashTimer    = null;
let lastSessionScore  = 0;
let bestScore     = 0;
let spokenThisRound   = false;   // FIX 3: слово уже произнесено в этом раунде?

// Гибкий фильтр
let filterParams = { weightOp: "", weightVal: 5, dateFrom: "", dateTo: "", recentN: 0, minLen: 0 };

const sessionStats = {
  expectedChars: 0,
  errorHits:     0,
  hintHits:      0,
  hardPerfectHits: 0,
  weightedSolved: 0,
  wordsDone:     0,
  startedAt:     0,
  durationSec:   60,
};

// ─── DOM ─────────────────────────────────────────────────────────────────────
const el = {
  target:           document.getElementById("target"),
  input:            document.getElementById("input"),
  btnStartTimer:    document.getElementById("btn-start-timer"),
  durationSelect:   document.getElementById("duration-select"),
  stats:            document.getElementById("stats"),
  timer:            document.getElementById("timer"),
  speech:           document.getElementById("speech-enabled"),
  speechVolume:     document.getElementById("speech-volume"),
  speechVolumeValue:document.getElementById("speech-volume-value"),
  srsState:         document.getElementById("srs-state"),
  tabHint:          document.getElementById("tab-hint"),
  bulkImportInput:  document.getElementById("bulk-import-input"),
  btnImportBulk:    document.getElementById("btn-import-bulk"),
  btnDownloadDb:    document.getElementById("btn-download-db"),
  dbList:           document.getElementById("db-list"),
  addFlash:         document.getElementById("add-flash"),
  filterToggle:     document.getElementById("filter-toggle-btn"),
  filterPanel:      document.getElementById("filter-panel"),
};

// ─── Нормализация ─────────────────────────────────────────────────────────────
function normalizeEn(s) { return s.trim().toLowerCase().replace(/\s+/g, " "); }
function normalizeForCheck(s) {
  return normalizeEn(s).split(" ")
    .filter(t => t && t !== "a" && t !== "an" && t !== "the" && t !== "to")
    .join(" ");
}

// ─── Карточка ────────────────────────────────────────────────────────────────
function toCard(item) {
  return {
    ru:           item.ru,
    en:           normalizeEn(item.en),
    weight:       Math.max(1, Math.min(10, Number(item.weight) || 5)),
    streak:       Number(item.streak)       || 0,
    cooldown:     Number(item.cooldown)     || 0,
    avgSecPerChar:Number(item.avgSecPerChar)|| 0,
    attempts:     Number(item.attempts)     || 0,
    addedAt:      item.addedAt || new Date().toISOString(),
  };
}

// ─── Персистентность ─────────────────────────────────────────────────────────
function loadVocab() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : BASE_TRANSLATIONS;
    const clean = Array.isArray(parsed) ? parsed.map(toCard).filter(x => x.ru && x.en) : [];
    vocab = clean.length ? clean : BASE_TRANSLATIONS.map(toCard);
  } catch { vocab = BASE_TRANSLATIONS.map(toCard); }
}
function saveVocab() { localStorage.setItem(STORAGE_KEY, JSON.stringify(vocab)); }
function loadBestScore() {
  const raw = Number(localStorage.getItem(BEST_SCORE_KEY) || 0);
  bestScore = Number.isFinite(raw) ? Math.max(0, Math.min(1000, Math.round(raw))) : 0;
}
function saveBestScore() {
  localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
  localStorage.setItem(BEST_SCORE_META, JSON.stringify({ savedAt: new Date().toISOString(), score: bestScore }));
}

// ─── Гибкий фильтр ────────────────────────────────────────────────────────────
function applyFilter() {
  let pool = [...vocab];

  if (filterParams.weightOp) {
    const v = filterParams.weightVal;
    if      (filterParams.weightOp === ">=") pool = pool.filter(c => c.weight >= v);
    else if (filterParams.weightOp === "<=") pool = pool.filter(c => c.weight <= v);
    else if (filterParams.weightOp === "=")  pool = pool.filter(c => c.weight === v);
  }
  if (filterParams.dateFrom) {
    const from = new Date(filterParams.dateFrom).getTime();
    if (!isNaN(from)) pool = pool.filter(c => new Date(c.addedAt).getTime() >= from);
  }
  if (filterParams.dateTo) {
    const to = new Date(filterParams.dateTo).getTime() + 86400000;
    if (!isNaN(to)) pool = pool.filter(c => new Date(c.addedAt).getTime() <= to);
  }
  if (filterParams.minLen > 0)
    pool = pool.filter(c => c.en.replace(/\s/g, "").length >= filterParams.minLen);
  if (filterParams.recentN > 0)
    pool = [...pool].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)).slice(0, filterParams.recentN);

  filteredVocab = pool.length ? pool : [...vocab];
  updateFilterBadge();
}

function updateFilterBadge() {
  const active = filterParams.weightOp || filterParams.dateFrom || filterParams.dateTo
              || filterParams.recentN > 0 || filterParams.minLen > 0;
  el.filterToggle.classList.toggle("active", !!active);
  el.filterToggle.textContent = active ? `Фильтр ✦ (${filteredVocab.length})` : "Фильтр";
}

function readFilterForm() {
  filterParams.weightOp  = document.getElementById("f-weight-op").value;
  filterParams.weightVal = parseInt(document.getElementById("f-weight-val").value) || 5;
  filterParams.dateFrom  = document.getElementById("f-date-from").value;
  filterParams.dateTo    = document.getElementById("f-date-to").value;
  filterParams.recentN   = parseInt(document.getElementById("f-recent-n").value)  || 0;
  filterParams.minLen    = parseInt(document.getElementById("f-min-len").value)   || 0;
  applyFilter();
}

function resetFilterForm() {
  filterParams = { weightOp: "", weightVal: 5, dateFrom: "", dateTo: "", recentN: 0, minLen: 0 };
  ["f-weight-op","f-date-from","f-date-to","f-recent-n","f-min-len"].forEach(id => {
    document.getElementById(id).value = "";
  });
  document.getElementById("f-weight-val").value = "5";
  applyFilter();
}

// ─── Система весов ────────────────────────────────────────────────────────────
function weightedCard() {
  const pool = filteredVocab;
  if (!pool.length) return null;
  const scores = pool.map(c => {
    const base = Math.pow(c.weight, 1.7);
    const cd   = 1 / (1 + c.cooldown * 0.8);
    return Math.max(0.2, base * cd);
  });
  const total = scores.reduce((a, b) => a + b, 0);
  let pick = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    pick -= scores[i];
    if (pick <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function decayCooldowns() {
  for (const c of filteredVocab) if (c.cooldown > 0) c.cooldown -= 1;
}

function pickNextCard() {
  decayCooldowns();
  currentCard = weightedCard();
}

// ─── SRS ─────────────────────────────────────────────────────────────────────
function personalAvgSecPerChar() {
  let sum = 0, count = 0;
  for (const c of vocab) {
    if (c.avgSecPerChar > 0 && c.attempts > 0) { sum += c.avgSecPerChar * c.attempts; count += c.attempts; }
  }
  return count ? sum / count : 0.4;
}

function applySrsResult(secondsRaw) {
  if (!currentCard) return;
  const secPerChar = secondsRaw / Math.max(1, currentCard.en.length);
  const avg        = personalAvgSecPerChar();
  const isSlow     = secPerChar > avg * 1.3;
  const perfect    = !roundHadMistake && roundErrorCount === 0 && hintRevealCount === 0 && !isSlow;

  if (perfect) {
    currentCard.streak += 1;
    if (currentCard.streak % 2 === 0) currentCard.weight = Math.max(1, currentCard.weight - 1);
    if (currentCard.streak >= 3) currentCard.cooldown = Math.min(15, Math.floor(currentCard.streak * 0.7));
  } else {
    currentCard.streak   = 0;
    currentCard.cooldown = 0;
    let penalty = 0;
    if (roundErrorCount > 0) penalty += 2;
    else if (isSlow)         penalty += 1;
    if (hintRevealCount > 0) penalty += 1;
    currentCard.weight = Math.min(10, currentCard.weight + penalty);
  }
  currentCard.weight    = Math.round(Math.max(1, Math.min(10, currentCard.weight)));
  currentCard.attempts += 1;
  if (currentCard.avgSecPerChar <= 0) currentCard.avgSecPerChar = secPerChar;
  else currentCard.avgSecPerChar = currentCard.avgSecPerChar * 0.7 + secPerChar * 0.3;
  saveVocab();
}

// ─── Оценка сессии ───────────────────────────────────────────────────────────
function computeSessionScore() {
  if (!sessionStats.startedAt || sessionStats.wordsDone === 0) return { score: 0 };
  const elapsed         = Math.max(1, (Date.now() - sessionStats.startedAt) / 1000);
  const completionRatio = Math.min(1, elapsed / sessionStats.durationSec);
  const correctChars    = Math.max(0, sessionStats.expectedChars);
  const accuracy        = correctChars / Math.max(1, correctChars + sessionStats.errorHits + sessionStats.hintHits * 2);
  const cleanRate       = Math.max(0, 1 - (sessionStats.errorHits + sessionStats.hintHits * 1.5) / Math.max(1, correctChars));
  const wpm             = (correctChars / 5 / elapsed) * 60;
  const speedScore      = Math.min(1, wpm / 40);
  const coverage        = Math.min(1, sessionStats.wordsDone / (sessionStats.durationSec / 7));

  let base = accuracy * 350 + cleanRate * 250 + speedScore * 200 + coverage * 200;
  base -= sessionStats.errorHits * 12;
  base -= sessionStats.hintHits  * 20;
  if (completionRatio < 0.95) base *= (0.5 + completionRatio * 0.5);
  if (sessionStats.errorHits > 0 || sessionStats.hintHits > 0) base = Math.min(base, 900);
  if (sessionStats.wordsDone < 8) base = Math.min(base, 820);
  base = Math.min(base, 980);

  const exceptional = sessionStats.wordsDone >= 20 && sessionStats.errorHits === 0
    && sessionStats.hintHits === 0 && wpm >= 55 && completionRatio >= 0.95;
  if (exceptional) base = Math.min(1000, base + 20);

  const score = Math.max(0, Math.min(1000, Math.round(base)));
  return { score: sessionStats.wordsDone > 0 ? Math.max(1, score) : score };
}

// ─── Рендеринг ────────────────────────────────────────────────────────────────
function renderTarget() {
  if (!currentCard) {
    el.target.textContent   = "Нажмите Старт, чтобы начать сессию.";
    el.srsState.textContent = "";
    return;
  }
  el.target.textContent   = currentCard.ru;
  el.srsState.textContent = waitingForSpace
    ? "✓ Верно — пробел для следующего"
    : readyToSubmit
      ? "Готово — пробел для отправки"
      : `вес: ${currentCard.weight}/10 · серия: ${currentCard.streak}`;
}

function showFlash(text, ok = true) {
  if (flashTimer) clearTimeout(flashTimer);
  el.addFlash.textContent = text;
  el.addFlash.classList.add("show");
  el.addFlash.classList.toggle("error", !ok);
  flashTimer = setTimeout(() => {
    el.addFlash.textContent = "";
    el.addFlash.classList.remove("show", "error");
    flashTimer = null;
  }, 2200);
}

function showStats() {
  if (!sessionStats.startedAt) { el.stats.hidden = true; return; }
  const elapsed      = Math.max(1, (Date.now() - sessionStats.startedAt) / 1000);
  const correctChars = Math.max(0, sessionStats.expectedChars);
  const total        = correctChars + sessionStats.errorHits;
  const accuracy     = total ? Math.round((correctChars / total) * 100) : 0;
  const cpm          = Math.round((correctChars / elapsed) * 60);
  const wpm          = Math.round((correctChars / 5 / elapsed) * 60);
  const scoreNow     = computeSessionScore().score;
  lastSessionScore   = scoreNow;

  el.stats.innerHTML = `
    <div class="stat"><div class="val">${wpm}</div><div class="lbl">слов/мин</div></div>
    <div class="stat"><div class="val">${cpm}</div><div class="lbl">симв./мин</div></div>
    <div class="stat"><div class="val">${accuracy}%</div><div class="lbl">точность</div></div>
    <div class="stat"><div class="val">${elapsed.toFixed(1)} с</div><div class="lbl">время</div></div>
    <div class="stat"><div class="val">${sessionStats.errorHits}</div><div class="lbl">ошибок</div></div>
    <div class="stat"><div class="val">${sessionStats.wordsDone}</div><div class="lbl">слов</div></div>
    <div class="stat score-stat"><div class="val">${scoreNow}</div><div class="lbl">оценка</div></div>
    <div class="stat"><div class="val">${bestScore}</div><div class="lbl">рекорд</div></div>
  `;
  el.stats.hidden = false;
}

function renderDbList() {
  const rows = [...vocab].sort((a, b) => {
    const dir = sortState.dir === "asc" ? 1 : -1;
    if (sortState.key === "en" || sortState.key === "ru")
      return a[sortState.key].localeCompare(b[sortState.key], "en") * dir;
    if (sortState.key === "addedAt")
      return (new Date(a.addedAt) - new Date(b.addedAt)) * dir;
    return (a.weight - b.weight) * dir;
  });

  if (!rows.length) { el.dbList.innerHTML = `<div class="db-row"><div>Список пуст</div></div>`; return; }

  const arrow = k => sortState.key === k ? (sortState.dir === "asc" ? " ▲" : " ▼") : "";
  const head = `<div class="db-row db-head">
    <div data-sort-key="en">English${arrow("en")}</div>
    <div data-sort-key="ru">Перевод${arrow("ru")}</div>
    <div data-sort-key="weight">Вес${arrow("weight")}</div>
    <div>Серия</div>
    <div data-sort-key="addedAt">Добавлено${arrow("addedAt")}</div>
    <div>Действие</div>
  </div>`;
  const body = rows.map(c => `<div class="db-row">
    <div><input class="db-cell-input edit-en"     value="${c.en.replace(/"/g,"&quot;")}"/></div>
    <div><input class="db-cell-input edit-ru"     value="${c.ru.replace(/"/g,"&quot;")}"/></div>
    <div><input class="db-cell-input edit-weight" type="number" step="1" min="1" max="10" value="${c.weight}"/></div>
    <div>${c.streak}</div>
    <div>${new Date(c.addedAt).toLocaleDateString("ru-RU")}</div>
    <div>
      <button type="button" data-en="${encodeURIComponent(c.en)}" data-ru="${encodeURIComponent(c.ru)}" class="btn-save-word">Сохр.</button>
      <button type="button" data-en="${encodeURIComponent(c.en)}" data-ru="${encodeURIComponent(c.ru)}" class="btn-del-word">Удал.</button>
    </div>
  </div>`).join("");
  el.dbList.innerHTML = head + body;
}

// ─── Логика ввода ────────────────────────────────────────────────────────────
function isPrefixWrong(typed, target) {
  for (let i = 0; i < typed.length; i++) if (typed[i] !== target[i]) return true;
  return typed.length > target.length;
}

function roundElapsedSec() { return (Date.now() - roundStartTime) / 1000; }

// FIX 3: произносить как только введена последняя правильная буква
function maybeSpeak() {
  if (!el.speech.checked || !currentCard || !("speechSynthesis" in window)) return;
  if (spokenThisRound) return;
  spokenThisRound = true;
  const u  = new SpeechSynthesisUtterance(currentCard.en);
  u.lang   = "en-US";
  u.volume = Math.max(0, Math.min(1, Number(el.speechVolume.value || 70) / 100));
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function onInput() {
  if (!sessionRunning || !currentCard) return;
  if (waitingForSpace) return;
  const typed    = normalizeForCheck(el.input.value);
  const expected = normalizeForCheck(currentCard.en);
  const wrong    = isPrefixWrong(typed, expected);
  const grew     = typed.length > prevInputLength;
  if (wrong) {
    roundHadMistake = true;
    if (grew && roundErrorCount === 0) roundErrorCount = 1;
  }
  prevInputLength = typed.length;

  // FIX 1: подсветка фона при ошибке, рамка НЕ меняется
  el.input.classList.toggle("bad", wrong);

  readyToSubmit = typed === expected;
  if (readyToSubmit) {
    el.input.classList.remove("bad");
    maybeSpeak(); // FIX 3: слово произносится сразу при правильном вводе
  }
  renderTarget();
}

// ─── Раунд ───────────────────────────────────────────────────────────────────
function resetRoundInput() {
  el.input.value = "";
  el.input.classList.remove("bad");
  roundStartTime   = Date.now();
  roundHadMistake  = false;
  roundErrorCount  = 0;
  prevInputLength  = 0;
  hintRevealCount  = 0;
  waitingForSpace  = false;
  readyToSubmit    = false;
  spokenThisRound  = false;
  el.tabHint.textContent = "";
  el.input.disabled = false;
  el.input.focus();
}

function startRound() {
  pickNextCard();
  if (!currentCard) { stopSession("Словарь пуст по фильтру. Поменяйте фильтр или добавьте слова."); return; }
  renderTarget();
  resetRoundInput();
}

function onWordSuccess(advanceImmediately = false) {
  const secondsRaw = Math.max(0.05, roundElapsedSec());
  const secPerChar = secondsRaw / Math.max(1, currentCard ? currentCard.en.length : 1);
  const avg        = personalAvgSecPerChar();
  const isSlow     = secPerChar > avg * 1.3;

  applySrsResult(secondsRaw);

  const weighted = Math.max(1, currentCard ? currentCard.weight : 1);
  sessionStats.weightedSolved += weighted;
  if (roundErrorCount === 0 && hintRevealCount === 0 && !isSlow) sessionStats.hardPerfectHits += weighted;
  sessionStats.wordsDone     += 1;
  sessionStats.expectedChars += normalizeForCheck(currentCard.en).length;
  sessionStats.errorHits     += roundErrorCount;
  sessionStats.hintHits      += hintRevealCount;

  const scoreNow = computeSessionScore().score;
  lastSessionScore = scoreNow;
  if (scoreNow > bestScore) { bestScore = scoreNow; saveBestScore(); }

  showStats();
  waitingForSpace = !advanceImmediately;
  readyToSubmit   = false;
  if (advanceImmediately && sessionRunning) startRound();
  else renderTarget();
}

// ─── Сессия ──────────────────────────────────────────────────────────────────
function tickSessionTimer() {
  if (!sessionRunning) return;
  const leftMs  = Math.max(0, sessionEndAt - Date.now());
  const leftSec = Math.ceil(leftMs / 1000);
  el.timer.textContent = `${String(Math.floor(leftSec/60)).padStart(2,"0")}:${String(leftSec%60).padStart(2,"0")}`;
  if (leftMs <= 0) { stopSession(); return; }
  rafId = requestAnimationFrame(tickSessionTimer);
}

function stopSession(reasonText) {
  sessionRunning = false;
  if (rafId) cancelAnimationFrame(rafId);
  el.input.disabled         = true;
  el.btnStartTimer.disabled = false;
  const finalScore = computeSessionScore().score;
  lastSessionScore = finalScore;
  if (finalScore > bestScore) { bestScore = finalScore; saveBestScore(); }
  showStats();
  el.target.textContent   = reasonText || "Время вышло. Нажмите Старт для новой сессии.";
  el.srsState.textContent = "";
  el.tabHint.textContent  = "";
}

function startSession() {
  const sec = Number(el.durationSelect.value) || 60;
  applyFilter();
  sessionRunning = true;
  Object.assign(sessionStats, { expectedChars:0, errorHits:0, hintHits:0, hardPerfectHits:0,
    weightedSolved:0, wordsDone:0, startedAt: Date.now(), durationSec: sec });
  lastSessionScore = 0;
  sessionEndAt     = Date.now() + sec * 1000;
  el.btnStartTimer.disabled = true;
  el.stats.hidden = false;
  startRound();
  tickSessionTimer();
}

// ─── Управление словарём ─────────────────────────────────────────────────────
function addWordPair(enRaw, ruRaw, weight = 5) {
  const ru = ruRaw.trim(), en = normalizeEn(enRaw);
  if (!ru || !en) return { ok: false, reason: "bad-format" };
  if (vocab.find(x => x.ru.toLowerCase() === ru.toLowerCase() && x.en === en))
    return { ok: false, reason: "duplicate" };
  vocab.push(toCard({ ru, en, weight, streak:0, cooldown:0, addedAt: new Date().toISOString() }));
  saveVocab();
  return { ok: true };
}

function importBulk() {
  const lines = el.bulkImportInput.value.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if (!lines.length) { showFlash("Нет данных", false); return; }
  let added=0, duplicates=0, invalid=0;
  for (const line of lines) {
    const parts = line.split("\t").map(p=>p.trim());
    if (!parts[0] || !parts[1]) { invalid++; continue; }
    if (normalizeEn(parts[0]) === "english" && parts[1].toLowerCase().includes("перевод")) continue;
    const r = addWordPair(parts[0], parts[1], 5);
    if (r.ok) added++; else if (r.reason==="duplicate") duplicates++; else invalid++;
  }
  renderDbList(); applyFilter();
  showFlash(`Добавлено: ${added} (дублей: ${duplicates})`, added > 0);
  if (added > 0) el.bulkImportInput.value = "";
}

function deleteWord(en, ru) {
  const prev = vocab.length;
  vocab = vocab.filter(c => !(c.en === en && c.ru === ru));
  if (vocab.length !== prev) { saveVocab(); applyFilter(); renderDbList(); showFlash("Удалено"); }
}

function saveWord(oldEn, oldRu, newEnRaw, newRuRaw, newWeightRaw) {
  const newEn = normalizeEn(newEnRaw), newRu = newRuRaw.trim();
  const newWeight = Math.round(Number(newWeightRaw));
  if (!newEn || !newRu || !Number.isFinite(newWeight) || newWeight<1 || newWeight>10)
    { showFlash("Вес: целое от 1 до 10", false); return; }
  const item = vocab.find(c => c.en===oldEn && c.ru===oldRu);
  if (!item) { showFlash("Строка не найдена", false); return; }
  if (vocab.find(c => c!==item && c.en===newEn && c.ru.toLowerCase()===newRu.toLowerCase()))
    { showFlash("Такая пара уже есть", false); return; }
  item.en=newEn; item.ru=newRu; item.weight=newWeight;
  saveVocab(); renderDbList(); showFlash("Сохранено");
}

function downloadDb() {
  const blob = new Blob([JSON.stringify({exportedAt:new Date().toISOString(),total:vocab.length,words:vocab},null,2)],{type:"application/json;charset=utf-8"});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href=url; a.download="typing-vocab.json"; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url); showFlash("Файл скачан");
}

// ─── Слушатели событий ────────────────────────────────────────────────────────
el.input.addEventListener("input", onInput);
el.btnStartTimer.addEventListener("click", startSession);
el.btnImportBulk.addEventListener("click", importBulk);
el.btnDownloadDb.addEventListener("click", downloadDb);

el.input.addEventListener("keydown", e => {
  if (e.key === "Tab") {
    e.preventDefault();
    if (!sessionRunning || !currentCard || waitingForSpace) return;
    hintRevealCount += 1;
    const typed    = normalizeForCheck(el.input.value);
    const expected = normalizeForCheck(currentCard.en);
    const revealLen= Math.min(expected.length, typed.length + hintRevealCount);
    el.tabHint.textContent = `Подсказка: ${expected.slice(0, revealLen)}`;
    return;
  }
  if (e.key === " " && waitingForSpace && sessionRunning) { e.preventDefault(); startRound(); return; }
  if (e.key === " " && sessionRunning && readyToSubmit && !waitingForSpace) { e.preventDefault(); onWordSuccess(true); return; }
});

el.bulkImportInput.addEventListener("keydown", e => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const s = el.bulkImportInput.selectionStart;
  const v = el.bulkImportInput.value;
  el.bulkImportInput.value = `${v.slice(0,s)}\t${v.slice(el.bulkImportInput.selectionEnd)}`;
  el.bulkImportInput.selectionStart = el.bulkImportInput.selectionEnd = s + 1;
});

el.dbList.addEventListener("click", e => {
  const sortCell = e.target.closest("[data-sort-key]");
  if (sortCell) {
    const key = sortCell.dataset.sortKey;
    sortState = sortState.key===key ? {key, dir: sortState.dir==="asc"?"desc":"asc"} : {key, dir:"asc"};
    renderDbList(); return;
  }
  const delBtn = e.target.closest(".btn-del-word");
  if (delBtn) { deleteWord(decodeURIComponent(delBtn.dataset.en||""), decodeURIComponent(delBtn.dataset.ru||"")); return; }
  const saveBtn = e.target.closest(".btn-save-word");
  if (!saveBtn) return;
  const en=decodeURIComponent(saveBtn.dataset.en||""), ru=decodeURIComponent(saveBtn.dataset.ru||"");
  const row = saveBtn.closest(".db-row");
  if (!row) return;
  saveWord(en, ru, row.querySelector(".edit-en")?.value||"", row.querySelector(".edit-ru")?.value||"", row.querySelector(".edit-weight")?.value||"");
});

// Фильтр: toggle панели
el.filterToggle.addEventListener("click", () => {
  el.filterPanel.hidden = !el.filterPanel.hidden;
});
document.getElementById("btn-filter-apply").addEventListener("click", () => {
  readFilterForm();
  el.filterPanel.hidden = true;
});
document.getElementById("btn-filter-reset").addEventListener("click", () => {
  resetFilterForm();
  el.filterPanel.hidden = true;
});

el.speechVolume.addEventListener("input", () => {
  el.speechVolumeValue.textContent = `${el.speechVolume.value}%`;
});

// ─── Инициализация ────────────────────────────────────────────────────────────
loadVocab();
loadBestScore();
applyFilter();
renderTarget();
renderDbList();
showStats();
el.input.disabled = true;