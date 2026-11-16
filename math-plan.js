// 오늘의 5문제: 매일 풀 문제를 고르고 학생 수준을 조절합니다.
//
// 난이도 단계(tier) 1~5:
//   1 기초 = 2점, 2 기본 = 3점, 3 중급 = 4점, 4 준킬러 = 14·20·21·28·29번 4점, 5 킬러 = 15·22·30번
// 학생 수준(level) 1~5, 시작 2. 하루 새 문제 첫 시도 정답률 80% 이상이면 +0.5, 40% 미만이면 −0.5.
// 하루 구성: 오늘 복습일이 된 오답 최대 3개 + 새 문제로 5개를 채움.
// 새 문제: 아직 안 푼 문제 중, 정답률이 낮거나 최근 덜 푼 단원 먼저, 오늘 같은 단원은 겹치지 않게,
//          난이도는 수준 주변(−1, 0, 0, +1, 0)으로 고르고 쉬운 것부터 냅니다.
import { addDays, isDue } from "./math-data.js";

export const DAILY_COUNT = 5;
export const MAX_REVIEW_SLOTS = 3;
export const START_LEVEL = 2;
export const TIER_NAME = { 1: "기초", 2: "기본", 3: "중급", 4: "준킬러", 5: "킬러" };
const OFFSETS = [-1, 0, 0, 1, 0];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function tier(p) {
  if (p.points <= 2) return 1;
  if (p.points === 3) return 2;
  if ([15, 22, 30].includes(p.num)) return 5;
  if ([14, 20, 21, 28, 29].includes(p.num)) return 4;
  return 3;
}

export const dailyId = (day) => `${day}-daily`;
export const dailyOf = (sessions, day) => sessions.find((s) => s.id === dailyId(day));

/** Level in effect now: the last finished day's result, else the level a day was planned with. */
export function currentLevel(sessions) {
  const days = sessions.filter((s) => s.mode === "daily").sort((a, b) => b.day.localeCompare(a.day));
  for (const s of days) if (s.draft?.level_after != null) return s.draft.level_after;
  return days[0]?.draft?.level ?? START_LEVEL;
}

export function nextLevel(level, firstTries) {
  if (firstTries.length < 3) return level;
  const acc = firstTries.filter((r) => r.correct).length / firstTries.length;
  if (acc >= 0.8) return clamp(level + 0.5, 1, 5);
  if (acc < 0.4) return clamp(level - 0.5, 1, 5);
  return level;
}

/** Consecutive days (up to today) with the daily set finished. */
export function streak(sessions, day) {
  const done = new Set(sessions.filter((s) => s.mode === "daily" && s.finished_at).map((s) => s.day));
  let d = done.has(day) ? day : addDays(day, -1);
  let n = 0;
  while (done.has(d)) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

/** First attempt per problem → per-unit {n, ok}. */
export function unitStats(attempts, byId) {
  const seen = new Set();
  const st = {};
  for (const a of attempts) {
    if (seen.has(a.problem_id)) continue;
    seen.add(a.problem_id);
    const u = byId[a.problem_id]?.unit;
    if (!u) continue;
    st[u] ||= { n: 0, ok: 0 };
    st[u].n++;
    if (a.correct) st[u].ok++;
  }
  return st;
}

/** Pick `count` new problems. `taken` = problem ids already in today's set. */
export function pickNew({ problems, attempts, sessions, byId, level, day, taken = [], count }) {
  const tried = new Set(attempts.map((a) => a.problem_id));
  const takenSet = new Set(taken);
  let pool = problems.filter((p) => !tried.has(p.id) && !takenSet.has(p.id));
  const stats = unitStats(attempts, byId);
  const recent = {};
  for (const s of sessions) {
    if (s.mode !== "daily" || s.day < addDays(day, -6) || s.day > day) continue;
    for (const id of [...(s.draft?.ids || []), ...(s.draft?.bonus || [])]) {
      const u = byId[id]?.unit;
      if (u) recent[u] = (recent[u] || 0) + 1;
    }
  }
  const usedToday = new Set(taken.map((id) => byId[id]?.unit).filter(Boolean));
  const units = [...new Set(problems.map((p) => p.unit))];
  const picks = [];
  for (let k = 0; k < count && pool.length; k++) {
    const target = clamp(Math.round(level + OFFSETS[(taken.length + k) % OFFSETS.length]), 1, 5);
    const need = (u) => {
      const s = stats[u];
      const acc = s && s.n >= 3 ? s.ok / s.n : 0.5;
      return acc + 0.12 * (recent[u] || 0) + (usedToday.has(u) ? 10 : 0) + Math.random() * 0.05;
    };
    const ranked = units.map((u) => [u, need(u)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    let pick = null;
    for (const u of ranked) {
      const c = pool.filter((p) => p.unit === u);
      if (!c.length) continue;
      const best = Math.min(...c.map((p) => Math.abs(tier(p) - target)));
      if (best > 1) continue;
      const near = c.filter((p) => Math.abs(tier(p) - target) === best);
      pick = near[Math.floor(Math.random() * near.length)];
      break;
    }
    if (!pick) {
      const best = Math.min(...pool.map((p) => Math.abs(tier(p) - target)));
      const near = pool.filter((p) => Math.abs(tier(p) - target) === best);
      pick = near[Math.floor(Math.random() * near.length)];
    }
    picks.push(pick);
    usedToday.add(pick.unit);
    pool = pool.filter((p) => p.id !== pick.id);
  }
  return picks.sort((a, b) => tier(a) - tier(b));
}

/** Today's set: due wrong answers first (up to 3), then new problems. */
export function planDaily({ problems, attempts, sessions, review, byId, day }) {
  const level = currentLevel(sessions);
  const due = review.filter((r) => isDue(r, day) && byId[r.problem_id])
    .sort((a, b) => a.next_review.localeCompare(b.next_review))
    .slice(0, MAX_REVIEW_SLOTS)
    .map((r) => r.problem_id);
  const fresh = pickNew({ problems, attempts, sessions, byId, level, day, taken: due, count: DAILY_COUNT - due.length });
  return {
    id: dailyId(day), day, mode: "daily", started_at: new Date().toISOString(),
    draft: { ids: [...due, ...fresh.map((p) => p.id)], review_ids: due, level, done: {}, bonus: [] },
  };
}
