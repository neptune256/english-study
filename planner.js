// Picks each day's passages and words from the student's record, and adjusts the levels.
import { isDue, recall, MASTERED_DAYS } from "./memory.js";
import { addDays } from "./db.js";

export const WORDS_PER_DAY = 20;
export const PASSAGES_PER_DAY = 3; // reading passages; plus one 어법 (grammar) question a day
export const GRAMMAR = "어법";
// Review dates come from the word memory model (memory.js).

// Question types grouped so one day mixes different skills.
export const TYPE_GROUP = {
  목적: "대의", 심경: "세부", 주장: "대의", 요지: "대의", 주제: "대의", 제목: "대의",
  "밑줄 의미": "추론", 일치: "세부", 빈칸: "추론", 무관: "흐름", 순서: "흐름", 삽입: "흐름", 요약: "추론",
};

/** Per-type accuracy over all reading answers: { qtype: {n, correct} } */
export function typeStats(events, passagesById) {
  const s = {};
  for (const e of events) {
    if (e.kind !== "reading") continue;
    const p = passagesById[e.passage_id];
    if (!p) continue;
    (s[p.qtype] ||= { n: 0, correct: 0 }).n++;
    if (e.correct) s[p.qtype].correct++;
  }
  return s;
}

/**
 * Build today's set.
 * Passages: unused, difficulty closest to the student's level, at most one per skill group
 * where possible, with a bonus for question types the student keeps missing.
 * Words: key words of those passages the student has never learned, most important first,
 * then closest to the student's word level; capped at 20.
 */
export function planDay({ day, state, passages, words, progress, events, usedPassageIds }) {
  const wordById = Object.fromEntries(words.map((w) => [w.id, w]));
  const passagesById = Object.fromEntries(passages.map((p) => [p.id, p]));
  const known = new Set(progress.map((p) => p.word_id));
  const stats = typeStats(events, passagesById);

  // If the pool of new passages runs out (no refill for a while), bring back passages the
  // student already did: last answered wrong first, then the ones done longest ago.
  // Anything done in the last 7 days is skipped so it isn't fresh in memory.
  const lastTry = {}; // passage id -> {day, correct}
  for (const e of events)
    if (e.kind === "reading" && e.passage_id && (!lastTry[e.passage_id] || lastTry[e.passage_id].day <= e.day))
      lastTry[e.passage_id] = { day: e.day, correct: e.correct };
  const recentCutoff = addDays(day, -7);
  const retakes = (isGrammar) =>
    passages
      .filter((p) => (p.qtype === GRAMMAR) === isGrammar && usedPassageIds.has(p.id))
      .filter((p) => !lastTry[p.id] || lastTry[p.id].day < recentCutoff)
      .sort((a, b) => {
        const wa = lastTry[a.id]?.correct === false ? 0 : 1, wb = lastTry[b.id]?.correct === false ? 0 : 1;
        return wa - wb || (lastTry[a.id]?.day || "").localeCompare(lastTry[b.id]?.day || "");
      });

  // One grammar question: unused, difficulty closest to the student's level.
  const grammar =
    passages
      .filter((p) => p.qtype === GRAMMAR && !usedPassageIds.has(p.id))
      .map((p) => ({ p, score: Math.abs(p.difficulty - state.level) + Math.random() * 0.5 }))
      .sort((a, b) => a.score - b.score)[0]?.p ?? retakes(true)[0];

  const scored = passages
    .filter((p) => p.qtype !== GRAMMAR && !usedPassageIds.has(p.id))
    .map((p) => {
      const st = stats[p.qtype];
      const weak = st && st.n >= 2 && st.correct / st.n < 0.6 ? 0.6 : 0;
      const newWords = p.words.filter((w) => !known.has(w.id)).length;
      return { p, score: Math.abs(p.difficulty - state.level) - weak - newWords * 0.02 + Math.random() * 0.3 };
    })
    .sort((a, b) => a.score - b.score);

  const chosen = [];
  const groups = new Set();
  for (const { p } of scored) {
    if (chosen.length === PASSAGES_PER_DAY) break;
    const g = TYPE_GROUP[p.qtype] || p.qtype;
    if (groups.has(g) && scored.length - chosen.length > PASSAGES_PER_DAY) continue;
    chosen.push(p);
    groups.add(g);
  }
  // Not enough variety left: fill from the closest remaining.
  for (const { p } of scored) {
    if (chosen.length === PASSAGES_PER_DAY) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  // Pool ran dry: fill with retakes.
  for (const p of retakes(false)) {
    if (chosen.length === PASSAGES_PER_DAY) break;
    if (!chosen.includes(p)) chosen.push(p);
  }

  const cand = new Map();
  for (const p of chosen)
    for (const w of p.words)
      if (!known.has(w.id) && wordById[w.id]) {
        const prev = cand.get(w.id);
        if (!prev || prev.importance < w.importance) cand.set(w.id, w);
      }
  // Relearn: up to 8 older words the student is losing go through the full drill again.
  const relearnIds = pickRelearn({ day, progress, events, wordById });
  // Passage key words first: most important, then 수능 기출 1000 words, then closest to the word level.
  const csat = (id) => (wordById[id].csat ? 1 : 0);
  const slots = WORDS_PER_DAY - relearnIds.length;
  const newIds = [...cand.values()]
    .sort(
      (a, b) =>
        b.importance - a.importance ||
        csat(b.id) - csat(a.id) ||
        Math.abs(wordById[a.id].level - state.word_level) - Math.abs(wordById[b.id].level - state.word_level)
    )
    .slice(0, slots)
    .map((w) => w.id);
  // Not enough new key words: fill from the 수능 기출 1000 bank — words that appear in today's
  // passages first, then in list order.
  if (newIds.length < slots) {
    const text = chosen.map((p) => `${p.box || ""} ${p.body}`).join(" ").toLowerCase();
    const inText = (w) => new RegExp(`(?<![a-z])${w.word.toLowerCase().replace(/[^a-z' -]/g, "")}(s|es|d|ed|ing|ly)?(?![a-z])`).test(text);
    const taken = new Set([...newIds, ...relearnIds]);
    const bank = words
      .filter((w) => w.csat && !known.has(w.id) && !taken.has(w.id) && w.examples?.length)
      .map((w) => ({ w, seen: inText(w) ? 0 : 1 }))
      .sort((a, b) => a.seen - b.seen || a.w.csat - b.w.csat);
    for (const { w } of bank) {
      if (newIds.length >= slots) break;
      newIds.push(w.id);
    }
  }
  // Spread relearn words evenly between new ones so every group of 5 gets some.
  const wordIds = [];
  const total = newIds.length + relearnIds.length;
  const step = relearnIds.length ? total / relearnIds.length : Infinity;
  let r = 0, n = 0;
  while (wordIds.length < total) {
    const relearnTurn = r < relearnIds.length && (n >= newIds.length || Math.floor((r + 0.5) * step) <= wordIds.length);
    wordIds.push(relearnTurn ? relearnIds[r++] : newIds[n++]);
  }

  // Due words, weakest memory first (relearn words are covered by the full drill instead).
  const relearnSet = new Set(relearnIds);
  const reviewIds = progress
    .filter((p) => isDue(p, day) && !relearnSet.has(p.word_id))
    .sort((a, b) => recall(a, day) - recall(b, day))
    .map((p) => p.word_id);

  return {
    day,
    passage_ids: [...chosen.map((p) => p.id), ...(grammar ? [grammar.id] : [])], // grammar last
    word_ids: wordIds,
    review_ids: reviewIds,
    level_at_start: state.level,
    word_level_at_start: state.word_level,
    summary: { wordsDone: [], reviewsDone: [], readingDone: [], relearnIds },
  };
}

export const RELEARN_MAX = 8;

/**
 * Older words to study again in full today, most in need first:
 *   last review answered wrong  > many lapses > low recall chance today > low first-day drill score.
 * Only words that show a need (wrong recently, lapsed before, recall under 85%, or a weak first day)
 * qualify. Words practised in the last 2 days are skipped unless their last check was wrong,
 * and mastered words never come back here.
 */
export function pickRelearn({ day, progress, events, wordById }) {
  const lastReview = {};
  for (const e of events)
    if (e.kind === "review" && e.word_id && (!lastReview[e.word_id] || lastReview[e.word_id].day <= e.day))
      lastReview[e.word_id] = e;
  const twoDaysAgo = addDays(day, -2);
  return progress
    .filter((p) => p.learned_on && p.learned_on < day && wordById[p.word_id] && (p.stability ?? 0) < MASTERED_DAYS)
    .map((p) => {
      const R = recall(p, day);
      const lastWrong = lastReview[p.word_id]?.correct === false;
      const q = p.drill_score ?? 0.7;
      const need = lastWrong || (p.lapses || 0) > 0 || R < 0.85 || q < 0.7;
      const recent = (p.last_review || p.learned_on) > twoDaysAgo;
      const score = (lastWrong ? 3 : 0) + Math.min(2, (p.lapses || 0) * 0.5) + (1 - R) * 4 + (1 - q) * 1.5;
      return { id: p.word_id, ok: need && (!recent || lastWrong), score };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score)
    .slice(0, RELEARN_MAX)
    .map((x) => x.id);
}

/**
 * New levels after a finished day.
 * Reading level moves on the day's reading score blended with word accuracy;
 * word level moves on first-try accuracy in the word drills.
 */
export function nextLevels(state, { readingCorrect, readingTotal, wordFirstTry, wordTotal }) {
  const clamp = (x) => Math.min(5, Math.max(1, Math.round(x * 2) / 2));
  const r = readingTotal ? readingCorrect / readingTotal : 0;
  const w = wordTotal ? wordFirstTry / wordTotal : r;
  const s = 0.7 * r + 0.3 * w;
  let level = state.level;
  if (s >= 0.8) level += 0.5;
  else if (s < 0.5) level -= 0.5;
  let wl = state.word_level;
  if (w >= 0.85) wl += 0.5;
  else if (w < 0.6) wl -= 0.5;
  return { level: clamp(level), word_level: clamp(wl) };
}
