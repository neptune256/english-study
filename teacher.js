import { db, today, REMOTE } from "./db.js";
import { typeStats, PASSAGES_PER_DAY } from "./planner.js";

const $app = document.getElementById("app");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CIRCLED = ["①", "②", "③", "④", "⑤"];
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");
const STAGE_KO = { meaning: "뜻 고르기", word: "단어 고르기", cloze: "빈칸", context: "지문 속 의미", translate: "해석", spell: "철자" };
const mins = (ms) => Math.max(1, Math.round(ms / 60000)) + "분";

let D;

async function load() {
  const [state, daily, events, progress, passages, words] = await Promise.all([
    db.state(), db.allDaily(), db.events(), db.progress(), db.passages(), db.words(),
  ]);
  D = {
    state, daily, events, progress, passages, words,
    wordById: Object.fromEntries(words.map((w) => [w.id, w])),
    passageById: Object.fromEntries(passages.map((p) => [p.id, p])),
  };
  render();
}

function streak() {
  const done = new Set(D.daily.filter((d) => d.reading_done_at).map((d) => d.day));
  let n = 0;
  const d = new Date(today() + "T00:00:00Z");
  if (!done.has(today())) d.setUTCDate(d.getUTCDate() - 1);
  while (done.has(d.toISOString().slice(0, 10))) {
    n++;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return n;
}

function render() {
  const used = new Set(D.daily.flatMap((d) => d.passage_ids));
  const poolLeft = D.passages.filter((p) => !used.has(p.id)).length;
  const daysLeft = Math.floor(poolLeft / PASSAGES_PER_DAY);
  const learned = D.progress.filter((p) => p.box >= 1).length;
  const mastered = D.progress.filter((p) => p.box >= 5).length;
  const due = D.progress.filter((p) => p.box >= 1 && p.box <= 4 && p.next_review && p.next_review <= today()).length;

  $app.innerHTML = `
    <header class="top"><h1>학습 대시보드</h1><a href="index.html" class="muted small">학생 화면 →</a></header>
    ${REMOTE ? "" : `<p class="note">로컬 테스트 모드: 이 브라우저에 저장된 기록만 보입니다.</p>`}
    <div class="kpis">
      <div class="kpi"><div class="v">${D.state.level}</div><div class="l">지문 난이도 수준 (1~5)</div></div>
      <div class="kpi"><div class="v">${D.state.word_level}</div><div class="l">단어 수준 (1~5)</div></div>
      <div class="kpi"><div class="v">${streak()}일</div><div class="l">연속 학습</div></div>
      <div class="kpi"><div class="v">${learned}</div><div class="l">외운 단어 · 완전 암기 ${mastered}</div></div>
      <div class="kpi"><div class="v">${due}</div><div class="l">오늘까지 복습할 단어</div></div>
      <div class="kpi ${daysLeft < 7 ? "warn" : ""}"><div class="v">${poolLeft}</div><div class="l">남은 지문 (약 ${daysLeft}일분)</div></div>
    </div>

    <h2>날짜별 기록</h2>
    ${dailyTable()}
    <div id="detail"></div>

    <div class="two">
      <div><h2>자주 틀리는 단어</h2>${weakWords()}</div>
      <div><h2>유형별 정답률</h2>${typeTable()}</div>
    </div>

    <h2>지문·정답·풀이 <span class="muted small">(정답은 Claude가 직접 풀어 만든 것입니다. 검증 전 지문은 표시됩니다)</span></h2>
    ${bank()}`;

  $app.querySelectorAll("tr.click").forEach((tr) =>
    tr.addEventListener("click", () => {
      $app.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
      tr.classList.add("sel");
      showDay(tr.dataset.day);
    })
  );
  if (D.daily.length) showDay(D.daily[0].day);
}

function dailyTable() {
  if (!D.daily.length) return `<div class="card muted">아직 기록이 없습니다.</div>`;
  const rows = D.daily.map((d) => {
    const ev = D.events.filter((e) => e.day === d.day);
    const drill = ev.filter((e) => e.kind === "drill" && e.first_try);
    const rev = ev.filter((e) => e.kind === "review");
    const read = d.summary.readingDone || [];
    const ms = ev.reduce((a, e) => a + (e.ms || 0), 0);
    const st = d.summary.stats;
    return `<tr class="click" data-day="${d.day}">
      <td>${d.day}</td>
      <td>${(d.summary.wordsDone || []).length}/${d.word_ids.length} · 첫 시도 ${pct(drill.filter((e) => e.correct).length, drill.length)}</td>
      <td>${rev.length ? `${rev.filter((e) => e.correct).length}/${rev.length}` : "–"}</td>
      <td>${d.passage_ids.map((id) => {
        const r = read.find((x) => x.id === id);
        const p = D.passageById[id];
        return `${r ? `<span class="ox ${r.correct ? "o" : "x"}">${r.correct ? "O" : "X"}</span>` : "·"} <span class="small">${esc(p?.qtype)}</span>`;
      }).join(" &nbsp; ")}</td>
      <td>${d.level_at_start}${st ? ` → ${st.levelAfter}` : ""}</td>
      <td>${ms ? mins(ms) : "–"}</td>
    </tr>`;
  });
  return `<div class="tbl-wrap"><table>
    <tr><th>날짜</th><th>단어 (완료 · 첫 시도 정답률)</th><th>복습</th><th>독해</th><th>수준</th><th>소요</th></tr>
    ${rows.join("")}</table></div>`;
}

function showDay(day) {
  const d = D.daily.find((x) => x.day === day);
  const ev = D.events.filter((e) => e.day === day);
  const wordRows = d.word_ids.map((id) => {
    const w = D.wordById[id];
    const mine = ev.filter((e) => e.kind === "drill" && e.word_id === id);
    const wrongStages = mine.filter((e) => !e.correct).map((e) => STAGE_KO[e.stage] || e.stage);
    return `<tr><td><b>${esc(w?.word)}</b></td><td>${esc(w?.meaning)}</td>
      <td>${mine.length ? (wrongStages.length ? `<span class="x">${wrongStages.length}회</span> <span class="small muted">${[...new Set(wrongStages)].join(", ")}</span>` : `<span class="o">0</span>`) : "미학습"}</td></tr>`;
  });
  const read = d.summary.readingDone || [];
  const passages = d.passage_ids.map((id) => {
    const p = D.passageById[id];
    const rs = read.filter((r) => r.id === id);
    return p.questions.map((q) => {
      const r = rs.find((x) => x.qnum === q.qnum);
      return `<details class="p"><summary>${esc(p.source)} · ${esc(p.qtype)} · 난이도 ${p.difficulty}
        ${r ? `· 학생 ${CIRCLED[r.pick - 1]} / 정답 ${CIRCLED[q.answer - 1]} <span class="ox ${r.correct ? "o" : "x"}">${r.correct ? "O" : "X"}</span> · ${mins(r.ms)}` : "· 아직 안 풂"}
        ${p.answer_verified ? "" : `<span class="pill warn">정답 검증 필요</span>`}</summary>
        ${passageView(p, q)}</details>`;
    }).join("");
  });
  $app.querySelector("#detail").innerHTML = `
    <h2>${day} 상세</h2>
    <div class="two">
      <div><div class="tbl-wrap"><table><tr><th>단어</th><th>뜻</th><th>오답</th></tr>${wordRows.join("")}</table></div></div>
      <div class="card">${passages.join("")}</div>
    </div>`;
}

function passageView(p, q) {
  return `${p.box ? `<div class="pbody given">${esc(p.box)}</div>` : ""}
    <div class="pbody">${esc(p.body.replace(/\{\/?u\}/g, ""))}</div>
    <ol class="small">${q.choices.map((c, i) => `<li ${i + 1 === q.answer ? 'class="o"' : ""}>${esc(c)}</li>`).join("")}</ol>
    <p class="small"><b>풀이</b> ${esc(q.explanation)}</p>`;
}

function weakWords() {
  const wrong = {};
  for (const e of D.events) if ((e.kind === "drill" || e.kind === "review") && !e.correct) wrong[e.word_id] = (wrong[e.word_id] || 0) + 1;
  const top = Object.entries(wrong).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (!top.length) return `<div class="card muted">아직 없습니다.</div>`;
  return `<div class="tbl-wrap"><table><tr><th>단어</th><th>뜻</th><th>오답</th><th>복습 단계</th></tr>
    ${top.map(([id, n]) => {
      const w = D.wordById[id];
      const pr = D.progress.find((p) => p.word_id === id);
      return `<tr><td><b>${esc(w?.word)}</b></td><td>${esc(w?.meaning)}</td><td>${n}</td><td>${pr ? (pr.box >= 5 ? "완전 암기" : `${pr.box}단계 · 다음 ${pr.next_review || "–"}`) : "–"}</td></tr>`;
    }).join("")}</table></div>`;
}

function typeTable() {
  const s = Object.entries(typeStats(D.events, D.passageById)).sort((a, b) => a[1].correct / a[1].n - b[1].correct / b[1].n);
  if (!s.length) return `<div class="card muted">아직 없습니다.</div>`;
  return `<div class="tbl-wrap"><table><tr><th>유형</th><th>정답률</th><th>문항</th></tr>
    ${s.map(([t, v]) => `<tr><td>${esc(t)}</td><td><div class="bar-cell"><div class="bar-bg"><div class="bar-fg" style="width:${(100 * v.correct) / v.n}%"></div></div>${pct(v.correct, v.n)}</div></td><td>${v.correct}/${v.n}</td></tr>`).join("")}
  </table></div>`;
}

function bank() {
  const used = new Set(D.daily.flatMap((d) => d.passage_ids));
  return `<div class="card">${D.passages.map((p) => p.questions.map((q) => `
    <details class="p"><summary>${esc(p.source)} · ${esc(p.qtype)} · 난이도 ${p.difficulty} · 정답 ${CIRCLED[q.answer - 1]}
      ${used.has(p.id) ? `<span class="pill">출제됨</span>` : ""}${p.answer_verified ? "" : `<span class="pill warn">검증 필요</span>`}</summary>
      ${passageView(p, q)}
      <p class="small muted">핵심 단어: ${p.words.map((w) => esc(D.wordById[w.id]?.word || w.id)).join(", ")}</p>
    </details>`).join("")).join("")}</div>`;
}

load().catch((e) => {
  console.error(e);
  $app.innerHTML = `<div class="card"><h2>불러오지 못했어요</h2><p class="muted small">${esc(e.message)}</p></div>`;
});
