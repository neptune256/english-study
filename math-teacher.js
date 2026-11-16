// 수학 학습 대시보드 (선생님용): 실전 점수, 단원별·배점별 정답률, 오답 복습 현황.
import { mdb, today, REMOTE, isDue, UNITS, SUBJECTS, showAnswer, GRADUATED, EXAM_MINUTES } from "./math-data.js";

const DAY = new URLSearchParams(location.search).get("day") || today();
const $app = document.getElementById("app");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");
const mmss = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const md = (d) => (d ? d.slice(5).replace("-", "/") : "–");
let D;

async function load() {
  try {
    const [exams, problems, sessions, attempts, review] = await Promise.all([
      mdb.exams(), mdb.problems(), mdb.sessions(), mdb.attempts(), mdb.review(),
    ]);
    D = { exams, problems, sessions, attempts, review };
    D.examById = Object.fromEntries(exams.map((e) => [e.id, e]));
    D.byId = Object.fromEntries(problems.map((p) => [p.id, p]));
    D.first = new Map();
    for (const a of attempts) if (!D.first.has(a.problem_id)) D.first.set(a.problem_id, a);
    render();
  } catch (e) {
    $app.innerHTML = `<div class="card"><h2>불러오지 못했어요</h2><p class="muted small">${esc(e.message)}</p></div>`;
  }
}

const src = (p) => `${esc(D.examById[p.exam]?.label || p.exam)} ${p.num}번`;
const bar = (a, b) => `<div class="bar-cell"><div class="bar-bg"><div class="bar-fg" style="width:${b ? Math.round((100 * a) / b) : 0}%"></div></div><span>${pct(a, b)}</span></div>`;

function render() {
  const exams = D.sessions.filter((s) => s.mode === "exam" && s.finished_at);
  const firsts = [...D.first.values()];
  const right = firsts.filter((a) => a.correct).length;
  const due = D.review.filter((r) => isDue(r, DAY));
  const waiting = D.review.filter((r) => r.next_review);
  const grad = D.review.filter((r) => r.box >= GRADUATED);
  const days = new Set(D.attempts.map((a) => a.day));
  const last = exams[0];

  $app.innerHTML = `
    <header class="top"><h1>수학 대시보드</h1><span class="small"><a href="math.html" class="muted">학생 화면 →</a></span></header>
    ${REMOTE ? "" : `<p class="note">로컬 테스트 모드: 이 브라우저에 저장된 기록만 보입니다.</p>`}
    <div class="kpis">
      <div class="kpi"><div class="v">${last ? last.score + "점" : "–"}</div><div class="l">최근 실전${last ? ` · ${esc(D.examById[last.exam]?.label)}` : ""}</div></div>
      <div class="kpi"><div class="v">${exams.length}회</div><div class="l">실전 모의고사</div></div>
      <div class="kpi"><div class="v">${D.first.size}<small class="muted">/${D.problems.length}</small></div><div class="l">풀어 본 기출 문항</div></div>
      <div class="kpi"><div class="v">${pct(right, firsts.length)}</div><div class="l">첫 시도 정답률</div></div>
      <div class="kpi ${due.length > 15 ? "warn" : ""}"><div class="v">${due.length}</div><div class="l">오늘까지 다시 풀 오답 · 대기 ${waiting.length}</div></div>
      <div class="kpi"><div class="v">${grad.length}</div><div class="l">오답 졸업 (3연속 정답)</div></div>
      <div class="kpi"><div class="v">${days.size}일</div><div class="l">수학을 푼 날</div></div>
    </div>

    <h2>실전 모의고사 기록 <span class="muted small">${EXAM_MINUTES}분 기준 · 줄을 누르면 문항별 결과</span></h2>
    ${examTable(exams)}
    <div id="exam-detail"></div>

    <div class="two">
      <div><h2>단원별 정답률 <span class="muted small">처음 풀었을 때 기준</span></h2>${unitTable()}</div>
      <div><h2>배점별 정답률</h2>${pointTable()}
        <h2>최근 2주 풀이량</h2>${dayTable()}</div>
    </div>

    <h2>오답 복습 목록 <span class="muted small">틀렸거나 "헷갈려요"로 표시한 문제 · 2일 → 7일 → 21일 · 줄을 누르면 문제 보기</span></h2>
    ${reviewTable()}
    <div id="peek"></div>
    <p class="muted small" style="margin-top:20px">문제 출처: 한국교육과정평가원. 개인 학습용.</p>`;

  $app.querySelectorAll("tr[data-session]").forEach((tr) => tr.addEventListener("click", () => {
    $app.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
    tr.classList.add("sel");
    examDetail(D.sessions.find((s) => s.id === tr.dataset.session));
  }));
  $app.querySelectorAll("tr[data-pid]").forEach((tr) => tr.addEventListener("click", () => peek(D.byId[tr.dataset.pid])));
}

function examTable(exams) {
  if (!exams.length) return `<p class="muted">아직 실전 기록이 없어요.</p>`;
  const rows = exams.map((s) => {
    const ps = D.problems.filter((p) => p.exam === s.exam);
    const ans = s.draft?.answers || {};
    const bySubj = SUBJECTS.map((subj) => {
      const qs = ps.filter((p) => p.subject === subj);
      return `${qs.filter((p) => ans[p.num] === p.answer).reduce((t, p) => t + p.points, 0)}/${qs.reduce((t, p) => t + p.points, 0)}`;
    });
    const blank = ps.filter((p) => ans[p.num] === undefined || ans[p.num] === null).length;
    return `<tr class="click" data-session="${esc(s.id)}"><td>${md(s.day)}</td><td>${esc(D.examById[s.exam]?.label || s.exam)}</td>
      <td><b>${s.score}</b></td><td>${s.n_correct}/30</td>${bySubj.map((x) => `<td>${x}</td>`).join("")}
      <td class="${s.ms > EXAM_MINUTES * 60000 ? "x" : ""}">${mmss(s.ms)}</td><td>${blank || ""}</td></tr>`;
  });
  return `<div class="tbl-wrap"><table><tr><th>날짜</th><th>시험지</th><th>점수</th><th>정답</th>
    ${SUBJECTS.map((s) => `<th>${s}</th>`).join("")}<th>시간</th><th>빈칸</th></tr>${rows.join("")}</table></div>`;
}

function examDetail(s) {
  const ps = D.problems.filter((p) => p.exam === s.exam).sort((a, b) => a.num - b.num);
  const d = s.draft || {};
  const unsure = new Set(d.unsure || []);
  const rows = ps.map((p) => {
    const a = (d.answers || {})[p.num] ?? null;
    const ok = a === p.answer;
    return `<tr class="click" data-pid="${p.id}"><td>${p.num}</td><td class="ox ${ok ? "o" : "x"}">${ok ? "O" : "X"}</td>
      <td>${showAnswer(p, a)}</td><td>${showAnswer(p, p.answer)}</td><td>${p.points}</td><td>${esc(p.unit_name)}</td>
      <td>${unsure.has(p.num) ? "헷갈림" : ""}</td><td>${d.ms?.[p.num] ? mmss(d.ms[p.num]) : ""}</td></tr>`;
  });
  const box = $app.querySelector("#exam-detail");
  box.innerHTML = `<h2>${esc(D.examById[s.exam]?.label)} · ${md(s.day)} <span class="muted small">줄을 누르면 문제</span></h2>
    <div class="tbl-wrap"><table><tr><th>번호</th><th></th><th>학생 답</th><th>정답</th><th>배점</th><th>단원</th><th></th><th>시간</th></tr>${rows.join("")}</table></div>`;
  box.querySelectorAll("tr[data-pid]").forEach((tr) => tr.addEventListener("click", () => peek(D.byId[tr.dataset.pid])));
}

function unitTable() {
  const rows = UNITS.map(([u, subj, name]) => {
    const ps = D.problems.filter((p) => p.unit === u);
    const tried = ps.filter((p) => D.first.has(p.id));
    const ok = tried.filter((p) => D.first.get(p.id).correct).length;
    const pending = D.review.filter((r) => r.next_review && D.byId[r.problem_id]?.unit === u).length;
    return `<tr><td class="muted small">${subj}</td><td>${name}</td><td>${tried.length}/${ps.length}</td><td>${bar(ok, tried.length)}</td><td>${pending || ""}</td></tr>`;
  });
  return `<div class="tbl-wrap"><table><tr><th></th><th>단원</th><th>풀어 봄</th><th>정답률</th><th>오답 대기</th></tr>${rows.join("")}</table></div>`;
}

function pointTable() {
  const rows = [2, 3, 4].map((pt) => {
    const tried = D.problems.filter((p) => p.points === pt && D.first.has(p.id));
    const ok = tried.filter((p) => D.first.get(p.id).correct).length;
    return `<tr><td>${pt}점</td><td>${tried.length}</td><td>${bar(ok, tried.length)}</td></tr>`;
  });
  const hard = D.problems.filter((p) => p.points === 4 && [14, 15, 20, 21, 22, 28, 29, 30].includes(p.num) && D.first.has(p.id));
  const hardOk = hard.filter((p) => D.first.get(p.id).correct).length;
  rows.push(`<tr><td>킬러·준킬러<br><span class="muted small">14·15·20~22·28~30번</span></td><td>${hard.length}</td><td>${bar(hardOk, hard.length)}</td></tr>`);
  return `<div class="tbl-wrap"><table><tr><th>배점</th><th>문항</th><th>정답률</th></tr>${rows.join("")}</table></div>`;
}

function dayTable() {
  const cells = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(DAY + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    const n = D.attempts.filter((a) => a.day === day).length;
    cells.push(`<div class="fc"><div class="fc-n">${n || ""}</div><div class="fc-bar"><div style="height:${Math.min(100, n * 3.3)}%"></div></div><div class="fc-d">${day.slice(8)}</div></div>`);
  }
  return `<div class="card forecast"><div class="fc-row">${cells.join("")}</div><div class="muted small">하루에 답한 문항 수 (실전 30문항 포함)</div></div>`;
}

function reviewTable() {
  const rows = [...D.review].filter((r) => D.byId[r.problem_id])
    .sort((a, b) => (a.next_review || "9999").localeCompare(b.next_review || "9999"))
    .map((r) => {
      const p = D.byId[r.problem_id];
      const state = r.box >= GRADUATED ? `<span class="pill">졸업</span>` : isDue(r, DAY) ? `<span class="pill warn">오늘</span>` : md(r.next_review);
      return `<tr class="click" data-pid="${p.id}"><td>${src(p)}</td><td>${p.points}점</td><td>${esc(p.unit_name)}</td>
        <td>${md(r.added_on)}</td><td>${r.wrong}</td><td>${r.correct}</td><td>${Math.min(r.box, 3)}${r.box >= GRADUATED ? "" : "단계"}</td><td>${state}</td></tr>`;
    });
  if (!rows.length) return `<p class="muted">아직 오답이 없어요.</p>`;
  return `<div class="tbl-wrap"><table><tr><th>문제</th><th>배점</th><th>단원</th><th>처음 틀린 날</th><th>틀림</th><th>맞힘</th><th>단계</th><th>다음 복습</th></tr>${rows.join("")}</table></div>`;
}

async function peek(p) {
  const box = $app.querySelector("#peek");
  const tries = D.attempts.filter((a) => a.problem_id === p.id);
  box.innerHTML = `<div class="card" style="margin-top:12px">
    <div class="top" style="margin-bottom:8px"><b>${src(p)} · ${p.points}점 · ${esc(p.unit_name)}</b><button class="btn" id="close">닫기</button></div>
    <div class="pimg-box"><img id="pimg" style="width:100%;display:block" alt="${src(p)}" /></div>
    <p>정답 <b>${showAnswer(p, p.answer)}</b> · 학생 답: ${tries.map((a) => `${md(a.day)} ${showAnswer(p, a.answer)}${a.correct ? " O" : " X"}`).join(", ") || "–"}</p></div>`;
  box.querySelector("#close").addEventListener("click", () => (box.innerHTML = ""));
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    box.querySelector("#pimg").src = await mdb.imageUrl(p.image);
  } catch (e) {
    box.querySelector("#pimg").replaceWith(Object.assign(document.createElement("p"), { textContent: e.message }));
  }
}

load();
