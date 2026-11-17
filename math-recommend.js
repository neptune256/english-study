// 골라서 풀기: 단원·난이도 추천.
//
// 단원 추천: 최근 2주에 적게 푼 단원, 정답률이 낮은 단원을 먼저.
//   need = (정답률을 모르면 0.5, 알면 1 − 정답률) × 2 + 2 / (1 + 최근 2주 푼 문제 수)
//   (안 푼 문제가 남지 않은 단원은 추천하지 않음)
// 난이도 추천(단원별): 전체 수준(오늘의 5문제 Lv)에서 시작해, 그 단원을 처음 풀었던 기록을 시간 순으로 보며
//   지금 추정치 이상 난이도를 맞히면 +0.5, 이하 난이도를 틀리면 −0.5. 반올림한 단계가 추천 난이도
//   (그 단계에 안 푼 문제가 없으면 가장 가까운 단계).
import { addDays, UNITS } from "./math-data.js";
import { tier, TIER_NAME, currentLevel } from "./math-plan.js";

export const RECENT_DAYS = 14;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");

/** Per-unit record, need score, recommended difficulty and the reasons, for one day. */
export function unitInsights({ problems, attempts, sessions, byId, day }) {
  const level = currentLevel(sessions);
  const tried = new Set(attempts.map((a) => a.problem_id));
  const since = addDays(day, -(RECENT_DAYS - 1));
  const ins = {};
  for (const [u, subject, name] of UNITS) {
    const ps = problems.filter((p) => p.unit === u);
    const leftByTier = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const p of ps) if (!tried.has(p.id)) leftByTier[tier(p)]++;
    ins[u] = {
      unit: u, subject, name, total: ps.length,
      left: Object.values(leftByTier).reduce((a, b) => a + b, 0), leftByTier,
      n: 0, ok: 0, recent: 0, lastDay: null, est: level,
      byTier: { 1: { n: 0, ok: 0 }, 2: { n: 0, ok: 0 }, 3: { n: 0, ok: 0 }, 4: { n: 0, ok: 0 }, 5: { n: 0, ok: 0 } },
    };
  }
  const seen = new Set();
  for (const a of attempts) {
    const p = byId[a.problem_id];
    const x = p && ins[p.unit];
    if (!x) continue;
    if (a.day >= since && a.day <= day) x.recent++;
    if (!x.lastDay || a.day > x.lastDay) x.lastDay = a.day;
    if (seen.has(a.problem_id)) continue; // difficulty and accuracy use first tries only
    seen.add(a.problem_id);
    const t = tier(p);
    x.n++;
    x.byTier[t].n++;
    if (a.correct) {
      x.ok++;
      x.byTier[t].ok++;
    }
    const r = Math.round(x.est);
    if (a.correct && t >= r) x.est = clamp(x.est + 0.5, 1, 5);
    else if (!a.correct && t <= r) x.est = clamp(x.est - 0.5, 1, 5);
  }
  for (const x of Object.values(ins)) {
    x.acc = x.n >= 3 ? x.ok / x.n : null;
    x.need = x.left ? (x.acc == null ? 0.5 : 1 - x.acc) * 2 + 2 / (1 + x.recent) : -Infinity;
    const want = clamp(Math.round(x.est), 1, 5);
    x.rec = nearestTier(want, x.leftByTier) ?? want;
    x.reason = !x.left
      ? "다 풀었어요"
      : x.recent === 0
        ? x.lastDay ? `${Math.round((new Date(day) - new Date(x.lastDay)) / 86400000)}일째 안 풂` : "아직 안 풀어 본 단원"
        : x.acc != null && x.acc < 0.6
          ? `정답률 ${pct(x.ok, x.n)}로 약한 단원`
          : `최근 2주 ${x.recent}문제`;
    const tried = [1, 2, 3, 4, 5].filter((t) => x.byTier[t].n).map((t) => `${TIER_NAME[t]} ${x.byTier[t].ok}/${x.byTier[t].n}`);
    x.recReason = tried.length
      ? `이 단원 기록: ${tried.join(" · ")} 맞힘`
      : `아직 이 단원 기록이 없어 전체 수준(Lv ${level})으로 추천`;
  }
  return ins;
}

function nearestTier(t, leftByTier) {
  for (const d of [0, -1, 1, -2, 2, -3, 3, -4, 4]) if (leftByTier[t + d] > 0) return t + d;
  return null;
}

/** The k units that most need practice now, spread over subjects when scores are close. */
export function recommendUnits(ins, k = 3) {
  const pool = Object.values(ins).filter((x) => x.left);
  const out = [];
  const perSubject = {};
  while (out.length < k && pool.length) {
    pool.sort((a, b) => (b.need - 0.5 * (perSubject[b.subject] || 0)) - (a.need - 0.5 * (perSubject[a.subject] || 0)));
    const x = pool.shift();
    out.push(x.unit);
    perSubject[x.subject] = (perSubject[x.subject] || 0) + 1;
  }
  return out;
}

/**
 * Problems for a chosen set of units and difficulty ("auto" = each unit's recommended difficulty,
 * spread a little around it). Only problems not tried yet. Difficulty comes first; among equally
 * close problems, ones with a written solution (`prefer`, a Set of ids) first. Returns {picks, note}.
 */
export function pickProblems({ ins, problems, attempts, units, tierChoice, count, prefer }) {
  const tried = new Set(attempts.map((a) => a.problem_id));
  const order = [...units].sort((a, b) => ins[b].need - ins[a].need);
  const pool = {};
  for (const u of order) pool[u] = problems.filter((p) => p.unit === u && !tried.has(p.id)).sort(() => Math.random() - 0.5);
  const fixed = tierChoice !== "auto";
  const offsets = [0, -1, 1, 0, 0];
  const picks = [];
  let shortfall = false;
  const used = {};
  for (let k = 0; picks.length < count && k < (count + 1) * order.length * 3; k++) {
    if (order.every((v) => !pool[v].length)) break;
    const u = order[k % order.length];
    if (!pool[u].length) continue;
    const i = used[u] || 0;
    const target = fixed ? Number(tierChoice) : clamp(ins[u].rec + offsets[i % offsets.length], 1, 5);
    // a fixed difficulty: let another chosen unit supply it while any has an exact match
    const exactHere = pool[u].some((q) => tier(q) === target);
    if (fixed && !exactHere && order.some((v) => pool[v].some((q) => tier(q) === target))) continue;
    const best = Math.min(...pool[u].map((p) => Math.abs(tier(p) - target)));
    if (fixed && best > 0) shortfall = true;
    const near = pool[u].filter((q) => Math.abs(tier(q) - target) === best);
    const withSol = prefer?.size ? near.filter((q) => prefer.has(q.id)) : [];
    const p = (withSol.length ? withSol : near)[0];
    used[u] = i + 1;
    picks.push(p);
    pool[u] = pool[u].filter((q) => q !== p);
  }
  picks.sort((a, b) => tier(a) - tier(b));
  let note = "";
  if (picks.length < count) note = `남은 문제가 ${picks.length}개뿐이에요.`;
  else if (shortfall) note = `${TIER_NAME[tierChoice]} 문제가 모자라서 가까운 난이도로 채웠어요.`;
  return { picks, note };
}
