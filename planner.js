// Picks each day's passages and words from the student's record, and adjusts the levels.
import { isDue, recall } from "./memory.js";

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

  // One grammar question: unused, difficulty closest to the student's level.
  const grammar = passages
    .filter((p) => p.qtype === GRAMMAR && !usedPassageIds.has(p.id))
    .map((p) => ({ p, score: Math.abs(p.difficulty - state.level) + Math.random() * 0.5 }))
    .sort((a, b) => a.score - b.score)[0]?.p;

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

  const cand = new Map();
  for (const p of chosen)
    for (const w of p.words)
      if (!known.has(w.id) && wordById[w.id]) {
        const prev = cand.get(w.id);
        if (!prev || prev.importance < w.importance) cand.set(w.id, w);
      }
  const wordIds = [...cand.values()]
    .sort(
      (a, b) =>
        b.importance - a.importance ||
        Math.abs(wordById[a.id].level - state.word_level) - Math.abs(wordById[b.id].level - state.word_level)
    )
    .slice(0, WORDS_PER_DAY)
    .map((w) => w.id);

  // Due words, weakest memory first.
  const reviewIds = progress
    .filter((p) => isDue(p, day))
    .sort((a, b) => recall(a, day) - recall(b, day))
    .map((p) => p.word_id);

  return {
    day,
    passage_ids: [...chosen.map((p) => p.id), ...(grammar ? [grammar.id] : [])], // grammar last
    word_ids: wordIds,
    review_ids: reviewIds,
    level_at_start: state.level,
    word_level_at_start: state.word_level,
    summary: { wordsDone: [], reviewsDone: [], readingDone: [] },
  };
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
