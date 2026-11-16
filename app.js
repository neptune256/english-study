import { db, today, addDays, REMOTE } from "./db.js";
import { planDay, nextLevels, afterReview, REVIEW_GAP } from "./planner.js";

const $app = document.getElementById("app");
const DAY = new URLSearchParams(location.search).get("day") || today(); // ?day= for testing

// Stages every new word goes through, in order. A wrong answer sends the word to the back
// of that stage's queue, so a stage ends only when every word in the group is answered right.
const STAGES = [
  { key: "card", label: "익히기" },
  { key: "meaning", label: "뜻 고르기" },
  { key: "word", label: "단어 고르기" },
  { key: "cloze", label: "빈칸 채우기" },
  { key: "context", label: "지문 속 의미" },
  { key: "translate", label: "해석하기" },
  { key: "spell", label: "철자 쓰기" },
];
const GROUP = 5;

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

const saveSet = () => db.saveDaily(S.set);

// ───────────── home ─────────────
function home() {
  const s = S.set;
  const sum = s.summary;
  const reviewsLeft = s.review_ids.filter((id) => !sum.reviewsDone.includes(id)).length;
  const wordsLeft = s.word_ids.filter((id) => !sum.wordsDone.includes(id)).length;
  const readLeft = s.passage_ids.filter((id) => !sum.readingDone.find((r) => r.id === id)).length;
  const step = (n, title, detail, done, active) => `
    <li class="step ${done ? "done" : ""} ${active ? "active" : ""}">
      <span class="num">${done ? "✓" : n}</span>
      <div><div class="step-title">${title}</div><div class="muted small">${detail}</div></div>
    </li>`;
  const next = reviewsLeft ? "review" : wordsLeft ? "vocab" : readLeft ? "reading" : null;
  screen(`
    <header class="top"><h1>오늘의 영어</h1><span class="muted">${DAY}</span></header>
    ${REMOTE ? "" : `<p class="note">로컬 테스트 모드입니다. 기록은 이 기기에만 저장됩니다.</p>`}
    <ol class="steps">
      ${step(1, "복습", s.review_ids.length ? `예전에 외운 단어 ${s.review_ids.length}개 확인` : "오늘은 복습할 단어가 없어요", !reviewsLeft, next === "review")}
      ${step(2, "단어 외우기", `새 단어 ${s.word_ids.length}개 · 남은 단어 ${wordsLeft}개`, !wordsLeft, next === "vocab")}
      ${step(3, "독해", `지문 ${s.passage_ids.length}개 · 남은 지문 ${readLeft}개`, !readLeft, next === "reading")}
    </ol>
    ${
      next
        ? `<button class="btn primary big" id="go">${sum.wordsDone.length || sum.reviewsDone.length ? "이어서 하기" : "시작하기"}</button>`
        : `<div class="card center"><h2>오늘 학습 완료!</h2>${resultLine()}</div>`
    }`);
  tap("#go", () => (next === "review" ? review() : next === "vocab" ? vocab() : reading()));
}

function resultLine() {
  const r = S.set.summary.readingDone;
  const c = r.filter((x) => x.correct).length;
  return `<p>독해 ${c} / ${r.length} 정답</p><p class="muted small">내일 다시 만나요.</p>`;
}

// ───────────── review (old words) ─────────────
async function review() {
  const sum = S.set.summary;
  const queue = shuffle(S.set.review_ids.filter((id) => !sum.reviewsDone.includes(id)));
  for (let i = 0; i < queue.length; i++) {
    const w = S.wordById[queue[i]];
    const kind = ["meaning", "cloze", "spell"][Math.floor(Math.random() * 3)];
    const t0 = Date.now();
    const ok = await ask(kind, w, `복습 ${i + 1} / ${queue.length}`, S.words);
    const row = S.progressById[w.id];
    const next = afterReview(row, ok, DAY);
    S.progressById[w.id] = next;
    await db.saveProgress([next]);
    await db.logEvents([{ day: DAY, kind: "review", stage: kind, word_id: w.id, correct: ok, ms: Date.now() - t0 }]);
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
  const left = todays.filter((w) => !sum.wordsDone.includes(w.id));
  for (let g = 0; g < left.length; g += GROUP) {
    const group = left.slice(g, g + GROUP);
    const groupNo = Math.floor((todays.length - left.length + g) / GROUP) + 1;
    const groups = Math.ceil(todays.length / GROUP);
    for (const st of STAGES) {
      let queue = shuffle(group);
      const tried = new Set();
      let done = 0;
      while (queue.length) {
        const w = queue.shift();
        const label = `${groupNo}/${groups}묶음 · ${st.label} · ${done + 1}/${group.length}`;
        if (st.key === "card") {
          await card(w, label);
          done++;
          continue;
        }
        const t0 = Date.now();
        const ok = await ask(st.key, w, label, todays);
        await db.logEvents([{
          day: DAY, kind: "drill", stage: st.key, word_id: w.id, correct: ok, first_try: !tried.has(w.id), ms: Date.now() - t0,
        }]);
        tried.add(w.id);
        if (ok) done++;
        else queue.push(w);
      }
    }
    // Group finished: these words are now learned and enter the review schedule.
    const rows = group.map((w) => ({
      word_id: w.id, box: 1, learned_on: DAY, next_review: addDays(DAY, REVIEW_GAP[1]), correct: 0, wrong: 0,
    }));
    rows.forEach((r) => (S.progressById[r.word_id] = r));
    await db.saveProgress(rows);
    sum.wordsDone.push(...group.map((w) => w.id));
    if (sum.wordsDone.length >= S.set.word_ids.length) S.set.vocab_done_at = new Date().toISOString();
    await saveSet();
  }
  home();
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
        <div class="pos">${esc(w.pos)}</div>
        <div class="meaning">${esc(w.meaning)}</div>
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
  return new Promise((resolve) => {
    let prompt = "", options = [], answer = "", mode = "choice";
    const ex0 = w.examples[0], ex1 = w.examples[1] || w.examples[0];
    if (kind === "meaning" || (kind === "context" && !contextRaw(w))) {
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
      tap(".opt", async (el) => {
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
    const n = S.set.passage_ids.indexOf(id) + 1;
    const results = await readPassage(p, `독해 ${n} / ${S.set.passage_ids.length}`);
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
          <div class="choices">${q.choices.map((c, i) => `<button class="opt choice" data-q="${qi}" data-i="${i + 1}"><span class="n">${CIRCLED[i]}</span>${esc(c)}</button>`).join("")}</div>
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
          <details class="expl" ${ok ? "" : "open"}><summary>풀이 보기</summary><p>${esc(q.explanation)}</p></details>`;
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
  const evs = (await db.events()).filter((e) => e.day === DAY && e.kind === "drill" && e.first_try);
  const stats = {
    readingCorrect: sum.readingDone.filter((r) => r.correct).length,
    readingTotal: sum.readingDone.length,
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
