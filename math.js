// 오늘의 수학: 평가원 기출(2028 수능 범위)을 실전·단원 연습·오답 복습으로 푸는 화면.
import {
  mdb, today, REMOTE, addToReview, afterReview, isDue, UNITS, SUBJECTS, unitName,
  CIRCLED, showAnswer, EXAM_MINUTES, GRADUATED,
} from "./math-data.js";

const $app = document.getElementById("app");
const DAY = new URLSearchParams(location.search).get("day") || today(); // ?day= for testing
const UNIT_SET = 5; // problems per unit-practice round
const REVIEW_SET = 10; // max problems per review round
const SOURCE = "한국교육과정평가원";

let S; // loaded data

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const screen = (html) => {
  $app.innerHTML = html;
  window.scrollTo(0, 0);
};
const tap = (sel, fn) => $app.querySelectorAll(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const mins = (ms) => (ms ? Math.max(1, Math.round(ms / 60000)) + "분" : "–");
const examLabel = (id) => S.examById[id]?.label || id;
const srcLine = (p) => `${examLabel(p.exam)} ${p.num}번 · ${p.points}점 · ${esc(p.unit_name)}`;

function fail(err) {
  console.error(err);
  screen(`<div class="card"><h2>문제가 생겼어요</h2><p class="muted small">${esc(err.message || err)}</p>
    <button class="btn primary big" id="retry">다시 불러오기</button></div>`);
  tap("#retry", load);
}

// ───────────── load ─────────────
async function load() {
  screen(`<div class="center muted">불러오는 중…</div>`);
  try {
    const [exams, problems, sessions, attempts, review] = await Promise.all([
      mdb.exams(), mdb.problems(), mdb.sessions(), mdb.attempts(), mdb.review(),
    ]);
    S = { exams, problems, sessions, attempts, review };
    S.examById = Object.fromEntries(exams.map((e) => [e.id, e]));
    S.byId = Object.fromEntries(problems.map((p) => [p.id, p]));
    S.reviewById = Object.fromEntries(review.map((r) => [r.problem_id, r]));
    home();
  } catch (e) {
    fail(e);
  }
}

/** First attempt per problem (any mode): what the student could do the first time they met it. */
function firstAttempts() {
  const first = new Map();
  for (const a of S.attempts) if (!first.has(a.problem_id)) first.set(a.problem_id, a);
  return first;
}

// ───────────── home ─────────────
function home() {
  const due = S.review.filter((r) => isDue(r, DAY));
  const waiting = S.review.filter((r) => r.next_review && !isDue(r, DAY));
  const graduated = S.review.filter((r) => r.box >= GRADUATED).length;
  const draft = S.sessions.find((s) => s.mode === "exam" && !s.finished_at);
  const first = firstAttempts();

  const examRows = [...S.exams].reverse().map((e) => {
    const done = S.sessions.filter((s) => s.mode === "exam" && s.exam === e.id && s.finished_at);
    const best = done[0]; // newest first
    const inProgress = draft && draft.exam === e.id;
    const touched = S.problems.filter((p) => p.exam === e.id && first.has(p.id)).length;
    const status = inProgress
      ? `<span class="m-pill accent">푸는 중</span>`
      : best
        ? `<b>${best.score}점</b> <span class="muted small">${best.day.slice(5).replace("-", "/")}${done.length > 1 ? ` · ${done.length}회` : ""}</span>`
        : touched
          ? `<span class="muted small">연습에서 ${touched}문항 풀어 봄</span>`
          : `<span class="muted small">안 풀었음</span>`;
    return `<li class="m-exam">
      <div><div class="m-exam-title">${esc(e.label)}</div><div>${status}</div></div>
      <div class="m-exam-btns">
        ${best ? `<button class="btn small-btn" data-result="${esc(best.id)}">결과</button>` : ""}
        <button class="btn small-btn ${inProgress ? "primary" : ""}" data-exam="${esc(e.id)}">${inProgress ? "이어 풀기" : best ? "다시 풀기" : "풀기"}</button>
      </div></li>`;
  });

  const unitCards = SUBJECTS.map((subj) => {
    const rows = UNITS.filter((u) => u[1] === subj).map(([u, , name]) => {
      const ps = S.problems.filter((p) => p.unit === u);
      const tried = ps.filter((p) => first.has(p.id));
      const right = tried.filter((p) => first.get(p.id).correct).length;
      const w = ps.length ? Math.round((100 * tried.length) / ps.length) : 0;
      return `<button class="m-unit" data-unit="${u}">
        <span class="m-unit-name">${esc(name)}</span>
        <span class="m-unit-bar"><span style="width:${w}%"></span></span>
        <span class="muted small">${tried.length}/${ps.length} · 정답률 ${pct(right, tried.length)}</span>
      </button>`;
    });
    return `<div class="m-subject"><div class="m-subject-name">${subj}</div>${rows.join("")}</div>`;
  });

  const recent = S.sessions.filter((s) => s.finished_at).slice(0, 6).map((s) => {
    const what = s.mode === "exam" ? examLabel(s.exam) : s.mode === "unit" ? `단원 연습 · ${unitName(s.unit)}` : "오답 복습";
    return `<tr${s.mode === "exam" ? ` class="click" data-result="${esc(s.id)}"` : ""}>
      <td>${s.day.slice(5).replace("-", "/")}</td><td>${esc(what)}</td>
      <td>${s.n_correct}/${s.n_total}${s.mode === "exam" ? ` · <b>${s.score}점</b>` : ""}</td><td class="muted">${mins(s.ms)}</td></tr>`;
  });

  screen(`
    <header class="top"><h1>오늘의 수학</h1><a class="muted small" href="index.html">영어 →</a></header>
    ${REMOTE ? "" : `<p class="note">로컬 테스트 모드입니다. 기록은 이 기기에만 저장됩니다.</p>`}
    <p class="muted small m-intro">2028 수능 범위(대수 · 미적분Ⅰ · 확률과 통계) 평가원 기출입니다. 풀이는 종이나 노트 앱에 하고 답만 입력하세요.</p>

    <section class="card m-review">
      <div class="m-row">
        <div><h2>오답 다시 풀기</h2>
          <div class="muted small">${due.length ? `오늘 다시 풀 문제 <b>${due.length}개</b>` : "오늘 다시 풀 문제가 없어요"}
          · 기다리는 문제 ${waiting.length}개 · 졸업 ${graduated}개</div></div>
        ${due.length ? `<button class="btn primary" id="go-review">시작</button>` : ""}
      </div>
      <div class="muted small">틀리거나 헷갈린 문제는 2일 → 7일 → 21일 뒤에 다시 나와요. 세 번 연속 맞히면 졸업.</div>
    </section>

    <h2 class="m-h2">실전 모의고사 <span class="muted small">30문항 · ${EXAM_MINUTES}분 · 100점</span></h2>
    <ul class="m-exams">${examRows.join("")}</ul>

    <h2 class="m-h2">단원별 연습 <span class="muted small">한 번에 ${UNIT_SET}문제 · 오래된 시험지부터</span></h2>
    <div class="m-units">${unitCards.join("")}</div>

    ${recent.length ? `<h2 class="m-h2">최근 기록</h2><div class="m-tbl"><table>${recent.join("")}</table></div>` : ""}
    <p class="muted small m-copy">문제 출처: ${SOURCE} 대학수학능력시험·모의평가·예시문항. 저작권은 ${SOURCE}에 있으며 개인 학습용으로만 사용합니다.</p>
  `);
  tap("#go-review", () => runQueue("review", due.sort((a, b) => (a.next_review < b.next_review ? -1 : 1)).slice(0, REVIEW_SET).map((r) => S.byId[r.problem_id]).filter(Boolean)));
  tap("[data-exam]", (b) => (draft && draft.exam === b.dataset.exam ? examRun(draft) : confirmExam(b.dataset.exam, draft)));
  tap("[data-result]", (b) => examResult(S.sessions.find((s) => s.id === b.dataset.result)));
  tap("[data-unit]", (b) => startUnit(b.dataset.unit));
}

// ───────────── problem card ─────────────
function problemHtml(p) {
  return `<div class="m-q">
    <div class="m-q-img"><img id="qimg" alt="${esc(examLabel(p.exam))} ${p.num}번 문제" /><div class="m-q-loading muted small">문제 불러오는 중…</div></div>
    <div class="m-q-src muted small">${srcLine(p)} · 출처: ${SOURCE}</div>
  </div>`;
}
async function showImage(p, next) {
  const img = $app.querySelector("#qimg");
  try {
    const url = await mdb.imageUrl(p.image);
    if (img && img.isConnected) {
      img.src = url;
      img.onload = () => img.parentElement.classList.add("ready");
    }
  } catch (e) {
    const box = $app.querySelector(".m-q-loading");
    if (box) box.textContent = e.message;
  }
  if (next) mdb.imageUrl(next.image).catch(() => {}); // warm the next one
}
function answerHtml(p, value) {
  if (p.is_choice) {
    return `<div class="m-choices">${CIRCLED.map((c, i) =>
      `<button class="m-ch ${value === i + 1 ? "on" : ""}" data-v="${i + 1}">${c}</button>`).join("")}</div>`;
  }
  return `<div class="m-short"><input id="num" class="m-num" inputmode="numeric" pattern="[0-9]*" maxlength="3"
    autocomplete="off" placeholder="정답 (0~999)" value="${value ?? ""}" /></div>`;
}
const readShort = () => {
  const v = ($app.querySelector("#num")?.value || "").trim();
  return /^\d{1,3}$/.test(v) ? Number(v) : null;
};

// ───────────── 실전 (whole paper) ─────────────
function confirmExam(examId, draft) {
  const e = S.examById[examId];
  screen(`
    <div class="card">
      <h2>${esc(e.label)}</h2>
      <p>30문항 · ${EXAM_MINUTES}분 · 100점 만점. 실제 시험처럼 한 번에 푸는 것을 권해요.</p>
      <ul class="small">
        <li>문제를 보며 답만 입력하고, 다 풀면 <b>제출</b>을 누르세요. 채점은 제출할 때 합니다.</li>
        <li>중간에 나가도 답과 시간이 저장돼서 이어 풀 수 있어요.</li>
        <li>자신 없는 문제는 <b>헷갈려요</b>를 눌러 두면 맞아도 오답 복습에 들어가요.</li>
      </ul>
      ${draft ? `<p class="note">${esc(examLabel(draft.exam))}을(를) 푸는 중이에요. 새로 시작하면 그 기록은 지워져요.</p>` : ""}
      <div class="row"><button class="btn" id="back">돌아가기</button><button class="btn primary" id="start">시작하기</button></div>
    </div>`);
  tap("#back", home);
  tap("#start", async () => {
    if (draft) {
      await mdb.deleteSession(draft.id);
      S.sessions = S.sessions.filter((s) => s.id !== draft.id);
    }
    const s = {
      id: `${DAY}-exam-${examId}-${Date.now()}`, day: DAY, mode: "exam", exam: examId,
      started_at: new Date().toISOString(), draft: { answers: {}, unsure: [], ms: {}, elapsed: 0, cur: 1 },
    };
    await mdb.saveSession(s);
    S.sessions.unshift(s);
    examRun(s);
  });
}

function examRun(session) {
  const ps = S.problems.filter((p) => p.exam === session.exam).sort((a, b) => a.num - b.num);
  const d = session.draft;
  d.answers ||= {}; d.unsure ||= []; d.ms ||= {}; d.elapsed ||= 0; d.cur ||= 1;
  let shownAt = performance.now();
  let tick = null;
  let saving = Promise.resolve();
  let dirty = false;

  const elapsed = () => d.elapsed + (performance.now() - shownAt);
  const bank = () => {
    // move time spent on the current screen into the draft
    const now = performance.now();
    const spent = now - shownAt;
    d.elapsed += spent;
    d.ms[d.cur] = (d.ms[d.cur] || 0) + spent;
    shownAt = now;
  };
  const save = () => {
    bank();
    dirty = false;
    saving = saving.then(() => mdb.saveSession({ id: session.id, day: session.day, mode: "exam", exam: session.exam, started_at: session.started_at, draft: d })).catch((e) => console.error(e));
    return saving;
  };
  const onHide = () => { if (document.visibilityState === "hidden") save(); };
  document.addEventListener("visibilitychange", onHide);
  const stop = () => {
    clearInterval(tick);
    document.removeEventListener("visibilitychange", onHide);
  };

  function render() {
    const p = ps[d.cur - 1];
    const val = d.answers[p.num];
    const answered = ps.filter((q) => d.answers[q.num] !== undefined && d.answers[q.num] !== null).length;
    screen(`
      <div class="m-bar">
        <button class="btn small-btn" id="pause">나가기</button>
        <span class="m-timer" id="timer"></span>
        <span class="muted small">${answered}/30 답함</span>
      </div>
      <div class="m-head"><b>${p.num}번</b> <span class="muted small">${p.points}점${p.num >= 23 ? " · 확률과 통계" : ""}</span></div>
      ${problemHtml(p)}
      ${answerHtml(p, val)}
      <label class="m-unsure"><input type="checkbox" id="unsure" ${d.unsure.includes(p.num) ? "checked" : ""}/> 헷갈려요 (맞아도 오답 복습에 넣기)</label>
      <div class="row m-nav">
        <button class="btn" id="prev" ${d.cur === 1 ? "disabled" : ""}>← 이전</button>
        ${d.cur < 30 ? `<button class="btn primary" id="next">다음 →</button>` : `<button class="btn primary" id="submit">제출하고 채점</button>`}
      </div>
      <div class="m-grid">${ps.map((q) => {
        const a = d.answers[q.num];
        const has = a !== undefined && a !== null;
        return `<button class="m-cell ${has ? "has" : ""} ${q.num === d.cur ? "cur" : ""} ${d.unsure.includes(q.num) ? "unsure" : ""}" data-go="${q.num}">${q.num}${has ? `<small>${showAnswer(q, a)}</small>` : ""}</button>`;
      }).join("")}</div>
      ${d.cur < 30 ? `<button class="btn big" id="submit">제출하고 채점</button>` : ""}
    `);
    showImage(p, ps[d.cur]);
    updateTimer();

    tap(".m-ch", (b) => {
      const v = Number(b.dataset.v);
      d.answers[p.num] = d.answers[p.num] === v ? null : v; // tap again to clear
      save();
      render();
    });
    const num = $app.querySelector("#num");
    if (num) {
      num.addEventListener("input", () => {
        num.value = num.value.replace(/\D/g, "").slice(0, 3);
        d.answers[p.num] = readShort();
        dirty = true;
      });
      num.addEventListener("change", save);
      num.addEventListener("keydown", (e) => { if (e.key === "Enter") go(d.cur + 1); });
    }
    $app.querySelector("#unsure").addEventListener("change", (e) => {
      d.unsure = e.target.checked ? [...new Set([...d.unsure, p.num])] : d.unsure.filter((n) => n !== p.num);
      save();
      render();
    });
    tap("#prev", () => go(d.cur - 1));
    tap("#next", () => go(d.cur + 1));
    tap("[data-go]", (b) => go(Number(b.dataset.go)));
    tap("#submit", confirmSubmit);
    tap("#pause", async () => {
      await save();
      stop();
      home();
    });
  }
  function go(n) {
    if (n < 1 || n > 30) return;
    bank();
    if (dirty) save();
    d.cur = n;
    render();
  }
  function updateTimer() {
    const el = $app.querySelector("#timer");
    if (!el) return;
    const left = EXAM_MINUTES * 60000 - elapsed();
    el.textContent = left >= 0 ? `남은 시간 ${clock(left)}` : `시간 초과 +${clock(-left)}`;
    el.classList.toggle("over", left < 0);
  }
  function confirmSubmit() {
    bank();
    const blanks = ps.filter((q) => d.answers[q.num] === undefined || d.answers[q.num] === null).map((q) => q.num);
    screen(`<div class="card">
      <h2>제출할까요?</h2>
      <p>${blanks.length ? `아직 답하지 않은 문제가 <b>${blanks.length}개</b> 있어요: ${blanks.join(", ")}번` : "30문항 모두 답했어요."}</p>
      <p class="muted small">걸린 시간 ${clock(d.elapsed)}. 제출하면 바로 채점하고 틀린 문제는 오답 복습에 들어가요.</p>
      <div class="row"><button class="btn" id="back">계속 풀기</button><button class="btn primary" id="ok">제출</button></div>
    </div>`);
    tap("#back", () => { shownAt = performance.now(); render(); });
    tap("#ok", async (b) => {
      b.disabled = true;
      stop();
      try {
        await saving;
        await gradeExam(session, ps);
      } catch (e) {
        fail(e);
      }
    });
  }

  tick = setInterval(updateTimer, 1000);
  render();
}

async function gradeExam(session, ps) {
  const d = session.draft;
  const unsure = new Set(d.unsure);
  const rows = ps.map((p) => {
    const a = d.answers[p.num];
    const answer = a === undefined ? null : a;
    return {
      day: DAY, session_id: session.id, problem_id: p.id, mode: "exam",
      answer, correct: answer === p.answer, unsure: unsure.has(p.num), ms: Math.round(d.ms[p.num] || 0),
    };
  });
  const review = rows.filter((r) => !r.correct || r.unsure)
    .map((r) => addToReview(S.reviewById[r.problem_id], r.problem_id, DAY, !r.correct));
  const score = ps.reduce((t, p, i) => t + (rows[i].correct ? p.points : 0), 0);
  const done = {
    ...session, day: session.day, finished_at: new Date().toISOString(), ms: Math.round(d.elapsed),
    score, total: ps.reduce((t, p) => t + p.points, 0),
    n_correct: rows.filter((r) => r.correct).length, n_total: rows.length, draft: d,
  };
  await mdb.logAttempts(rows);
  await mdb.saveReview(review);
  await mdb.saveSession(done);
  S.attempts.push(...rows);
  for (const r of review) S.reviewById[r.problem_id] = r;
  S.review = Object.values(S.reviewById);
  S.sessions = [done, ...S.sessions.filter((s) => s.id !== session.id)];
  examResult(done);
}

function examResult(session) {
  const ps = S.problems.filter((p) => p.exam === session.exam).sort((a, b) => a.num - b.num);
  const d = session.draft || {};
  const ans = (p) => (d.answers || {})[p.num] ?? null;
  const unsure = new Set(d.unsure || []);
  const bySubj = SUBJECTS.map((subj) => {
    const qs = ps.filter((p) => p.subject === subj);
    const ok = qs.filter((p) => ans(p) === p.answer);
    return `<div class="m-kpi"><div class="v">${ok.reduce((t, p) => t + p.points, 0)}<small>/${qs.reduce((t, p) => t + p.points, 0)}</small></div><div class="l">${subj} · ${ok.length}/${qs.length}문항</div></div>`;
  });
  const rows = ps.map((p) => {
    const a = ans(p);
    const ok = a === p.answer;
    return `<tr class="click ${ok ? "" : "wrong"}" data-pid="${p.id}">
      <td>${p.num}</td><td class="m-ox ${ok ? "o" : "x"}">${ok ? "O" : "X"}</td>
      <td>${showAnswer(p, a)}</td><td>${showAnswer(p, p.answer)}</td>
      <td class="muted small">${p.points}점 · ${esc(p.unit_name)}${unsure.has(p.num) ? " · 헷갈림" : ""}</td>
      <td class="muted small">${d.ms?.[p.num] ? clock(d.ms[p.num]) : ""}</td></tr>`;
  });
  screen(`
    <header class="top"><h1>${esc(examLabel(session.exam))}</h1><span class="muted">${session.day}</span></header>
    <div class="card center m-score">
      <div class="m-big">${session.score}<small>점</small></div>
      <div class="muted">${session.n_correct}/${session.n_total}문항 · 걸린 시간 ${clock(session.ms)}${session.ms > EXAM_MINUTES * 60000 ? " (시간 초과)" : ""}</div>
    </div>
    <div class="m-kpis">${bySubj.join("")}</div>
    <p class="muted small">줄을 누르면 문제를 다시 볼 수 있어요. 틀린 문제와 헷갈린 문제는 오답 복습에 들어갔어요.</p>
    <div class="m-tbl"><table>
      <tr><th>번호</th><th></th><th>내 답</th><th>정답</th><th>배점·단원</th><th>시간</th></tr>
      ${rows.join("")}
    </table></div>
    <div id="peek"></div>
    <button class="btn primary big" id="home">처음으로</button>`);
  tap("#home", home);
  tap("tr[data-pid]", (tr) => peek(S.byId[tr.dataset.pid], ans(S.byId[tr.dataset.pid])));
}

/** Show a finished problem with the student's answer and the key, under the results table. */
function peek(p, mine) {
  const box = $app.querySelector("#peek");
  box.innerHTML = `<div class="card m-peek">
    <div class="m-row"><b>${p.num}번</b><button class="btn small-btn" id="close">닫기</button></div>
    ${problemHtml(p)}
    <p>내 답 <b>${showAnswer(p, mine)}</b> · 정답 <b>${showAnswer(p, p.answer)}</b></p></div>`;
  showImage(p);
  box.querySelector("#close").addEventListener("click", () => (box.innerHTML = ""));
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ───────────── 단원 연습 / 오답 복습 (one problem at a time, graded right away) ─────────────
function startUnit(unit) {
  const tried = new Set(S.attempts.map((a) => a.problem_id));
  const pool = S.problems.filter((p) => p.unit === unit && !tried.has(p.id));
  // oldest papers first, so the newest ones stay fresh for 실전; easier first within a paper era
  pool.sort((a, b) => S.examById[a.exam].held_on.localeCompare(S.examById[b.exam].held_on) || a.points - b.points || a.num - b.num);
  const pick = pool.slice(0, UNIT_SET).sort((a, b) => a.points - b.points);
  if (!pick.length) {
    screen(`<div class="card"><h2>${esc(unitName(unit))}</h2><p>이 단원의 기출을 모두 풀었어요! 틀린 문제는 오답 복습에서 다시 나와요.</p>
      <button class="btn primary big" id="home">처음으로</button></div>`);
    tap("#home", home);
    return;
  }
  runQueue("unit", pick, unit);
}

async function runQueue(mode, list, unit = null) {
  const session = {
    id: `${DAY}-${mode}-${Date.now()}`, day: DAY, mode, unit,
    started_at: new Date().toISOString(), draft: {},
  };
  const results = [];
  const t0 = Date.now();
  try {
    await mdb.saveSession(session);
  } catch (e) {
    return fail(e);
  }
  const title = mode === "review" ? "오답 다시 풀기" : `단원 연습 · ${unitName(unit)}`;

  const show = (i) => {
    if (i >= list.length) return finish();
    const p = list[i];
    const r = S.reviewById[p.id];
    let value = null;
    let tries = 0;
    const shownAt = performance.now();
    screen(`
      <div class="m-bar"><button class="btn small-btn" id="quit">그만하기</button><span>${esc(title)}</span><span class="muted small">${i + 1}/${list.length}</span></div>
      ${mode === "review" && r ? `<p class="muted small">${r.added_on.slice(5).replace("-", "/")}에 틀린 문제 · 복습 ${r.box}단계</p>` : ""}
      ${problemHtml(p)}
      ${answerHtml(p, null)}
      <label class="m-unsure"><input type="checkbox" id="unsure"/> 헷갈려요 (맞아도 다시 나오게)</label>
      <div id="fb"></div>
      <button class="btn primary big" id="check" ${p.is_choice ? "disabled" : ""}>채점</button>`);
    showImage(p, list[i + 1]);
    const $check = $app.querySelector("#check");
    tap(".m-ch", (b) => {
      if ($check.dataset.locked) return;
      value = Number(b.dataset.v);
      $app.querySelectorAll(".m-ch").forEach((x) => x.classList.toggle("on", x === b));
      $check.disabled = false;
    });
    const num = $app.querySelector("#num");
    if (num) {
      num.addEventListener("input", () => (num.value = num.value.replace(/\D/g, "").slice(0, 3)));
      num.addEventListener("keydown", (e) => { if (e.key === "Enter") $check.click(); });
      num.focus({ preventScroll: true });
    }
    tap("#quit", finish);
    $check.addEventListener("click", async () => {
      if ($check.dataset.locked) return;
      if (!p.is_choice) value = readShort();
      if (value === null) {
        $app.querySelector("#fb").innerHTML = `<p class="m-fb bad">0~999 사이의 정수로 입력하세요.</p>`;
        return;
      }
      tries++;
      const correct = value === p.answer;
      const unsure = $app.querySelector("#unsure").checked;
      if (tries === 1) {
        // the first try is what counts
        const row = { day: DAY, session_id: session.id, problem_id: p.id, mode, answer: value, correct, unsure, ms: Math.round(performance.now() - shownAt) };
        results.push(row);
        S.attempts.push(row);
        let rv = null;
        if (mode === "review" && r) rv = afterReview(r, correct, unsure, DAY);
        else if (!correct || unsure) rv = addToReview(S.reviewById[p.id], p.id, DAY, !correct);
        try {
          await mdb.logAttempts([row]);
          if (rv) {
            await mdb.saveReview([rv]);
            S.reviewById[p.id] = rv;
            S.review = Object.values(S.reviewById);
          }
        } catch (e) {
          return fail(e);
        }
      }
      const fb = $app.querySelector("#fb");
      if (correct) {
        $check.dataset.locked = "1";
        const rv = S.reviewById[p.id];
        const note = mode === "review" && rv
          ? rv.box >= GRADUATED ? "세 번 연속 맞혀서 졸업했어요!" : tries > 1 ? "다음 복습에 다시 나와요." : `다음 복습: ${rv.next_review?.slice(5).replace("-", "/")}`
          : tries > 1 ? "두 번째에 맞혔어요. 오답 복습에 넣어 뒀어요." : unsure ? "헷갈렸다고 해서 오답 복습에 넣었어요." : "";
        fb.innerHTML = `<p class="m-fb good">정답이에요! ${showAnswer(p, p.answer)} <span class="small">${note}</span></p>`;
        $check.textContent = i + 1 < list.length ? "다음 문제" : "결과 보기";
        $check.onclick = () => show(i + 1);
      } else if (tries === 1) {
        fb.innerHTML = `<p class="m-fb bad">틀렸어요. 풀이를 다시 확인하고 한 번 더 풀어 보세요.</p>
          <div class="row"><button class="btn" id="reveal">정답 보기</button></div>`;
        $app.querySelector("#reveal").addEventListener("click", () => reveal());
        if (num) num.select();
      } else {
        reveal();
      }
      function reveal() {
        $check.dataset.locked = "1";
        fb.innerHTML = `<p class="m-fb bad">정답은 <b>${showAnswer(p, p.answer)}</b>이에요. 오답 복습에서 2일 뒤 다시 나와요.</p>`;
        $check.textContent = i + 1 < list.length ? "다음 문제" : "결과 보기";
        $check.disabled = false;
        $check.onclick = () => show(i + 1);
      }
    });
  };

  async function finish() {
    const done = {
      ...session, finished_at: new Date().toISOString(), ms: Date.now() - t0,
      n_correct: results.filter((r) => r.correct).length, n_total: results.length,
      score: list.filter((p) => results.find((r) => r.problem_id === p.id && r.correct)).reduce((t, p) => t + p.points, 0),
      total: list.filter((p) => results.find((r) => r.problem_id === p.id)).reduce((t, p) => t + p.points, 0),
    };
    try {
      if (results.length) await mdb.saveSession(done);
      else await mdb.deleteSession(session.id);
    } catch (e) {
      return fail(e);
    }
    S.sessions = results.length ? [done, ...S.sessions] : S.sessions;
    if (!results.length) return home();
    screen(`<div class="card center">
      <h2>${esc(title)} 끝!</h2>
      <div class="m-big">${done.n_correct}<small>/${done.n_total}</small></div>
      <p class="muted">첫 시도에 맞힌 문제 · ${mins(done.ms)}</p>
      <div class="m-tbl"><table>${results.map((r) => {
        const p = S.byId[r.problem_id];
        return `<tr><td class="m-ox ${r.correct ? "o" : "x"}">${r.correct ? "O" : "X"}</td><td>${srcLine(p)}</td><td>${showAnswer(p, r.answer)} → ${showAnswer(p, p.answer)}</td></tr>`;
      }).join("")}</table></div>
      <button class="btn primary big" id="home">처음으로</button></div>`);
    tap("#home", home);
  }

  show(0);
}

load();
