// Word memory model: how well the student knows each word, and when to check it again.
//
// Each learned word keeps two numbers:
//   stability S (days) — how long the memory lasts. Recall chance after t days: R = 0.9^(t / S),
//                        so R falls to 90% exactly S days after the last practice.
//   ease E (1.3–3.0)   — how fast S grows after a successful check. Hard words grow slowly.
// The next review is due when R would drop to 90%, i.e. S days after the last practice.
//
// Where the numbers come from:
//   - Learning day: every drill stage answered right on the first try (and not too slowly)
//     counts toward a drill score q (0–1). Harder stages weigh more. q sets the first S and E.
//   - Each later check: right and quick → S grows by E (more if the memory had already faded);
//     right but slow → S grows less; wrong → S drops to 30% and E falls (a lapse).
import { addDays } from "./db.js";

export const TARGET_R = 0.9; // review when recall chance would fall below 90%
export const MASTERED_DAYS = 90; // stability at which a word counts as fully learned
export const RETIRE_DAYS = 180; // stop scheduling checks beyond this

// Harder recall tasks tell us more about the memory. Self-graded recall and the matching game
// weigh least; the delayed, mixed final check most. (spell/dictation kept only for old records.)
export const STAGE_WEIGHT = {
  recall: 1, match: 1, meaning: 1, word: 1.5, listen: 1.5, synonym: 1.5, usage: 1.5,
  cloze: 2, context: 1.5, translate: 1.5, spell: 2.5, dictation: 2.5,
};
const FINAL_WEIGHT = 3; // stage "final:<kind>"
// Answers slower than this count as shaky.
export const SLOW_MS = {
  recall: 10000, match: 10000, meaning: 8000, word: 8000, listen: 8000, synonym: 10000, usage: 12000,
  cloze: 12000, context: 12000, translate: 20000, spell: 20000, dictation: 20000,
};
const baseStage = (stage) => (stage || "").replace(/^final:/, "");

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);

/** Score one answer: right & quick = 1, right & slow = 0.7, wrong = 0. */
export function answerScore(stage, correct, ms) {
  if (!correct) return 0;
  return ms && ms > (SLOW_MS[baseStage(stage)] ?? 10000) ? 0.7 : 1;
}

/** Drill score q (0–1) from the first-try answers of one word on its learning day. */
export function drillScore(attempts) {
  let num = 0, den = 0;
  for (const a of attempts) {
    const base = baseStage(a.stage);
    if (!a.first_try || !(base in STAGE_WEIGHT)) continue;
    const w = a.stage.startsWith("final:") ? FINAL_WEIGHT : STAGE_WEIGHT[base];
    num += w * answerScore(a.stage, a.correct, a.ms);
    den += w;
  }
  return den ? num / den : 0.5;
}

/** Progress row for a word just learned today. */
export function afterLearning(wordId, attempts, day) {
  const q = drillScore(attempts);
  const stability = 0.5 + 3.5 * q * q; // perfect drills → 4 days, shaky → about 1 day
  const ease = clamp(1.3 + 1.5 * q, 1.3, 3.0);
  return {
    word_id: wordId, learned_on: day, last_review: day,
    drill_score: round2(q), stability: round2(stability), ease: round2(ease),
    reps: 0, lapses: 0, correct: 0, wrong: 0,
    next_review: addDays(day, Math.max(1, Math.round(stability))),
    box: 1,
  };
}

/** Recall chance (0–1) for a progress row on a given day. */
export function recall(row, day) {
  const S = row.stability ?? 1;
  const last = row.last_review || row.learned_on;
  if (!last) return 1;
  const t = Math.max(0, daysBetween(last, day));
  return Math.pow(TARGET_R, t / S);
}

/** Progress row after a review check. */
export function afterReview(row, correct, ms, stage, day) {
  const S = row.stability ?? 1;
  let E = row.ease ?? 2;
  const R = recall(row, day);
  let S2;
  if (!correct) {
    S2 = Math.max(0.5, S * 0.3);
    E = clamp(E - 0.2, 1.3, 3.0);
  } else if (answerScore(stage, true, ms) < 1) {
    S2 = Math.max(S + 1, S * (1 + (E - 1) * 0.6));
    E = clamp(E - 0.05, 1.3, 3.0);
  } else {
    // Remembering an already-faded word strengthens it more.
    S2 = Math.max(S + 1, S * E * (1 + Math.max(0, TARGET_R - R)));
    E = clamp(E + 0.1, 1.3, 3.0);
  }
  return {
    ...row,
    stability: round2(S2), ease: round2(E), last_review: day,
    reps: (row.reps || 0) + 1,
    lapses: (row.lapses || 0) + (correct ? 0 : 1),
    correct: (row.correct || 0) + (correct ? 1 : 0),
    wrong: (row.wrong || 0) + (correct ? 0 : 1),
    next_review: S2 >= RETIRE_DAYS ? null : addDays(day, Math.max(1, Math.round(S2))),
    box: S2 >= MASTERED_DAYS ? 5 : Math.min(4, (row.box || 1) + (correct ? 1 : 0)),
  };
}

/** Which question to use for a review: recognition for young memories, production for older ones. */
export function reviewStage(row) {
  const S = row.stability ?? 1;
  const pool = S < 7 ? ["listen", "cloze", "usage"] : S < 30 ? ["cloze", "usage", "synonym"] : ["usage", "synonym", "context"];
  return pool[Math.floor(Math.random() * pool.length)];
}

export function isDue(row, day) {
  return Boolean(row.learned_on && row.next_review && row.next_review <= day);
}

/** Plain-language level for the dashboard. */
export function masteryLabel(row, day) {
  const R = recall(row, day);
  const S = row.stability ?? 1;
  if (S >= MASTERED_DAYS) return { key: "mastered", text: "완전 암기" };
  if (R < 0.7) return { key: "fading", text: "잊는 중" };
  if (R < TARGET_R - 0.005) return { key: "due", text: "복습 필요" };
  if (S >= 14) return { key: "solid", text: "탄탄" };
  return { key: "fresh", text: "익히는 중" };
}

const round2 = (x) => Math.round(x * 100) / 100;
