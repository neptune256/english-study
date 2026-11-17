// 골라서 풀기 화면: 단원(여러 개 가능) · 난이도 · 문제 수를 고르면 추천과 함께 문제 묶음을 만들어 줍니다.
// math.js 의 home() 이 mountPicker(요소, {...}) 로 붙입니다. 스타일도 여기서 넣습니다.
import { SUBJECTS } from "./math-data.js";
import { TIER_NAME } from "./math-plan.js";
import { unitInsights, recommendUnits, pickProblems } from "./math-recommend.js";

const COUNTS = [3, 5, 10];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");

let state = null; // {units:Set, tier:"auto"|"1".."5", count} — kept while the page is open

/**
 * Render the picker into `root`.
 * ctx: {problems, attempts, sessions, byId, day, prefer?, onStart(list, title, unitsCsv)}
 */
export function mountPicker(root, ctx) {
  addStyle();
  const ins = unitInsights(ctx);
  const rec = recommendUnits(ins, 3);
  if (!state) state = { units: new Set(rec.slice(0, 1)), tier: "auto", count: 5 };
  for (const u of [...state.units]) if (!ins[u]?.left) state.units.delete(u);
  if (!state.units.size && rec.length) state.units.add(rec[0]);

  const render = () => {
    const sel = [...state.units];
    const leftAt = (t) => sel.reduce((n, u) => n + ins[u].leftByTier[t], 0);
    const leftAll = sel.reduce((n, u) => n + ins[u].left, 0);
    const recTiers = [...new Set(sel.map((u) => ins[u].rec))];
    if (state.tier !== "auto" && !leftAt(Number(state.tier))) state.tier = "auto";

    const units = SUBJECTS.map((subj) => {
      const chips = Object.values(ins).filter((x) => x.subject === subj).map((x) => {
        const on = state.units.has(x.unit);
        const isRec = rec.includes(x.unit);
        return `<button class="mp-unit ${on ? "on" : ""}" data-u="${x.unit}" ${x.left ? "" : "disabled"}>
          <span class="mp-unit-top"><b>${esc(x.name)}</b>${isRec ? `<span class="mp-rec">추천</span>` : ""}</span>
          <span class="mp-sub">${x.left ? `남은 ${x.left} · 정답률 ${pct(x.ok, x.n)}` : "다 풀었어요"}</span>
          ${isRec ? `<span class="mp-why">${esc(x.reason)}</span>` : ""}
        </button>`;
      });
      return `<div class="mp-subj"><div class="mp-subj-name">${subj}</div><div class="mp-units">${chips.join("")}</div></div>`;
    });

    const tiers = [`<button class="mp-chip ${state.tier === "auto" ? "on" : ""}" data-t="auto">자동 <span class="mp-rec">추천</span></button>`]
      .concat([1, 2, 3, 4, 5].map((t) => {
        const n = leftAt(t);
        return `<button class="mp-chip ${state.tier === String(t) ? "on" : ""}" data-t="${t}" ${n ? "" : "disabled"}>
          ${TIER_NAME[t]}${recTiers.includes(t) ? ` <span class="mp-rec">추천</span>` : ""} <span class="mp-n">${n}</span></button>`;
      }));

    let why;
    if (!sel.length) why = "단원을 하나 이상 고르세요.";
    else if (sel.length === 1) {
      const x = ins[sel[0]];
      why = `<b>${esc(x.name)}</b> 추천 난이도는 <b>${TIER_NAME[x.rec]}</b>예요. ${esc(x.recReason)}`;
    } else {
      why = sel.map((u) => `${esc(ins[u].name)} → <b>${TIER_NAME[ins[u].rec]}</b>`).join(" · ") +
        `<br><span class="muted">자동을 고르면 단원마다 추천 난이도 주변에서 섞어서 내요.</span>`;
    }
    const n = Math.min(state.count, state.tier === "auto" ? leftAll : leftAll);

    root.innerHTML = `
      <div class="mp-step">1. 단원 <span class="muted small">여러 개 골라도 돼요 · 추천은 최근 2주에 적게 풀었거나 정답률이 낮은 단원</span></div>
      ${units.join("")}
      <div class="mp-step">2. 난이도 <span class="muted small">숫자는 안 푼 문제 수</span></div>
      <div class="mp-chips">${tiers.join("")}</div>
      <p class="mp-explain small">${why}</p>
      <div class="mp-step">3. 문제 수</div>
      <div class="mp-chips">${COUNTS.map((c) => `<button class="mp-chip ${state.count === c ? "on" : ""}" data-c="${c}">${c}문제</button>`).join("")}</div>
      <button class="btn primary big" id="mp-go" ${sel.length && leftAll ? "" : "disabled"}>${sel.length ? `${n}문제 풀기` : "단원을 고르세요"}</button>`;

    root.querySelectorAll("[data-u]").forEach((b) => b.addEventListener("click", () => {
      const u = b.dataset.u;
      if (state.units.has(u)) state.units.delete(u);
      else state.units.add(u);
      render();
    }));
    root.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => {
      state.tier = b.dataset.t;
      render();
    }));
    root.querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", () => {
      state.count = Number(b.dataset.c);
      render();
    }));
    root.querySelector("#mp-go").addEventListener("click", () => {
      const { picks, note } = pickProblems({ ins, ...ctx, units: sel, tierChoice: state.tier, count: state.count });
      if (!picks.length) return;
      const names = sel.map((u) => ins[u].name);
      const title = `${names.length > 2 ? `${names.slice(0, 2).join(" · ")} 외 ${names.length - 2}` : names.join(" · ")}` +
        ` · ${state.tier === "auto" ? "추천 난이도" : TIER_NAME[state.tier]}`;
      ctx.onStart(picks, note ? `${title} (${note})` : title, sel.join(","));
    });
  };
  render();
}

function addStyle() {
  if (document.getElementById("mp-style")) return;
  const s = document.createElement("style");
  s.id = "mp-style";
  s.textContent = `
    .mp-step { font-weight: 700; margin: 14px 0 6px; }
    .mp-step:first-child { margin-top: 0; }
    .mp-subj { margin-bottom: 8px; }
    .mp-subj-name { font-size: 14px; color: var(--muted); margin-bottom: 4px; }
    .mp-units { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
    .mp-unit { font: inherit; text-align: left; color: var(--text); background: var(--card); border: 1.5px solid var(--line);
      border-radius: 12px; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; min-height: 56px; }
    .mp-unit.on { border-color: var(--accent); background: var(--accent-soft); }
    .mp-unit:disabled { opacity: 0.45; cursor: default; }
    .mp-unit-top { display: flex; align-items: center; gap: 6px; font-size: 16px; }
    .mp-sub { font-size: 13px; color: var(--muted); }
    .mp-why { font-size: 12px; color: #c0621a; }
    .mp-rec { display: inline-block; font-size: 11px; font-weight: 700; padding: 0 7px; border-radius: 99px; background: #fde8d4; color: #b4570f; }
    .mp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .mp-chip { font: inherit; font-size: 15px; color: var(--text); background: var(--card); border: 1.5px solid var(--line);
      border-radius: 99px; padding: 8px 14px; cursor: pointer; min-height: 42px; }
    .mp-chip.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 700; }
    .mp-chip:disabled { opacity: 0.4; cursor: default; }
    .mp-n { font-size: 12px; color: var(--muted); }
    .mp-explain { background: var(--bg); border-radius: 10px; padding: 8px 12px; margin: 8px 0 0; }
    @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .mp-rec { background: #4a2c12; color: #ffb27a; }
      :root:not([data-theme="light"]) .mp-why { color: #ffb27a; } }`;
  document.head.append(s);
}
