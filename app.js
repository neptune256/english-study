import { db, today, addDays, REMOTE } from "./db.js";
import { planDay, nextLevels, GRAMMAR } from "./planner.js";
import { afterLearning, afterReview, reviewStage } from "./memory.js";

const $app = document.getElementById("app");
const DAY = new URLSearchParams(location.search).get("day") || today(); // ?day= for testing

// Stages every new word goes through, in order (5 words per group). They move from
// recognising the word to using it: recall → match → hear → synonym → use in a sentence →
// judge usage → passage → translate. (No spelling: the goal is reading.) A wrong answer sends
// the word to the back of that stage's queue, so a stage ends only when every word in the group
// is answered right. After all groups, a mixed final check brings back all of today's words.
const STAGES = [
  { key: "card", label: "익히기" },
  { key: "recall", label: "떠올리기" },
  { key: "match", label: "짝 맞추기" },
  { key: "listen", label: "듣고 뜻 고르기" },
  { key: "synonym", label: "유의어 고르기" },
  { key: "cloze", label: "빈칸 채우기" },
  { key: "usage", label: "쓰임 판단" },
  { key: "context", label: "지문 속 의미" },
  { key: "translate", label: "해석하기" },
];
const FINAL_KINDS = ["listen", "cloze", "usage"]; // mixed retrieval for the final check
const GROUP = 5;
const HAS_TTS = "speechSynthesis" in window;

let S = {}; // loaded data: words, passages, set, progress, state

// ───────────── helpers ─────────────
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const shuffle = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const surfaceOf = (ex) => (ex.match(/\[([^\]]+)\]/) || [, ""])[1];
const showEx = (ex) => esc(ex).replace(/\[([^\]]+)\]/g, "<b>$1</b>");
const clozeEx = (ex) => esc(ex).replace(/\[([^\]]+)\]/g, '<span class="blank">______</span>');
const CIRCLED = ["①", "②", "③", "④", "⑤"];

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {
    /* no speech on this device */
  }
}
const screen = (html) => {
  // Every study screen gets a "저장하고 나가기" button in its top bar.
  html = html.replace('<div class="bar">', '<div class="bar"><button class="exit" onclick="saveAndExit()">← 저장하고 나가기</button>');
  $app.innerHTML = html;
  window.scrollTo(0, 0);
};
const tap = (sel, fn) => $app.querySelectorAll(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Distractors: other words, same part of speech first. */
function others(w, n, pool = S.words) {
  const same = shuffle(pool.filter((x) => x.id !== w.id && x.pos === w.pos && x.meaning !== w.meaning));
  const rest = shuffle(pool.filter((x) => x.id !== w.id && x.pos !== w.pos));
  return [...same, ...rest].slice(0, n);
}

// ───────────── load / plan ─────────────
async function load() {
  screen(`<div class="center muted">불러오는 중…</div>`);
  const [words, passages, progress, state, allDaily, events] = await Promise.all([
    db.words(), db.passages(), db.progress(), db.state(), db.allDaily(), db.events(),
  ]);
  S = { words, passages, progress, state, events };
  S.wordById = Object.fromEntries(words.map((w) => [w.id, w]));
  S.passageById = Object.fromEntries(passages.map((p) => [p.id, p]));
  S.progressById = Object.fromEntries(progress.map((p) => [p.word_id, p]));

  let set = allDaily.find((d) => d.day === DAY);
  if (!set) {
    const used = new Set(allDaily.flatMap((d) => d.passage_ids));
    set = planDay({ day: DAY, state, passages, words, progress, events, usedPassageIds: used });
    await db.saveDaily(set);
  }
  S.set = set;
  home();
}

// Saves run one after another (never out of order) and don't hold up the next question.
let saving = Promise.resolve();
const saveSet = () => {
  const snapshot = JSON.parse(JSON.stringify(S.set));
  saving = saving.then(() => db.saveDaily(snapshot)).catch((e) => console.error("save failed", e));
  return saving;
};

/** "저장하고 나가기": wait for pending saves, then back to the home screen. */
window.saveAndExit = async () => {
  try { speechSynthesis.cancel(); } catch { /* no speech */ }
  await saving;
  location.reload();
};

// ───────────── home ─────────────
function home() {
  const s = S.set;
  const sum = s.summary;
  const reviewsLeft = s.review_ids.filter((id) => !sum.reviewsDone.includes(id)).length;
  const groupsLeft = s.word_ids.filter((id) => !sum.wordsDone.includes(id)).length;
  const wordsLeft = groupsLeft || (s.word_ids.length && !sum.finalDone ? 1 : 0); // final check still to do
  const readLeft = s.passage_ids.filter((id) => !sum.readingDone.find((r) => r.id === id)).length;
  const step = (n, title, detail, done, active) => `
    <li class="step ${done ? "done" : ""} ${active ? "active" : ""}">
      <span class="num">${done ? "✓" : n}</span>
      <div><div class="step-title">${title}</div><div class="muted small">${detail}</div></div>
    </li>`;
  const analysisLeft = s.passage_ids.some((id) => !isGrammar(id)) && !sum.analysis ? 1 : 0;
  const next = reviewsLeft ? "review" : wordsLeft ? "vocab" : readLeft ? "reading" : analysisLeft ? "analysis" : null;
  screen(`
    <header class="top"><h1>오늘의 영어</h1><span class="muted">${DAY}</span></header>
    ${REMOTE ? "" : `<p class="note">로컬 테스트 모드입니다. 기록은 이 기기에만 저장됩니다.</p>`}
    <ol class="steps">
      ${step(1, "복습", s.review_ids.length ? `예전에 외운 단어 ${s.review_ids.length}개 확인` : "오늘은 복습할 단어가 없어요", !reviewsLeft, next === "review")}
      ${step(2, "단어 외우기", groupsLeft ? `${wordMix(s)} · 남은 단어 ${groupsLeft}개 · 마지막에 최종 점검` : !s.word_ids.length ? "오늘은 새 단어가 없어요 (지난 지문 복습일)" : sum.finalDone ? `${wordMix(s)} 완료` : "최종 점검만 남았어요", !wordsLeft, next === "vocab")}
      ${step(3, "독해 + 어법", `${readingSummary(s)} · 남은 문제 ${readLeft}개`, !readLeft, next === "reading")}
      ${step(4, "지문 분석", sum.analysis ? `제출 완료 · ${esc(S.passageById[sum.analysis.passage_id]?.source || "")}` : "오늘 지문 하나를 분석해서 PDF로 제출", !analysisLeft, next === "analysis")}
    </ol>
    ${
      next
        ? `<button class="btn primary big" id="go">${sum.wordsDone.length || sum.reviewsDone.length || sum.vocabPos || sum.finalPos || sum.readingDone.length ? "이어서 하기" : "시작하기"}</button>
           ${resumeNote(sum)}`
        : `<div class="card center"><h2>오늘 학습 완료!</h2>${resultLine()}</div>`
    }`);
  tap("#go", () => (next === "review" ? review() : next === "vocab" ? vocab() : next === "reading" ? reading() : analysis()));
}

// ───────────── passage analysis (PDF, not graded) ─────────────
const ANALYSIS_GUIDE = [
  "주제문(또는 요지)에 밑줄 긋고, 글 전체를 한국어 한 줄로 요약하기",
  "글의 흐름 나누기: 도입 → 전개 → 결론, 역접(But, However)·예시(For example)·결론(Thus) 연결어에 표시",
  "어려운 문장 2개를 골라 끊어 읽기: 주어·동사 표시하고 직독직해",
  "모르는 단어·표현 정리 (오늘 외운 단어는 형광펜)",
  "정답의 근거가 되는 문장 표시하고, 내가 고른 답이 왜 맞았는지/틀렸는지 적기",
];

function analysis() {
  const sum = S.set.summary;
  const ids = S.set.passage_ids.filter((id) => !isGrammar(id));
  const wrong = new Set(sum.readingDone.filter((r) => !r.correct).map((r) => r.id));
  screen(`
    <div class="bar"><span>지문 분석</span></div>
    <div class="card">
      <h2>분석할 지문을 하나 고르세요</h2>
      <p class="muted small">채점은 없어요. 선생님이 수업 때 함께 봐요.</p>
    </div>
    <div class="options">${ids.map((id) => {
      const p = S.passageById[id];
      return `<button class="opt pick" data-id="${esc(id)}">
        <div><b>${esc(p.qtype)}</b> · ${esc(p.source)} ${wrong.has(id) ? `<span class="badge">틀린 지문 · 추천</span>` : ""}
        <div class="muted small">${esc((p.box || p.body).replace(/\{\/?u\}/g, "").slice(0, 90))}…</div></div>
      </button>`;
    }).join("")}</div>
    <button class="btn big" id="back">나중에 할게요</button>`);
  tap("#back", () => home());
  tap(".pick", (el) => analysisFor(S.passageById[el.dataset.id]));
}

function analysisFor(p) {
  screen(`
    <div class="bar"><span>지문 분석 · ${esc(p.qtype)}</span><span class="muted small">${esc(p.source)}</span></div>
    <div class="card">
      <h2>이렇게 분석해 보세요</h2>
      <ol class="guide">${ANALYSIS_GUIDE.map((g) => `<li>${esc(g)}</li>`).join("")}</ol>
      <p class="muted small">① 아래 "지문 열기"로 지문을 PDF로 저장하거나 인쇄하고 ② 굿노트·노트 앱이나 종이에 분석한 뒤 ③ PDF로 내보내서(사진은 PDF로 변환) 제출하세요.</p>
      <button class="btn big" id="print">지문 열기 (PDF 저장·인쇄)</button>
    </div>
    <div class="card">
      <h2>분석 PDF 제출</h2>
      <label class="file">
        <input type="file" id="file" accept="application/pdf,.pdf" />
        <span id="fname">PDF 파일 선택</span>
      </label>
      <button class="btn primary big" id="send" disabled>제출하기</button>
      <div id="fb"></div>
    </div>
    <button class="btn big" id="back">다른 지문 고르기</button>`);
  tap("#back", () => analysis());
  tap("#print", () => printPassage(p));
  const input = $app.querySelector("#file");
  input.addEventListener("change", () => {
    const f = input.files[0];
    $app.querySelector("#fname").textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)}MB)` : "PDF 파일 선택";
    $app.querySelector("#send").disabled = !f;
  });
  tap("#send", async (btn) => {
    const f = input.files[0];
    const fb = $app.querySelector("#fb");
    if (!f) return;
    if (f.type && f.type !== "application/pdf") return (fb.innerHTML = `<div class="fb bad">PDF 파일만 제출할 수 있어요.</div>`);
    if (f.size > 50 * 1048576) return (fb.innerHTML = `<div class="fb bad">50MB 이하로 줄여서 제출해 주세요.</div>`);
    btn.disabled = true;
    btn.textContent = "올리는 중…";
    try {
      const row = await db.submitAnalysis({ day: DAY, passageId: p.id, file: f });
      S.set.summary.analysis = { passage_id: p.id, path: row.path, file_name: f.name, at: new Date().toISOString() };
      await saveSet();
      fb.innerHTML = `<div class="fb good">제출했어요! 수고했어요.</div>`;
      await wait(1200);
      home();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "다시 제출하기";
      fb.innerHTML = `<div class="fb bad">${esc(e.message)}</div>`;
    }
  });
}

/**
 * A clean, printable copy of the passage shown inside the app (no popup, so it also works
 * from the home-screen app). "인쇄 / PDF로 저장" opens the system print sheet, where the
 * student can print or save as PDF and then annotate it in a notes app.
 */
function printPassage(p) {
  const body = esc(p.body)
    .replace(/\{u\}/g, "<u>").replace(/\{\/u\}/g, "</u>")
    .replace(/_{3,}/g, "<span class='pblank'></span>")
    .split(/\n{2,}/).map((x) => `<p>${x.replace(/\n/g, "<br>")}</p>`).join("");
  const q = p.questions[0];
  const sheet = document.createElement("div");
  sheet.className = "print-sheet";
  sheet.innerHTML = `
    <div class="print-bar no-print">
      <button class="btn primary" id="doprint">인쇄 / PDF로 저장</button>
      <button class="btn" id="closeprint">돌아가기</button>
    </div>
    <h1>${esc(p.source)} · ${esc(p.instruction)}</h1>
    ${p.box ? `<div class="given">${esc(p.box).replace(/\n/g, "<br>")}</div>` : ""}
    <div class="pbody">${body}</div>
    ${p.glossary.length ? `<div class="pg">${p.glossary.map((g) => "* " + esc(g)).join("&nbsp;&nbsp;")}</div>` : ""}
    <ol class="pc">${q.choices.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>
    <div class="plines"><b>분석 메모</b>${"<div></div>".repeat(8)}</div>`;
  document.body.appendChild(sheet);
  document.body.classList.add("printing");
  window.scrollTo(0, 0);
  sheet.querySelector("#doprint").addEventListener("click", () => window.print());
  sheet.querySelector("#closeprint").addEventListener("click", () => {
    sheet.remove();
    document.body.classList.remove("printing");
  });
}

/** Where an interrupted session will pick up. */
function resumeNote(sum) {
  if (sum.finalPos) return `<p class="muted small center">최종 점검 ${sum.finalPos.done + 1}/${S.set.word_ids.length}부터 이어서 해요.</p>`;
  const p = sum.vocabPos;
  if (!p) return "";
  const st = STAGES.find((s) => s.key === p.stage);
  const groupNo = Math.floor(sum.wordsDone.length / GROUP) + 1;
  return `<p class="muted small center">${groupNo}묶음 · ${st?.label || ""} ${p.done + 1}/${p.groupIds.length}부터 이어서 해요.</p>`;
}

const isGrammar = (id) => S.passageById[id]?.qtype === GRAMMAR;
const isRelearn = (id) => (S.set.summary.relearnIds || []).includes(id);
function wordMix(s) {
  const m = s.word_ids.filter(isRelearn).length;
  return `새 단어 ${s.word_ids.length - m}개${m ? ` + 다시 배우기 ${m}개` : ""}`;
}

/** Progress row after studying a word in full today. Relearned words keep their history. */
function learnedRow(w, attempts) {
  const fresh = afterLearning(w.id, attempts, DAY);
  const prev = S.progressById[w.id];
  if (!prev || !isRelearn(w.id)) return fresh;
  return { ...fresh, learned_on: prev.learned_on, reps: prev.reps || 0, lapses: prev.lapses || 0, correct: prev.correct || 0, wrong: prev.wrong || 0 };
}
function readingSummary(s) {
  const g = s.passage_ids.filter(isGrammar).length;
  return `지문 ${s.passage_ids.length - g}개${g ? ` + 어법 ${g}문제` : ""}`;
}

function resultLine() {
  const r = S.set.summary.readingDone;
  const read = r.filter((x) => !isGrammar(x.id)), gram = r.filter((x) => isGrammar(x.id));
  return `<p>독해 ${read.filter((x) => x.correct).length} / ${read.length} 정답${gram.length ? ` · 어법 ${gram[0].correct ? "정답" : "오답"}` : ""}</p>
    <p class="muted small">내일 다시 만나요.</p>`;
}

// ───────────── review (old words) ─────────────
async function review() {
  const sum = S.set.summary;
  const queue = shuffle(S.set.review_ids.filter((id) => !sum.reviewsDone.includes(id)));
  for (let i = 0; i < queue.length; i++) {
    const w = S.wordById[queue[i]];
    const row = S.progressById[w.id];
    const kind = reviewStage(row);
    const t0 = Date.now();
    const ok = await ask(kind, w, `복습 ${i + 1} / ${queue.length}`, S.words);
    const ms = S.lastMs ?? Date.now() - t0;
    const next = afterReview(row, ok, ms, kind, DAY);
    S.progressById[w.id] = next;
    await db.saveProgress([next]);
    await db.logEvents([{ day: DAY, kind: "review", stage: kind, word_id: w.id, correct: ok, ms }]);
    if (!ok) await card(w, "다시 익히기", true);
    sum.reviewsDone.push(w.id);
    await saveSet();
  }
  home();
}

// ───────────── vocab (new words) ─────────────
async function vocab() {
  const sum = S.set.summary;
  const todays = S.set.word_ids.map((id) => S.wordById[id]);
  const groups = Math.ceil(todays.length / GROUP);
  for (;;) {
    const left = todays.filter((w) => !sum.wordsDone.includes(w.id));
    if (!left.length) break;
    // Auto-save: sum.vocabPos remembers the group, stage and question order after every answer,
    // so leaving mid-group and coming back continues from the same question.
    let pos = sum.vocabPos;
    const posOk = pos && pos.groupIds.every((id) => left.some((w) => w.id === id)) && STAGES.some((s) => s.key === pos.stage);
    if (!posOk) pos = null;
    const group = pos ? pos.groupIds.map((id) => S.wordById[id]) : left.slice(0, GROUP);
    const groupNo = Math.floor((todays.length - left.length) / GROUP) + 1;
    const startStage = pos ? STAGES.findIndex((s) => s.key === pos.stage) : 0;
    for (let si = startStage; si < STAGES.length; si++) {
      const st = STAGES[si];
      const resuming = pos && si === startStage;
      const save = (queue, tried, done) => {
        sum.vocabPos = { groupIds: group.map((w) => w.id), stage: st.key, queue: queue.map((w) => w.id), tried: [...tried], done };
        return saveSet();
      };
      if (st.key === "match") {
        // One game for the whole group: tap a word, then its meaning. (Restarts if left midway.)
        save(group, new Set(), 0);
        const res = await match(group, `${groupNo}/${groups}묶음 · ${st.label}`);
        await db.logEvents(group.map((w) => ({
          day: DAY, kind: "drill", stage: "match", word_id: w.id, correct: !res[w.id].mistakes, first_try: true, ms: res[w.id].ms,
        })));
        continue;
      }
      const queue = resuming ? pos.queue.map((id) => S.wordById[id]).filter(Boolean) : shuffle(group);
      const tried = new Set(resuming ? pos.tried : []);
      let done = resuming ? pos.done : 0;
      if (!resuming) save(queue, tried, done);
      while (queue.length) {
        const w = queue[0]; // stays first until answered, so a resumed session asks it again
        const label = `${groupNo}/${groups}묶음 · ${st.label} · ${done + 1}/${group.length}`;
        if (st.key === "card") {
          await card(w, label);
          queue.shift();
          done++;
          save(queue, tried, done);
          continue;
        }
        const t0 = Date.now();
        const ok = await ask(st.key, w, label, todays);
        await db.logEvents([{ day: DAY, kind: "drill", stage: st.key, word_id: w.id, correct: ok, first_try: !tried.has(w.id), ms: S.lastMs ?? Date.now() - t0 }]);
        queue.shift();
        tried.add(w.id);
        if (ok) done++;
        else queue.push(w);
        save(queue, tried, done);
      }
    }
    // Group finished: these words are now learned. The memory model uses all of today's answers
    // for them (also those from before a break), so the first review date is right.
    const todayDrills = (await db.events(DAY)).filter((e) => e.kind === "drill");
    const rows = group.map((w) => learnedRow(w, todayDrills.filter((e) => e.word_id === w.id)));
    rows.forEach((r) => (S.progressById[r.word_id] = r));
    await db.saveProgress(rows);
    sum.wordsDone.push(...group.map((w) => w.id));
    sum.vocabPos = null;
    await saveSet();
  }
  if (!sum.finalDone && todays.length) await finalCheck(todays);
  home();
}

/**
 * Final check: all of today's words once more, shuffled together and in harder forms.
 * Coming back to a word after working on the others is what makes the memory stick.
 * Wrong answers come back at the end until right. Then every word's memory is recomputed
 * from all of today's answers (the final check counts most).
 */
async function finalCheck(todays) {
  const sum = S.set.summary;
  // Auto-save: sum.finalPos keeps the remaining questions after every answer.
  const pos = sum.finalPos;
  let queue, tried, done;
  if (pos && pos.queue.every((q) => S.wordById[q.id])) {
    queue = pos.queue.map((q) => ({ w: S.wordById[q.id], kind: q.kind }));
    tried = new Set(pos.tried);
    done = pos.done;
  } else {
    await intro("최종 점검", `오늘 외운 ${todays.length}단어를 섞어서 한 번 더 확인해요.<br>틀린 단어는 맞힐 때까지 다시 나와요.`);
    queue = shuffle(todays).map((w, i) => ({ w, kind: FINAL_KINDS[i % FINAL_KINDS.length] }));
    tried = new Set();
    done = 0;
  }
  const save = () => {
    sum.finalPos = { queue: queue.map((q) => ({ id: q.w.id, kind: q.kind })), tried: [...tried], done };
    return saveSet();
  };
  save();
  while (queue.length) {
    const { w, kind } = queue[0];
    const t0 = Date.now();
    const ok = await ask(kind, w, `최종 점검 · ${done + 1}/${todays.length}`, todays);
    await db.logEvents([{
      day: DAY, kind: "drill", stage: `final:${kind}`, word_id: w.id, correct: ok, first_try: !tried.has(w.id), ms: S.lastMs ?? Date.now() - t0,
    }]);
    queue.shift();
    tried.add(w.id);
    if (ok) done++;
    else queue.push({ w, kind: FINAL_KINDS[(FINAL_KINDS.indexOf(kind) + 1) % FINAL_KINDS.length] });
    save();
  }
  sum.finalPos = null;
  const todayDrills = (await db.events(DAY)).filter((e) => e.kind === "drill");
  const rows = todays.map((w) => learnedRow(w, todayDrills.filter((e) => e.word_id === w.id)));
  rows.forEach((r) => (S.progressById[r.word_id] = r));
  await db.saveProgress(rows);
  sum.finalDone = true;
  S.set.vocab_done_at = new Date().toISOString();
  await saveSet();
}

function intro(title, text) {
  return new Promise((resolve) => {
    screen(`<div class="card center intro"><h2>${title}</h2><p>${text}</p></div>
      <button class="btn primary big" id="ok">시작</button>`);
    tap("#ok", () => resolve());
  });
}

/**
 * Matching game for one group: words on the left, meanings on the right.
 * Returns {wordId: {mistakes, ms}} — ms is the time from the previous match to this one.
 */
function match(group, label) {
  window.__quiz = { kind: "match", ids: group.map((w) => w.id) };
  return new Promise((resolve) => {
    const res = Object.fromEntries(group.map((w) => [w.id, { mistakes: 0, ms: 0 }]));
    const left = shuffle(group), right = shuffle(group);
    let pick = null, last = Date.now(), matched = 0;
    screen(`
      <div class="bar"><span>${label}</span><span class="muted small" id="timer">0초</span></div>
      <p class="muted small center">단어를 누르고, 알맞은 뜻을 누르세요</p>
      <div class="match">
        <div class="col">${left.map((w) => `<button class="tile word-tile" data-id="${esc(w.id)}">${esc(w.word)}</button>`).join("")}</div>
        <div class="col">${right.map((w) => `<button class="tile mean-tile" data-id="${esc(w.id)}">${esc(w.meaning)}</button>`).join("")}</div>
      </div>`);
    const start = Date.now();
    const timer = setInterval(() => {
      const el = $app.querySelector("#timer");
      if (el) el.textContent = `${Math.floor((Date.now() - start) / 1000)}초`;
    }, 500);
    tap(".word-tile", (el) => {
      if (el.disabled) return;
      $app.querySelectorAll(".word-tile").forEach((b) => b.classList.remove("picked"));
      el.classList.add("picked");
      pick = el.dataset.id;
      speak(S.wordById[pick].word);
    });
    tap(".mean-tile", (el) => {
      if (el.disabled || !pick) return;
      const wordEl = $app.querySelector(`.word-tile[data-id="${CSS.escape(pick)}"]`);
      if (el.dataset.id === pick) {
        res[pick].ms = Date.now() - last;
        last = Date.now();
        [el, wordEl].forEach((b) => { b.disabled = true; b.classList.remove("picked"); b.classList.add("right"); });
        pick = null;
        if (++matched === group.length) {
          clearInterval(timer);
          wait(500).then(() => resolve(res));
        }
      } else {
        res[pick].mistakes++;
        [el, wordEl].forEach((b) => b.classList.add("shake"));
        setTimeout(() => [el, wordEl].forEach((b) => b.classList.remove("shake")), 400);
      }
    });
  });
}

/** Study card. Resolves when the student taps "외웠어요". */
function card(w, label, isReview = false) {
  return new Promise((resolve) => {
    const ctx = contextOf(w);
    screen(`
      <div class="bar"><span>${label}</span></div>
      <div class="card word-card">
        <div class="word-head">
          <h2 class="word">${esc(w.word)}</h2>
          <button class="icon" id="say" aria-label="발음 듣기">🔊</button>
        </div>
        <div class="pos">${esc(w.pos)}${!isReview && isRelearn(w.id) ? ` <span class="badge">다시 배우기 · 예전에 외운 단어</span>` : ""}</div>
        <div class="meaning">${esc(w.meaning)}</div>
        ${w.root ? `<div class="root"><span class="tag">어원·연상</span> ${esc(w.root)}</div>` : ""}
        ${w.extra ? `<div class="muted small">${esc(w.extra)}</div>` : ""}
        ${w.synonyms?.length ? `<div class="small">비슷한 말: ${w.synonyms.map(esc).join(", ")}</div>` : ""}
        ${ctx ? `<div class="ex ctx"><div class="tag">오늘 지문</div>${ctx}</div>` : ""}
        ${w.examples.map((e) => `<div class="ex"><div>${showEx(e.en)}</div><div class="muted">${esc(e.ko)}</div></div>`).join("")}
      </div>
      <button class="btn primary big" id="ok">${isReview ? "다시 외웠어요" : "외웠어요"}</button>`);
    speak(w.word);
    tap("#say", () => speak(w.word));
    tap("#ok", () => resolve());
  });
}

/** The sentence from a passage that holds this word, with the word bold. */
function contextOf(w) {
  for (const pid of S.set.passage_ids) {
    const pw = S.passageById[pid]?.words.find((x) => x.id === w.id);
    if (pw?.context) return showEx(pw.context);
  }
  return "";
}
function contextRaw(w) {
  for (const pid of S.set.passage_ids) {
    const pw = S.passageById[pid]?.words.find((x) => x.id === w.id);
    if (pw?.context) return pw.context;
  }
  return null;
}

/** One quiz item. Resolves true/false. */
function ask(kind, w, label, pool) {
  window.__quiz = { kind, id: w.id, word: w.word }; // test hook for automated walkthroughs
  const shown = Date.now();
  S.lastMs = null;
  const answered = () => (S.lastMs = Date.now() - shown); // answer time, without feedback time
  return new Promise((resolve) => {
    let prompt = "", options = [], answer = "", mode = "choice", onShow = null;
    const ex0 = w.examples[0], ex1 = w.examples[1] || w.examples[0];
    const singleSyns = (x) => (x.synonyms || []).filter((s) => !s.includes(" "));
    // Fall back when a form can't be shown for this word / device.
    if (kind === "listen" && !HAS_TTS) kind = "meaning";
    if (kind === "dictation" && !HAS_TTS) kind = "spell";
    if (kind === "synonym" && !singleSyns(w).length) kind = "word";
    if (kind === "listen") {
      prompt = `<button class="say-big" id="say" aria-label="다시 듣기">🔊</button><div class="muted">듣고 알맞은 뜻을 고르세요</div>`;
      options = shuffle([w, ...others(w, 3, pool.length >= 4 ? pool : S.words)]).map((x) => ({ v: x.id, t: x.meaning }));
      answer = w.id;
      onShow = () => { speak(w.word); tap("#say", () => speak(w.word)); };
    } else if (kind === "synonym") {
      const mine = singleSyns(w);
      const target = mine[Math.floor(Math.random() * mine.length)];
      const taken = new Set([...mine, w.word].map((s) => s.toLowerCase()));
      const distract = [];
      for (const x of others(w, 40, S.words)) {
        const s = singleSyns(x).find((y) => !taken.has(y.toLowerCase()));
        if (s && !(x.synonyms || []).some((y) => taken.has(y.toLowerCase()))) { distract.push({ v: x.id, t: s }); taken.add(s.toLowerCase()); }
        if (distract.length === 3) break;
      }
      prompt = `<div class="q-word">${esc(w.word)}</div><div class="muted">뜻이 가장 비슷한 단어를 고르세요</div>`;
      options = shuffle([{ v: w.id, t: target }, ...distract]);
      answer = w.id;
    } else if (kind === "usage") {
      mode = "usage";
    } else if (kind === "recall") {
      mode = "recall";
    } else if (kind === "dictation") {
      mode = "dictation";
    } else if (kind === "meaning" || (kind === "context" && !contextRaw(w))) {
      prompt = `<div class="q-word">${esc(w.word)}</div><div class="muted">알맞은 뜻을 고르세요</div>`;
      options = shuffle([w, ...others(w, 3, pool.length >= 4 ? pool : S.words)]).map((x) => ({ v: x.id, t: x.meaning }));
      answer = w.id;
    } else if (kind === "word") {
      prompt = `<div class="q-mean">${esc(w.meaning)}</div><div class="muted">알맞은 단어를 고르세요</div>`;
      options = shuffle([w, ...others(w, 3, pool.length >= 4 ? pool : S.words)]).map((x) => ({ v: x.id, t: x.word }));
      answer = w.id;
    } else if (kind === "cloze") {
      prompt = `<div class="q-sent">${clozeEx(ex0.en)}</div><div class="muted">${esc(ex0.ko)}</div>`;
      const opts = [w, ...others(w, 3, pool.length >= 4 ? pool : S.words)];
      options = shuffle(opts).map((x) => ({ v: x.id, t: x.id === w.id ? surfaceOf(ex0.en) : surfaceOf(x.examples[0].en) || x.word }));
      answer = w.id;
    } else if (kind === "context") {
      prompt = `<div class="q-sent">${showEx(contextRaw(w))}</div><div class="muted">지문에서 <b>${esc(w.word)}</b>의 뜻은?</div>`;
      options = shuffle([w, ...others(w, 3, pool.length >= 4 ? pool : S.words)]).map((x) => ({ v: x.id, t: x.meaning }));
      answer = w.id;
    } else if (kind === "translate") {
      mode = "self";
    } else if (kind === "spell") {
      mode = "spell";
    }

    if (mode === "choice") {
      screen(`
        <div class="bar"><span>${label}</span></div>
        <div class="card q">${prompt}</div>
        <div class="options">${options.map((o, i) => `<button class="opt" data-v="${esc(o.v)}"><span class="n">${i + 1}</span>${esc(o.t)}</button>`).join("")}</div>
        <div id="fb"></div>`);
      onShow?.();
      tap(".opt", async (el) => {
        answered();
        const ok = el.dataset.v === answer;
        $app.querySelectorAll(".opt").forEach((b) => {
          b.disabled = true;
          if (b.dataset.v === answer) b.classList.add("right");
        });
        if (!ok) el.classList.add("wrong");
        speak(w.word);
        await feedback(ok, w);
        resolve(ok);
      });
    } else if (mode === "recall") {
      // Retrieve first, then check: say the meaning to yourself before seeing it.
      screen(`
        <div class="bar"><span>${label}</span></div>
        <div class="card q">
          <div class="q-word">${esc(w.word)} <button class="icon" id="say" aria-label="발음 듣기">🔊</button></div>
          <div class="muted">뜻을 소리 내어 말해 보고 확인하세요</div>
          <div id="ans" class="ko hidden">
            <div class="meaning">${esc(w.meaning)}</div>
            ${w.root ? `<div class="root small">${esc(w.root)}</div>` : ""}
          </div>
        </div>
        <button class="btn big" id="reveal">뜻 확인</button>
        <div id="judge" class="row hidden">
          <button class="btn good" id="yes">떠올렸어요</button>
          <button class="btn bad" id="no">몰랐어요</button>
        </div>`);
      speak(w.word);
      tap("#say", () => speak(w.word));
      tap("#reveal", (el) => {
        answered();
        el.classList.add("hidden");
        $app.querySelector("#ans").classList.remove("hidden");
        $app.querySelector("#judge").classList.remove("hidden");
      });
      tap("#yes", () => resolve(true));
      tap("#no", () => resolve(false)); // the meaning is already on screen; it comes back later
    } else if (mode === "usage") {
      // Is the word used correctly here? Half the time the sentence is really another word's
      // example with this word swapped in.
      const good = Math.random() < 0.5;
      const syns = new Set((w.synonyms || []).map((s) => s.toLowerCase()));
      const other = others(w, 10, pool.length >= 4 ? pool : S.words).find(
        (x) => !syns.has(x.word.toLowerCase()) && !(x.synonyms || []).some((s) => s.toLowerCase() === w.word.toLowerCase())
      );
      const sentence = good || !other ? ex1.en : other.examples[0].en.replace(/\[[^\]]+\]/, `[${w.word}]`);
      const isGood = good || !other;
      window.__quiz.good = isGood;
      screen(`
        <div class="bar"><span>${label}</span></div>
        <div class="card q">
          <div class="muted">밑줄 친 단어가 이 문장에 알맞게 쓰였나요?</div>
          <div class="q-sent usage">${showEx(sentence)}</div>
        </div>
        <div class="row" id="ox">
          <button class="btn good" data-a="o">알맞아요</button>
          <button class="btn bad" data-a="x">어색해요</button>
        </div>
        <div id="fb"></div>`);
      tap("#ox .btn", async (el) => {
        if (el.disabled) return;
        answered();
        $app.querySelectorAll("#ox .btn").forEach((b) => (b.disabled = true));
        const ok = (el.dataset.a === "o") === isGood;
        const fb = $app.querySelector("#fb");
        fb.innerHTML = `
          <div class="fb ${ok ? "good" : "bad"}">${ok ? "정답!" : "오답"} · ${isGood ? "알맞게 쓰인 문장이에요" : `어색한 문장이에요. <b>${esc(w.word)}</b> = ${esc(w.meaning)}`}
            ${isGood ? `<div class="small">${esc(ex1.ko)}</div>` : `<div class="small">바르게 쓴 예: ${showEx(ex1.en)}<br>${esc(ex1.ko)}</div>`}
          </div>
          <button class="btn big" id="next">다음</button>`;
        speak(w.word);
        fb.querySelector("#next").addEventListener("click", () => resolve(ok));
      });
    } else if (mode === "dictation") {
      screen(`
        <div class="bar"><span>${label}</span></div>
        <div class="card q">
          <button class="say-big" id="say" aria-label="다시 듣기">🔊</button>
          <div class="muted">듣고 단어를 쓰세요</div>
          <div class="small">뜻: ${esc(w.meaning)} · ${w.word.length}글자</div>
        </div>
        <form id="f" class="spell">
          <input id="in" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="들은 단어" />
          <button class="btn primary">확인</button>
        </form>
        <div id="fb"></div>`);
      speak(w.word);
      tap("#say", () => speak(w.word));
      const input = $app.querySelector("#in");
      input.focus();
      $app.querySelector("#f").addEventListener("submit", async (e) => {
        e.preventDefault();
        const v = input.value.trim().toLowerCase();
        if (!v) return;
        answered();
        const ok = v === w.word.toLowerCase();
        input.disabled = true;
        await feedback(ok, w, true);
        resolve(ok);
      });
    } else if (mode === "self") {
      screen(`
        <div class="bar"><span>${label}</span></div>
        <div class="card q">
          <div class="muted">머릿속으로 해석해 보고 확인하세요</div>
          <div class="q-sent">${showEx(ex1.en)}</div>
          <div id="ko" class="ko hidden">${esc(ex1.ko)}</div>
        </div>
        <button class="btn big" id="reveal">해석 보기</button>
        <div id="judge" class="row hidden">
          <button class="btn good" id="yes">맞게 해석했어요</button>
          <button class="btn bad" id="no">틀렸어요</button>
        </div>`);
      tap("#reveal", (el) => {
        answered(); // time to come up with a translation
        el.classList.add("hidden");
        $app.querySelector("#ko").classList.remove("hidden");
        $app.querySelector("#judge").classList.remove("hidden");
        speak(ex1.en.replace(/[\[\]]/g, ""));
      });
      tap("#yes", () => resolve(true));
      tap("#no", async () => {
        await feedback(false, w);
        resolve(false);
      });
    } else {
      const surf = surfaceOf(ex0.en);
      screen(`
        <div class="bar"><span>${label}</span></div>
        <div class="card q">
          <div class="q-mean">${esc(w.meaning)}</div>
          <div class="q-sent">${clozeEx(ex0.en)}</div>
          <div class="muted small">힌트: ${esc(w.word[0])}로 시작 · ${w.word.length}글자 (기본형 또는 문장 속 형태)</div>
        </div>
        <form id="f" class="spell">
          <input id="in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="단어를 쓰세요" />
          <button class="btn primary">확인</button>
        </form>
        <div id="fb"></div>`);
      const input = $app.querySelector("#in");
      input.focus();
      $app.querySelector("#f").addEventListener("submit", async (e) => {
        e.preventDefault();
        const v = input.value.trim().toLowerCase();
        if (!v) return;
        answered();
        const ok = v === w.word.toLowerCase() || v === surf.toLowerCase();
        input.disabled = true;
        speak(w.word);
        await feedback(ok, w, true);
        resolve(ok);
      });
    }
  });
}

function feedback(ok, w, showWord = false) {
  return new Promise((resolve) => {
    const fb = $app.querySelector("#fb") || $app.appendChild(document.createElement("div"));
    fb.innerHTML = ok
      ? `<div class="fb good">정답!</div>`
      : `<div class="fb bad">오답 · <b>${esc(w.word)}</b> = ${esc(w.meaning)}<div class="small">이 단어는 잠시 뒤에 다시 나와요.</div></div>
         <button class="btn big" id="next">다음</button>`;
    if (ok) wait(showWord ? 700 : 450).then(resolve);
    else fb.querySelector("#next").addEventListener("click", resolve);
  });
}

// ───────────── reading ─────────────
async function reading() {
  const sum = S.set.summary;
  const ids = S.set.passage_ids.filter((id) => !sum.readingDone.find((r) => r.id === id));
  for (const id of ids) {
    const p = S.passageById[id];
    const readIds = S.set.passage_ids.filter((x) => !isGrammar(x));
    const label = isGrammar(id) ? "오늘의 어법" : `독해 ${readIds.indexOf(id) + 1} / ${readIds.length}`;
    const results = await readPassage(p, label);
    for (const r of results) sum.readingDone.push(r);
    await saveSet();
  }
  if (!S.set.reading_done_at) await finishDay();
  home();
}

function renderBody(p) {
  // Today's words in the passage: tap to see the meaning.
  let html = esc(p.body)
    .replace(/\{u\}/g, "<u>").replace(/\{\/u\}/g, "</u>")
    .replace(/_{3,}/g, '<span class="blank wide">　　　　　　</span>')
    .split(/\n{2,}/).map((x) => `<p>${x.replace(/\n/g, "<br>")}</p>`).join("");
  const today = new Set(S.set.word_ids);
  for (const pw of p.words) {
    if (!today.has(pw.id) || !pw.surface) continue;
    const re = new RegExp(`\\b(${pw.surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`);
    html = html.replace(re, `<span class="hl" data-w="${esc(pw.id)}">$1</span>`);
  }
  return html;
}

function readPassage(p, label) {
  return new Promise((resolve) => {
    const results = [];
    const t0 = Date.now();
    const qs = p.questions;
    const chosen = {};
    screen(`
      <div class="bar"><span>${label}</span><span class="muted small">${esc(p.qtype)}</span></div>
      <div class="card passage">
        <div class="instr">${esc(p.instruction)}</div>
        ${p.box ? `<div class="given">${esc(p.box).replace(/\n/g, "<br>")}</div>` : ""}
        <div class="body">${renderBody(p)}</div>
        ${p.glossary.length ? `<div class="gloss">${p.glossary.map((g) => `<span>* ${esc(g)}</span>`).join("")}</div>` : ""}
      </div>
      ${qs.map((q, qi) => `
        <div class="card qblock" data-q="${qi}">
          ${qs.length > 1 ? `<div class="instr">${esc(q.stem || "")}</div>` : ""}
          ${q.choices.every((c) => CIRCLED.includes(c.trim()))
            ? `<div class="choices nums">${q.choices.map((c, i) => `<button class="opt choice num" data-q="${qi}" data-i="${i + 1}">${CIRCLED[i]}</button>`).join("")}</div>`
            : `<div class="choices">${q.choices.map((c, i) => `<button class="opt choice" data-q="${qi}" data-i="${i + 1}"><span class="n">${CIRCLED[i]}</span>${esc(c)}</button>`).join("")}</div>`}
          <div class="fb-slot"></div>
        </div>`).join("")}
      <button class="btn primary big" id="submit" disabled>채점하기</button>
      <div id="pop" class="pop hidden"></div>`);

    tap(".hl", (el) => {
      const w = S.wordById[el.dataset.w];
      const pop = $app.querySelector("#pop");
      pop.innerHTML = `<b>${esc(w.word)}</b> ${esc(w.meaning)}`;
      pop.classList.remove("hidden");
      setTimeout(() => pop.classList.add("hidden"), 2200);
    });
    tap(".choice", (el) => {
      if (el.disabled) return;
      const qi = el.dataset.q;
      $app.querySelectorAll(`.choice[data-q="${qi}"]`).forEach((b) => b.classList.remove("picked"));
      el.classList.add("picked");
      chosen[qi] = Number(el.dataset.i);
      $app.querySelector("#submit").disabled = Object.keys(chosen).length < qs.length;
    });
    tap("#submit", async (btn) => {
      btn.remove();
      const ms = Date.now() - t0;
      const ev = [];
      qs.forEach((q, qi) => {
        const pick = chosen[qi];
        const ok = pick === q.answer;
        $app.querySelectorAll(`.choice[data-q="${qi}"]`).forEach((b) => {
          b.disabled = true;
          if (Number(b.dataset.i) === q.answer) b.classList.add("right");
          else if (Number(b.dataset.i) === pick) b.classList.add("wrong");
        });
        $app.querySelector(`.qblock[data-q="${qi}"] .fb-slot`).innerHTML = `
          <div class="fb ${ok ? "good" : "bad"}">${ok ? "정답!" : `오답 · 정답은 ${CIRCLED[q.answer - 1]}`}</div>
          ${q.point ? `<div class="point">어법 포인트 · <b>${esc(q.point)}</b></div>` : ""}
          <details class="expl" ${ok && !q.point ? "" : "open"}><summary>풀이 보기</summary><p>${esc(q.explanation)}</p></details>`;
        results.push({ id: p.id, qnum: q.qnum, pick, answer: q.answer, correct: ok, ms });
        ev.push({ day: DAY, kind: "reading", passage_id: p.id, qnum: q.qnum, correct: ok, answer: String(pick), ms });
      });
      await db.logEvents(ev);
      const next = document.createElement("button");
      next.className = "btn primary big";
      next.textContent = "다음";
      next.onclick = () => resolve(results);
      $app.appendChild(next);
    });
  });
}

async function finishDay() {
  const sum = S.set.summary;
  const evs = (await db.events(DAY)).filter((e) => e.kind === "drill" && e.first_try);
  const stats = {
    // Passage level follows the reading passages only; grammar is tracked on its own.
    readingCorrect: sum.readingDone.filter((r) => r.correct && !isGrammar(r.id)).length,
    readingTotal: sum.readingDone.filter((r) => !isGrammar(r.id)).length,
    wordFirstTry: evs.filter((e) => e.correct).length,
    wordTotal: evs.length,
  };
  const lv = nextLevels(S.state, stats);
  sum.stats = { ...stats, levelAfter: lv.level, wordLevelAfter: lv.word_level };
  S.set.reading_done_at = new Date().toISOString();
  S.state = { ...S.state, ...lv };
  await db.saveState(S.state);
  await saveSet();
}

load().catch((e) => {
  console.error(e);
  screen(`<div class="card"><h2>불러오지 못했어요</h2><p class="muted small">${esc(e.message)}</p>
    <button class="btn" onclick="location.reload()">다시 시도</button></div>`);
});
