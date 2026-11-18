// Math data layer: Supabase REST (tables math_*) when configured, otherwise localStorage +
// ../math/content (local test mode, also forced with ?local=1). Mirrors db.js, which it only reads.
import { today, addDays, REMOTE } from "./db.js";

export { today, addDays, REMOTE };
const cfg = window.APP_CONFIG || {};
const BUCKET = "math-problems";

async function rest(method, path, body, prefer) {
  const headers = {
    apikey: cfg.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 || method !== "GET" ? null : res.json();
}
const upsert = (table, rows) => rest("POST", table, rows, "resolution=merge-duplicates,return=minimal");

// ───────────── local fallback ─────────────
const LS = "mathapp:";
const lsGet = (k, d) => {
  try {
    const v = localStorage.getItem(LS + k);
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(LS + k, JSON.stringify(v));
  } catch {
    /* storage unavailable: progress lives only in memory this session */
  }
};
function upsertLocal(key, rows, pk) {
  const all = lsGet(key, []);
  for (const r of rows) {
    const i = all.findIndex((x) => x[pk] === r[pk]);
    if (i >= 0) all[i] = { ...all[i], ...r };
    else all.push(r);
  }
  lsSet(key, all);
}
let content = null;
async function localContent() {
  if (!content) content = await (await fetch("../math/content/problems.json", { cache: "no-store" })).json();
  return content;
}

let localSol = null;
async function localSolutions() {
  if (!localSol) {
    localSol = fetch("../math/content/solutions.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return localSol;
}

// ───────────── public API ─────────────
const imageCache = new Map();
const solutionCache = new Map();
export const mdb = {
  async exams() {
    return REMOTE ? rest("GET", "math_exams?select=*&order=held_on") : (await localContent()).exams;
  },
  async problems() {
    return REMOTE ? rest("GET", "math_problems?select=*&order=id&limit=5000") : (await localContent()).problems;
  },
  async sessions() {
    return REMOTE ? rest("GET", "math_sessions?select=*&order=started_at.desc") : lsGet("sessions", []).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  },
  async saveSession(s) {
    return REMOTE ? upsert("math_sessions", [s]) : upsertLocal("sessions", [s], "id");
  },
  async deleteSession(id) {
    if (REMOTE) return rest("DELETE", `math_sessions?id=eq.${encodeURIComponent(id)}`);
    lsSet("sessions", lsGet("sessions", []).filter((s) => s.id !== id));
  },
  async attempts() {
    return REMOTE ? rest("GET", "math_attempts?select=*&order=at&limit=20000") : lsGet("attempts", []);
  },
  async logAttempts(rows) {
    if (!rows.length) return;
    if (REMOTE) return rest("POST", "math_attempts", rows, "return=minimal");
    const all = lsGet("attempts", []);
    let id = all.length ? all[all.length - 1].id + 1 : 1;
    for (const r of rows) all.push({ id: id++, at: new Date().toISOString(), ...r });
    lsSet("attempts", all);
  },
  async review() {
    return REMOTE ? rest("GET", "math_review?select=*") : lsGet("review", []);
  },
  async saveReview(rows) {
    if (!rows.length) return;
    rows = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    return REMOTE ? upsert("math_review", rows) : upsertLocal("review", rows, "problem_id");
  },
  /** Ids of problems that have a written solution. */
  async solutionIds() {
    if (REMOTE) return (await rest("GET", "math_solutions?select=problem_id&limit=5000")).map((r) => r.problem_id);
    return Object.keys(await localSolutions());
  },
  /** One solution {idea, steps[], answer} or null. */
  async solution(id) {
    if (!solutionCache.has(id)) {
      solutionCache.set(id, REMOTE
        ? rest("GET", `math_solutions?problem_id=eq.${encodeURIComponent(id)}&select=*`).then((r) => r[0] || null)
        : localSolutions().then((all) => all[id] || null));
    }
    return solutionCache.get(id);
  },
  /** URL for a problem image (a blob: URL from the private bucket when remote). */
  async imageUrl(path) {
    if (!REMOTE) return `../math/content/img/${path}`;
    if (!imageCache.has(path)) {
      imageCache.set(path, (async () => {
        const res = await fetch(`${cfg.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
          headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}` },
        });
        if (!res.ok) {
          imageCache.delete(path);
          throw new Error(`문제 그림을 불러오지 못했어요 (${res.status})`);
        }
        return URL.createObjectURL(await res.blob());
      })());
    }
    return imageCache.get(path);
  },
};

// ───────────── wrong-answer review schedule ─────────────
// A wrong (or "헷갈림") problem comes back after 2 days, then 7, then 21.
// Three right answers in a row graduate it; a miss sends it back to the start.
export const REVIEW_DAYS = [2, 7, 21];
export const GRADUATED = REVIEW_DAYS.length + 1;

/** Review row after a wrong or unsure answer outside review mode. */
export function addToReview(row, problemId, day, wrong) {
  return {
    problem_id: problemId,
    box: 1,
    next_review: addDays(day, REVIEW_DAYS[0]),
    added_on: row?.added_on || day,
    last_review: row?.last_review ?? null,
    wrong: (row?.wrong || 0) + (wrong ? 1 : 0),
    correct: row?.correct || 0,
  };
}

/** Review row after answering it in review mode. Unsure counts as not yet solid. */
export function afterReview(row, correct, unsure, day) {
  const ok = correct && !unsure;
  const box = ok ? row.box + 1 : 1;
  return {
    ...row,
    box: Math.min(box, GRADUATED),
    next_review: box >= GRADUATED ? null : addDays(day, REVIEW_DAYS[box - 1]),
    last_review: day,
    wrong: row.wrong + (correct ? 0 : 1),
    correct: row.correct + (correct ? 1 : 0),
  };
}

export const isDue = (row, day) => Boolean(row.next_review && row.next_review <= day);

// ───────────── labels ─────────────
export const SUBJECTS = ["대수", "미적분Ⅰ", "확률과 통계"];
export const UNITS = [
  ["exp_log", "대수", "지수함수와 로그함수"],
  ["trig", "대수", "삼각함수"],
  ["seq", "대수", "수열"],
  ["limit", "미적분Ⅰ", "함수의 극한과 연속"],
  ["diff", "미적분Ⅰ", "미분"],
  ["integ", "미적분Ⅰ", "적분"],
  ["count", "확률과 통계", "경우의 수"],
  ["prob", "확률과 통계", "확률"],
  ["stat", "확률과 통계", "통계"],
];
export const unitName = (u) => (UNITS.find((x) => x[0] === u) || [, , u])[2];
export const CIRCLED = ["①", "②", "③", "④", "⑤"];
export const showAnswer = (p, a) => (a === null || a === undefined ? "–" : p.is_choice ? CIRCLED[a - 1] || a : String(a));
export const EXAM_MINUTES = 100;

// ───────────── solution display ─────────────
const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Image path of the official 해설 for 학력평가 problems (cut per problem by math/tools/edu.py), else null. */
export const officialSol = (p) => (p && String(p.exam).startsWith("edu-") ? `sol/${p.exam}/${p.num}.png` : null);

/** Fill `box` with the solution of problem `p`: the official 해설 image when there is one,
 *  otherwise the written solution (KaTeX for $...$). */
export async function renderSolution(box, p) {
  box.innerHTML = `<div class="m-sol muted small">풀이 불러오는 중…</div>`;
  const official = officialSol(p);
  if (official) {
    try {
      const url = await mdb.imageUrl(official);
      box.innerHTML = `<div class="m-sol">
        <img class="m-sol-img" src="${url}" alt="${escHtml(p.exam)} ${p.num}번 공식 해설">
        <div class="m-sol-ans">정답은 <b>${showAnswer(p, p.answer)}</b></div>
        <p class="muted small">출처: 시도교육청 전국연합학력평가 공식 정답 및 해설</p>
      </div>`;
    } catch {
      box.innerHTML = `<div class="m-sol"><p class="muted">해설 그림을 불러오지 못했어요. 정답은 <b>${showAnswer(p, p.answer)}</b>예요.</p></div>`;
    }
    return;
  }
  let sol = null;
  try {
    sol = await mdb.solution(p.id);
  } catch {
    /* shown as missing below */
  }
  if (!sol) {
    box.innerHTML = `<div class="m-sol"><p class="muted">이 문제는 아직 해설이 없어요. 정답은 <b>${showAnswer(p, p.answer)}</b>예요.</p></div>`;
    return;
  }
  box.innerHTML = `<div class="m-sol">
    <div class="m-sol-idea"><b>핵심</b> ${escHtml(sol.idea)}</div>
    <ol class="m-sol-steps">${sol.steps.map((s) => `<li>${escHtml(s)}</li>`).join("")}</ol>
    <div class="m-sol-ans">따라서 정답은 <b>${showAnswer(p, p.answer)}</b></div>
    <p class="muted small">Claude가 직접 풀어서 쓴 해설이에요. 이해가 안 되는 부분은 선생님께 물어보세요.</p>
  </div>`;
  renderMath(box);
}

export function renderMath(el, tries = 0) {
  if (window.renderMathInElement) {
    window.renderMathInElement(el, {
      delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }],
      throwOnError: false,
    });
  } else if (tries < 20) {
    setTimeout(() => renderMath(el, tries + 1), 150); // KaTeX still loading
  }
}
