import { db, today, addDays, REMOTE } from "./db.js";
import { planDay, nextLevels, GRAMMAR } from "./planner.js";
import { afterLearning, afterReview, afterExtraReview, reviewStage, recall, MASTERED_DAYS } from "./memory.js";

const $app = document.getElementById("app");
const DAY = new URLSearchParams(location.search).get("day") || today(); // ?day= for testing

// Stages every new word goes through, in order (10 words per group, 2 groups a day):
// learn → recall → match → fill the blank, and for words with several important meanings, one
// question per meaning. A wrong answer sends the item to the back of that stage's queue, so a
// stage ends only when every item is answered right.
// After both groups, a mixed final check (listening, synonym, word choice) brings all of today's
// words back once; a word missed there comes back one more time only.
// The harder "find the awkward sentence" question (usage) is kept for review sessions only.
const STAGES = [
  { key: "card", label: "익히기" },
  { key: "recall", label: "떠올리기" },
  { key: "match", label: "짝 맞추기" },
  { key: "cloze", label: "빈칸 채우기" },
  { key: "sense", label: "여러 뜻 구별" }, // only words that have senses
];
const FINAL_KINDS = ["listen", "synonym", "word"]; // mixed retrieval for the final check
const GROUP = 10;
const MATCH_SIZE = 5; // pairs per matching board
const hasSenses = (w) => (w.senses || []).length >= 2;
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
  S = { words, passages, progress, state, events, allDaily };
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
  // Weekend: the weekly word test comes right after the review, until it is finished.
  const testOn = testOpen();
  const T = testOn ? testHost()?.summary.weekly : null; // started, not finished
  const testLeft = testOn ? 1 : 0;
  const next = reviewsLeft ? "review" : testLeft ? "test" : wordsLeft ? "vocab" : readLeft ? "reading" : analysisLeft ? "analysis" : null;
  let n = 0; // step numbers shift on test days
  const extraLeft = reviewsLeft ? 0 : extraCandidates().length; // optional extra review after the regular one
  screen(`
    <header class="top"><h1>오늘의 영어</h1><span class="muted">${DAY} · <a href="index.html${location.search}">과목 선택</a></span></header>
    ${REMOTE ? "" : `<p class="note">로컬 테스트 모드입니다. 기록은 이 기기에만 저장됩니다.</p>`}
    <ol class="steps">
      ${step(++n, "복습", s.review_ids.length ? `예전에 외운 단어 ${s.review_ids.length}개 확인` : "오늘은 복습할 단어가 없어요", !reviewsLeft, next === "review")}
      ${testOn ? step(++n, "주간 테스트", `이번 주 단어 ${T?.ids.length || weeklyPick().length}문제 · 객관식${T?.results.length ? ` · ${T.results.length}문제 풀었음` : ""} · ${testWeek() === DAY ? "내일(일요일)까지" : "오늘까지"}`, false, next === "test") : ""}
      ${step(++n, "단어 외우기", groupsLeft ? `${wordMix(s)} · 남은 단어 ${groupsLeft}개 · 마지막에 최종 점검` : !s.word_ids.length ? "오늘은 새 단어가 없어요 (지난 지문 복습일)" : sum.finalDone ? `${wordMix(s)} 완료` : "최종 점검만 남았어요", !wordsLeft, next === "vocab")}
      ${step(++n, "독해 + 어법", `${readingSummary(s)} · 남은 문제 ${readLeft}개`, !readLeft, next === "reading")}
      ${step(++n, "지문 분석", sum.analysis ? `제출 완료 · ${esc(S.passageById[sum.analysis.passage_id]?.source || "")}` : "오늘 지문 하나를 분석해서 PDF로 제출", !analysisLeft, next === "analysis")}
    </ol>
    ${
      next
        ? `<button class="btn primary big" id="go">${sum.wordsDone.length || sum.reviewsDone.length || sum.vocabPos || sum.finalPos || sum.readingDone.length || T?.results.length ? "이어서 하기" : "시작하기"}</button>
           ${resumeNote(sum)}`
        : `<div class="card center"><h2>오늘 학습 완료!</h2>${resultLine()}</div>`
    }
    ${extraLeft ? `<button class="btn big" id="extra">더 복습하기 · 기억이 약한 단어 ${Math.min(EXTRA_BATCH, extraLeft)}개</button>
       <p class="muted small center">원할 때만 하는 추가 복습이에요. 틀린 단어는 복습 날짜가 앞당겨져요.</p>` : ""}`);
  tap("#go", () => (next === "review" ? review() : next === "test" ? weeklyTest() : next === "vocab" ? vocab() : next === "reading" ? reading() : analysis()));
  tap("#extra", () => extraReview());
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
  // Each item is either still in the queue or done, so done + queue = the stage's question count.
  const total = (p.done || 0) + (Array.isArray(p.queue) ? p.queue.length : 0);
  const where = total ? ` ${(p.done || 0) + 1}/${total}` : "";
  return `<p class="muted small center">${groupNo}묶음 · ${st?.label || ""}${where}부터 이어서 해요.</p>`;
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

// ───────────── extra review (optional, not-yet-due words) ─────────────
const EXTRA_BATCH = 10;

/** Learned words not due today and not checked today, weakest memory first. */
function extraCandidates() {
  const sum = S.set.summary;
  const skip = new Set([...S.set.review_ids, ...S.set.word_ids, ...(sum.extraDone || [])]);
  return Object.values(S.progressById)
    .filter((p) => p.learned_on && p.learned_on < DAY && !skip.has(p.word_id) && S.wordById[p.word_id] && (p.stability ?? 0) < MASTERED_DAYS)
    .sort((a, b) => recall(a, DAY) - recall(b, DAY));
}

async function extraReview() {
  const sum = S.set.summary;
  const queue = extraCandidates().slice(0, EXTRA_BATCH).map((p) => p.word_id);
  for (let i = 0; i < queue.length; i++) {
    const w = S.wordById[queue[i]];
    const row = S.progressById[w.id];
    const kind = reviewStage(row);
    const t0 = Date.now();
    const ok = await ask(kind, w, `더 복습하기 ${i + 1} / ${queue.length}`, S.words);
    const ms = S.lastMs ?? Date.now() - t0;
    const next = afterExtraReview(row, ok, ms, kind, DAY);
    S.progressById[w.id] = next;
    await db.saveProgress([next]);
    await db.logEvents([{ day: DAY, kind: "review", stage: kind, word_id: w.id, correct: ok, ms }]);
    if (!ok) await card(w, "다시 익히기", true);
    (sum.extraDone ||= []).push(w.id);
    await saveSet();
  }
  home();
}

// ───────────── weekly test (Saturdays) ─────────────
// All choice questions, mixed types, no feedback until the end. Which words, and how many,
// comes from this week's record: every word that showed weakness, plus a sample of the rest.
const TEST_MIN = 30, TEST_MAX = 60, TEST_STRONG_SHARE = 0.3;
const TEST_KINDS = ["meaning", "word", "cloze", "synonym", "sense", "listen", "usage"];
const TEST_KO = { meaning: "뜻 고르기", word: "단어 고르기", cloze: "빈칸", synonym: "유의어", sense: "여러 뜻", listen: "듣고 뜻", usage: "어색한 문장" };
// Open on Saturday, and on Sunday if it wasn't finished on Saturday. Gone once finished.
/** The Saturday of this test weekend, or null on weekdays. */
function testWeek() {
  const dow = new Date(DAY + "T00:00:00Z").getUTCDay();
  return dow === 6 ? DAY : dow === 0 ? addDays(DAY, -1) : null;
}
/** The daily set that holds this weekend's test (started Saturday → Saturday's set), or null. */
function testHost() {
  const sat = testWeek();
  if (!sat) return null;
  if (S.set.summary.weekly) return S.set;
  if (DAY !== sat) return (S.allDaily || []).find((d) => d.day === sat && d.summary?.weekly) || null;
  return null;
}
/** Is the weekly test still to do this weekend? */
function testOpen() {
  if (!testWeek()) return false;
  const host = testHost();
  return host ? !host.summary.weekly.done : weeklyPick().length > 0;
}
const saveHost = (host) =>
  host === S.set ? saveSet() : (saving = saving.then(() => db.saveDaily(JSON.parse(JSON.stringify(host)))).catch((e) => console.error("save failed", e)));

/** This week's test words (learned in the 7 days before the test Saturday), weakest first. */
function weeklyPick() {
  const sat = testWeek() || DAY;
  const from = addDays(sat, -7), to = addDays(sat, -1);
  const wrong = {};
  for (const e of S.events || [])
    if (e.day >= from && e.day <= to && e.word_id && (e.kind === "review" || (e.kind === "drill" && e.first_try)) && !e.correct)
      wrong[e.word_id] = (wrong[e.word_id] || 0) + 1;
  const rows = Object.values(S.progressById).filter((p) => p.learned_on >= from && p.learned_on <= to && S.wordById[p.word_id]);
  const scored = rows.map((p) => {
    const R = recall(p, DAY), q = p.drill_score ?? 0.7, lapses = p.lapses || 0, wr = wrong[p.word_id] || 0;
    return {
      id: p.word_id,
      weak: R < 0.9 || lapses > 0 || q < 0.75 || wr >= 2,
      score: (1 - R) * 3 + lapses * 0.8 + (1 - q) * 2 + Math.min(3, wr) * 0.5,
    };
  });
  const weak = scored.filter((x) => x.weak).sort((a, b) => b.score - a.score);
  const strong = shuffle(scored.filter((x) => !x.weak));
  const n = Math.min(scored.length, TEST_MAX, Math.max(TEST_MIN, weak.length + Math.ceil(strong.length * TEST_STRONG_SHARE)));
  return [...weak, ...strong].slice(0, n).map((x) => x.id);
}

/** Spread the question types evenly, skipping ones a word can't take. */
function testKinds(ids) {
  let k = 0;
  return ids.map((id) => {
    const w = S.wordById[id];
    for (let tries = 0; tries < TEST_KINDS.length; tries++) {
      const kind = TEST_KINDS[k++ % TEST_KINDS.length];
      if (kind === "sense" && !hasSenses(w)) continue;
      if (kind === "synonym" && !(w.synonyms || []).some((s) => !s.includes(" "))) continue;
      if (kind === "listen" && !HAS_TTS) continue;
      return kind;
    }
    return "meaning";
  });
}

async function weeklyTest() {
  let host = testHost();
  if (!host) {
    host = S.set;
    const ids = shuffle(weeklyPick());
    host.summary.weekly = { week: testWeek(), ids, kinds: testKinds(ids), results: [], done: false };
    await saveHost(host);
  }
  const T = host.summary.weekly;
  if (!T.results.length)
    await intro("주간 테스트", `이번 주에 배운 단어 ${T.ids.length}문제예요. 모두 객관식이고,<br>정답과 해설은 다 푼 뒤에 한꺼번에 보여 줘요.`);
  const pool = T.ids.map((id) => S.wordById[id]);
  S.testMode = true;
  try {
    for (let i = T.results.length; i < T.ids.length; i++) {
      const w = S.wordById[T.ids[i]];
      const kind = T.kinds[i];
      const t0 = Date.now();
      S.lastPick = null;
      const ok = await ask(kind, w, `주간 테스트 · ${i + 1} / ${T.ids.length}`, pool.length >= 4 ? pool : S.words);
      const ms = S.lastMs ?? Date.now() - t0;
      // A miss counts as a lapse (the word comes back sooner); a right answer leaves the schedule.
      const row = S.progressById[w.id];
      if (row) {
        const next = afterExtraReview(row, ok, ms, kind, DAY);
        S.progressById[w.id] = next;
        await db.saveProgress([next]);
      }
      await db.logEvents([{ day: DAY, kind: "test", stage: kind, word_id: w.id, correct: ok, ms }]);
      T.results.push({ id: w.id, kind: kind === "listen" && !HAS_TTS ? "meaning" : kind, ok, picked: S.lastPick?.picked ?? null, right: S.lastPick?.right ?? null });
      await saveHost(host);
    }
  } finally {
    S.testMode = false;
  }
  T.done = true;
  T.finished_on = DAY;
  T.score = T.results.filter((r) => r.ok).length;
  await saveHost(host);
  testResults(T);
}

function testResults(T) {
  const total = T.results.length, right = T.results.filter((r) => r.ok).length;
  const byKind = {};
  for (const r of T.results) {
    const k = (byKind[r.kind] ||= { n: 0, ok: 0 });
    k.n++;
    if (r.ok) k.ok++;
  }
  const wrong = T.results.filter((r) => !r.ok);
  screen(`
    <div class="bar"><span>주간 테스트 결과</span></div>
    <div class="card center">
      <div class="q-word">${right} / ${total}</div>
      <div class="muted">정답률 ${total ? Math.round((right / total) * 100) : 0}%</div>
    </div>
    <div class="card">
      <div class="tag">유형별</div>
      ${Object.entries(byKind).map(([k, v]) => `<div class="row-line">${TEST_KO[k] || k} <b>${v.ok}/${v.n}</b></div>`).join("")}
    </div>
    ${wrong.length ? `<div class="card explain">
      <div class="ex-head">틀린 단어 ${wrong.length}개 · 다음 주 복습에 더 자주 나와요</div>
      <ul class="why">${wrong.map((r) => {
        const w = S.wordById[r.id];
        return `<li class="x"><span class="mk">✗</span><span><b>${esc(w.word)}</b> ${esc(w.meaning)}
          <br><span class="small">${TEST_KO[r.kind] || r.kind}${r.picked ? ` · 고른 답: ${esc(r.picked)}` : ""}${r.right ? ` · 정답: ${esc(r.right)}` : ""}</span></span></li>`;
      }).join("")}</ul></div>` : `<div class="card center">모두 맞혔어요! 🎉</div>`}
    <button class="btn primary big" id="home">홈으로</button>`);
  tap("#home", () => home());
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
        // queue holds item strings ("wordId" or "wordId#meaning"), saved as they are
        sum.vocabPos = { groupIds: group.map((w) => w.id), stage: st.key, queue: [...queue], tried: [...tried], done };
        return saveSet();
      };
      if (st.key === "match") {
        // Matching boards of 5 pairs: tap a word, then its meaning. (Restarts if left midway.)
        save([], new Set(), 0);
        const boards = Math.ceil(group.length / MATCH_SIZE);
        for (let b = 0; b < boards; b++) {
          const part = group.slice(b * MATCH_SIZE, (b + 1) * MATCH_SIZE);
          const res = await match(part, `${groupNo}/${groups}묶음 · ${st.label}${boards > 1 ? ` ${b + 1}/${boards}` : ""}`);
          await db.logEvents(part.map((w) => ({
            day: DAY, kind: "drill", stage: "match", word_id: w.id, correct: !res[w.id].mistakes, first_try: true, ms: res[w.id].ms,
          })));
        }
        continue;
      }
      // Queue items are word ids; for the sense stage, "wordId#meaningIndex" (one item per meaning).
      const items = st.key === "sense"
        ? group.filter(hasSenses).flatMap((w) => w.senses.map((_, i) => `${w.id}#${i}`))
        : group.map((w) => w.id);
      if (!items.length) continue;
      // A saved queue must hold only this stage's items; anything else (e.g. a damaged save)
      // restarts the stage instead of failing.
      const valid = resuming && Array.isArray(pos.queue) && pos.queue.every((id) => typeof id === "string" && items.includes(id));
      const queue = valid ? [...pos.queue] : shuffle(items);
      const tried = new Set(valid ? pos.tried || [] : []);
      let done = valid ? Math.min(pos.done || 0, items.length - queue.length) : 0;
      if (!valid) save(queue, tried, done);
      while (queue.length) {
        const item = queue[0]; // stays first until answered, so a resumed session asks it again
        const [wid, senseIdx] = item.split("#");
        const w = S.wordById[wid];
        const label = `${groupNo}/${groups}묶음 · ${st.label} · ${done + 1}/${items.length}`;
        if (st.key === "card") {
          await card(w, label);
          queue.shift();
          done++;
          save(queue, tried, done);
          continue;
        }
        const t0 = Date.now();
        const ok = await ask(st.key, w, label, todays, senseIdx === undefined ? undefined : Number(senseIdx));
        await db.logEvents([{ day: DAY, kind: "drill", stage: st.key, word_id: w.id, correct: ok, first_try: !tried.has(item), ms: S.lastMs ?? Date.now() - t0 }]);
        queue.shift();
        tried.add(item);
        if (ok) done++;
        else queue.push(item);
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
    await intro("최종 점검", `오늘 외운 ${todays.length}단어를 섞어서 한 번 더 확인해요.<br>틀린 단어는 마지막에 한 번 더 나와요.`);
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
    if (ok || tried.has(`again:${w.id}`)) done++; // a word missed twice moves on (less repetition)
    else {
      tried.add(`again:${w.id}`);
      queue.push({ w, kind: FINAL_KINDS[(FINAL_KINDS.indexOf(kind) + 1) % FINAL_KINDS.length] });
    }
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
        ${w.synonyms?.length ? `<div class="syns small"><span class="tag">비슷한 말</span> ${w.synonyms.map((s) => synLabel(w, s)).join(" · ")}</div>` : ""}
        ${ctx ? `<div class="ex ctx"><div class="tag">오늘 지문</div>${ctx}</div>` : ""}
        ${hasSenses(w)
          ? `<div class="senses"><div class="tag">뜻이 여러 개예요 · 뜻마다 예문으로 익히세요</div>
              ${w.senses.map((s, i) => `<div class="ex"><div><b class="sn">${i + 1}</b> <b>${esc(s.m)}</b></div><div>${showEx(s.en)}</div><div class="muted">${esc(s.ko)}</div></div>`).join("")}</div>`
          : w.examples.map((e) => `<div class="ex"><div>${showEx(e.en)}</div><div class="muted">${esc(e.ko)}</div></div>`).join("")}
      </div>
      <button class="btn primary big" id="ok">${isReview ? "다시 외웠어요" : "외웠어요"}</button>`);
    speak(w.word);
    tap("#say", () => speak(w.word));
    tap("#ok", () => resolve());
  });
}

/** The sentence from a passage that holds this word, with the word bold. */
/** Word w in the same inflection as `surface` (a form of `base`): -s, -ed, -ing, or as is. */
function inflectLike(w, surface, base) {
  const s = surface.toLowerCase(), b = base.toLowerCase(), word = w.word;
  if (s === b || word.includes(" ")) return word;
  const own = [...w.examples, ...(w.senses || [])].map((e) => surfaceOf(e.en)).filter(Boolean);
  const pick = (re) => own.find((f) => re.test(f) && f.toLowerCase() !== word.toLowerCase());
  const make = (suf) => {
    if (suf === "s") return /(s|sh|ch|x|z)$/.test(word) ? word + "es" : /[^aeiou]y$/.test(word) ? word.slice(0, -1) + "ies" : word + "s";
    const stem = /e$/.test(word) ? word.slice(0, -1) : /[^aeiou]y$/.test(word) && suf === "ed" ? word.slice(0, -1) + "i" : word;
    return stem + suf;
  };
  // Only add an ending this word can really take (no made-up forms like "capabled").
  const verb = /동사/.test(w.pos), noun = /명사/.test(w.pos);
  if (verb && /ing$/.test(s) && !/ing$/.test(b)) return pick(/ing$/) || make("ing");
  if (verb && /ed$/.test(s) && !/ed$/.test(b)) return pick(/ed$/) || make("ed");
  if ((verb || noun) && /s$/.test(s) && !/s$/.test(b)) return pick(/s$/) || make("s");
  return word;
}

/** "honor 영광, 명예": a synonym with its meaning (when the content has one). */
function synLabel(w, s) {
  const ko = w.syn_ko?.[s];
  return `<b>${esc(s)}</b>${ko ? ` <span class="muted">${esc(ko)}</span>` : ""}`;
}

function contextOf(w) {
  const raw = contextRaw(w);
  return raw ? showEx(raw) : "";
}
/** The line of today's passages that holds the word, with the word in [ ]. */
function contextRaw(w) {
  for (const pid of S.set.passage_ids) {
    const pw = S.passageById[pid]?.words.find((x) => x.id === w.id);
    if (pw?.context) return pw.context;
  }
  // Words from the 수능 1000 bank have no stored line: look for a short sentence that holds them.
  const re = new RegExp(`(?<![A-Za-z])${w.word.replace(/[^A-Za-z' -]/g, "")}(s|es|d|ed|ing|ly)?(?![A-Za-z])`, "i");
  for (const pid of S.set.passage_ids) {
    const p = S.passageById[pid];
    if (!p) continue;
    const text = `${p.box || ""}\n${p.body}`.replace(/\{\/?u\}/g, "").replace(/\(\s*[①②③④⑤]\s*\)|[①②③④⑤]/g, "").replace(/ {2,}/g, " ");
    for (const sent of text.split(/\n|(?<=[.!?”"])\s+(?=[A-Z“"(])/)) {
      const m = sent.match(re);
      if (m && sent.length <= 220) return sent.slice(0, m.index) + "[" + m[0] + "]" + sent.slice(m.index + m[0].length);
    }
  }
  return null;
}

/** One quiz item. Resolves true/false. */
function ask(kind, w, label, pool, senseIdx) {
  if (kind === "sense" && !hasSenses(w)) kind = "usage"; // reviews may ask for senses of a one-meaning word
  if (kind === "sense" && senseIdx === undefined) senseIdx = Math.floor(Math.random() * w.senses.length);
  window.__quiz = { kind, id: w.id, word: w.word, senseIdx }; // test hook for automated walkthroughs
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
    } else if (kind === "sense") {
      // Which of this word's meanings is used in this sentence?
      const s = w.senses[senseIdx];
      prompt = `<div class="q-sent">${showEx(s.en)}</div><div class="muted">이 문장에서 <b>${esc(w.word)}</b>의 뜻은?</div>`;
      options = shuffle(w.senses.map((x, i) => ({ v: String(i), t: x.m })));
      answer = String(senseIdx);
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
        if (el.disabled) return;
        answered();
        const ok = el.dataset.v === answer;
        if (S.testMode) {
          // Test: no right/wrong shown now; the results screen explains at the end.
          S.lastPick = { picked: options.find((o) => o.v === el.dataset.v)?.t, right: options.find((o) => o.v === answer)?.t };
          $app.querySelectorAll(".opt").forEach((b) => (b.disabled = true));
          el.classList.add("picked");
          await wait(250);
          return resolve(ok);
        }
        $app.querySelectorAll(".opt").forEach((b) => {
          b.disabled = true;
          if (b.dataset.v === answer) b.classList.add("right");
        });
        if (!ok) el.classList.add("wrong");
        speak(w.word);
        await explainChoice(kind, w, options, el.dataset.v, ok, ex0, answer);
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
      // Up to three sentences that use this word correctly (its examples, its sense examples,
      // the passage line) and one that is another word's example with this word forced in.
      // The student picks the awkward one. (Review sessions only.)
      // Skip near-copies (an example and a sense example often differ by one word).
      const bag = (s) => new Set(s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((t) => t.length > 3));
      const alike = (a, b) => {
        const A = bag(a), B = bag(b);
        const common = [...A].filter((t) => B.has(t)).length;
        return common / Math.max(1, Math.min(A.size, B.size)) >= 0.6;
      };
      const goods = [];
      for (const g of shuffle([...(w.senses || []), ...w.examples, ...(contextRaw(w) ? [{ en: contextRaw(w), ko: "" }] : [])]))
        if (g?.en && goods.length < 3 && !goods.some((x) => alike(x.en, g.en))) goods.push(g);
      const syns = new Set((w.synonyms || []).map((s) => s.toLowerCase()));
      const fit = shuffle(S.words.filter(
        (x) => x.id !== w.id && x.examples?.[0] && !syns.has(x.word.toLowerCase()) && !(x.synonyms || []).some((s) => s.toLowerCase() === w.word.toLowerCase())
      ));
      // A word with no part of speech in common makes the wrong sentence clearly wrong, not arguable.
      const posSet = (x) => new Set((x.pos || "").split(/[·/,\s]+/).filter(Boolean));
      const mine = posSet(w);
      const fake = fit.find((x) => ![...posSet(x)].some((p) => mine.has(p))) || fit[0];
      // Put this word in with the ending the slot needs (-s, -ed, -ing), so grammar gives nothing away.
      const fakeSurface = surfaceOf(fake.examples[0].en) || fake.word;
      const form = inflectLike(w, fakeSurface, fake.word);
      const opts = shuffle([
        ...goods.map((g, i) => ({ v: "ok" + i, en: g.en, ko: g.ko })),
        {
          v: "bad",
          en: fake.examples[0].en
            .replace(/\[[^\]]+\]/, `[${form}]`)
            .replace(/\b([Aa])n? \[/, (_, a) => `${a}${/^[aeiou]/i.test(form) ? "n" : ""} [`), // a / an
          x: fake,
        },
      ]);
      window.__quiz.good = "bad";
      screen(`
        <div class="bar"><span>${label}</span></div>
        <div class="card q">
          <div class="q-word">${esc(w.word)}</div>
          <div class="muted">${esc(w.meaning)}</div>
          <div class="muted">이 단어가 <b>어색하게</b> 쓰인 문장 하나를 고르세요</div>
        </div>
        <div class="options">${opts.map((o, i) => `<button class="opt sent" data-v="${esc(o.v)}"><span class="n">${i + 1}</span><span>${showEx(o.en)}</span></button>`).join("")}</div>
        <div id="fb"></div>`);
      tap(".opt.sent", async (el) => {
        if (el.disabled) return;
        answered();
        const ok = el.dataset.v === "bad";
        if (S.testMode) {
          const plain = (s) => s.replace(/[[\]]/g, "");
          S.lastPick = { picked: plain(opts.find((o) => o.v === el.dataset.v).en), right: plain(opts.find((o) => o.v === "bad").en) + " (어색한 문장)" };
          $app.querySelectorAll(".opt.sent").forEach((b) => (b.disabled = true));
          el.classList.add("picked");
          await wait(250);
          return resolve(ok);
        }
        $app.querySelectorAll(".opt.sent").forEach((b) => {
          b.disabled = true;
          if (b.dataset.v === "bad") b.classList.add("right");
        });
        if (!ok) el.classList.add("wrong");
        const head = `<div class="ex-head"><b>${esc(w.word)}</b> <span class="muted small">${esc(w.pos)}</span> = ${esc(w.meaning)}</div>`;
        const lines = opts.map((o, i) => {
          const mine = o.v === el.dataset.v;
          const why = o.v === "bad"
            ? `${i + 1}번이 어색한 문장이에요. 원래 <b>${esc(o.x.word)}</b> '${esc(o.x.meaning)}' 자리예요.<br><span class="small">${showEx(o.x.examples[0].en)} · ${esc(o.x.examples[0].ko)}</span>`
            : `${i + 1}번은 바르게 쓰였어요.<br><span class="small">${o.ko ? esc(o.ko) : "오늘 지문에 나온 문장이에요."}</span>`;
          return `<li class="${o.v === "bad" ? "o" : mine ? "x" : ""}"><span class="mk">${o.v === "bad" ? "✓" : mine ? "✗" : "·"}</span><span>${why}</span></li>`;
        });
        const fb = $app.querySelector("#fb");
        fb.innerHTML = `
          <div class="fb ${ok ? "good" : "bad"}">${ok ? "정답!" : "오답"}${ok ? "" : `<div class="small">이 단어는 복습 간격이 짧아져서 곧 다시 나와요.</div>`}</div>
          <div class="card explain">${head}<ul class="why">${lines.join("")}</ul></div>
          <button class="btn big primary" id="next">다음</button>`;
        speak(w.word);
        fb.querySelector("#next").addEventListener("click", () => resolve(ok));
        fb.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

/**
 * After a multiple-choice word question (right or wrong): why each option is or isn't the answer.
 * Every option belongs to a known word, so the reason comes from that word's meaning.
 */
function explainChoice(kind, w, options, picked, ok, ex0, answer = w.id) {
  return new Promise((resolve) => {
    const fb = $app.querySelector("#fb");
    const head = `<div class="ex-head"><b>${esc(w.word)}</b> <span class="muted small">${esc(w.pos)}</span> = ${esc(w.meaning)}
      ${w.root ? `<div class="small root-line">${esc(w.root)}</div>` : ""}</div>`;
    const lines = options.map((o) => {
      const x = S.wordById[o.v] || w;
      const right = o.v === answer;
      const mine = o.v === picked;
      let why;
      if (kind === "sense") {
        // Each meaning with the sentence that shows it.
        const s = w.senses[Number(o.v)];
        why = `<span><b>${esc(s.m)}</b>${right ? " ← 이 문장의 뜻" : ""}<br><span class="small">${showEx(s.en)} · ${esc(s.ko)}</span></span>`;
      } else if (kind === "synonym") {
        const ko = x.syn_ko?.[o.t];
        why = right
          ? `<b>${esc(o.t)}</b>${ko ? ` '${esc(ko)}'` : ""} ≈ <b>${esc(w.word)}</b> '${esc(w.meaning)}' : 뜻이 비슷해요.`
          : `<b>${esc(o.t)}</b>${ko ? ` '${esc(ko)}'` : ""} → <b>${esc(x.word)}</b> '${esc(x.meaning)}'와 비슷한 말이라 ${esc(w.word)}와 뜻이 달라요.`;
      } else if (kind === "word") {
        why = right
          ? `<b>${esc(x.word)}</b> = ${esc(x.meaning)}`
          : `<b>${esc(x.word)}</b> = ${esc(x.meaning)} → '${esc(w.meaning)}'와 다른 뜻이에요.`;
      } else if (kind === "cloze") {
        const form = o.t.toLowerCase() === x.word.toLowerCase() ? `<b>${esc(o.t)}</b>` : `<b>${esc(o.t)}</b> · ${esc(x.word)}`;
        why = right
          ? `${form} '${esc(x.meaning)}' → '${esc(ex0.ko)}'의 뜻이 되어 문장에 딱 맞아요.`
          : `${form} '${esc(x.meaning)}' → 이 뜻을 넣으면 문장이 통하지 않아요.`;
      } else {
        // meaning / listen / context: the options are meanings
        why = right
          ? `'${esc(o.t)}' → <b>${esc(w.word)}</b>의 뜻${kind === "context" ? " (이 지문 문장에서 쓰인 뜻)" : ""}`
          : `'${esc(o.t)}' → 이건 <b>${esc(x.word)}</b>의 뜻이에요.`;
      }
      return `<li class="${right ? "o" : mine ? "x" : ""}"><span class="mk">${right ? "✓" : mine ? "✗" : "·"}</span><span>${why}</span></li>`;
    });
    fb.innerHTML = `
      <div class="fb ${ok ? "good" : "bad"}">${ok ? "정답!" : "오답"}${ok ? "" : `<div class="small">이 단어는 잠시 뒤에 다시 나와요.</div>`}</div>
      <div class="card explain">${head}<ul class="why">${lines.join("")}</ul></div>
      <button class="btn big primary" id="next">다음</button>`;
    fb.querySelector("#next").addEventListener("click", () => resolve());
    fb.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
