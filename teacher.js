import { db, today, addDays, REMOTE } from "./db.js";
import { typeStats, PASSAGES_PER_DAY, GRAMMAR } from "./planner.js";
import { recall, masteryLabel, isDue, MASTERED_DAYS } from "./memory.js";

const DAY = new URLSearchParams(location.search).get("day") || today(); // ?day= to preview another date
let filter = "all";

const $app = document.getElementById("app");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CIRCLED = ["①", "②", "③", "④", "⑤"];
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");
const STAGE_KO = {
  recall: "떠올리기", match: "짝 맞추기", listen: "듣고 뜻", synonym: "유의어", usage: "어색한 문장", dictation: "듣고 쓰기", sense: "여러 뜻",
  meaning: "뜻 고르기", word: "단어 고르기", cloze: "빈칸", context: "지문 속 의미", translate: "해석", spell: "철자",
};
const stageKo = (s) => (s?.startsWith("final:") ? "최종 점검(" + (STAGE_KO[s.slice(6)] || s.slice(6)) + ")" : STAGE_KO[s] || s);
const mins = (ms) => Math.max(1, Math.round(ms / 60000)) + "분";

let D;

async function load() {
  const [state, daily, events, progress, passages, words, submissions] = await Promise.all([
    db.state(), db.allDaily(), db.events(), db.progress(), db.passages(), db.words(), db.submissions(),
  ]);
  D = {
    state, daily, events, progress, passages, words, submissions,
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
  const unused = D.passages.filter((p) => !used.has(p.id));
  const poolLeft = unused.filter((p) => p.qtype !== GRAMMAR).length;
  const grammarLeft = unused.filter((p) => p.qtype === GRAMMAR).length;
  const daysLeft = Math.min(Math.floor(poolLeft / PASSAGES_PER_DAY), grammarLeft);
  const learned = D.progress.filter((p) => p.learned_on).length;
  const mastered = D.progress.filter((p) => (p.stability ?? 0) >= MASTERED_DAYS).length;
  const due = D.progress.filter((p) => isDue(p, DAY)).length;
  const avgR = learned ? D.progress.filter((p) => p.learned_on).reduce((a, p) => a + recall(p, DAY), 0) / learned : 0;

  const runout = addDays(DAY, daysLeft);
  $app.innerHTML = `
    <header class="top"><h1>학습 대시보드</h1><span class="small"><a href="math-teacher.html${location.search}" class="muted">수학 대시보드 →</a> · <a href="index.html" class="muted">학생 화면 →</a></span></header>
    ${REMOTE ? "" : `<p class="note">로컬 테스트 모드: 이 브라우저에 저장된 기록만 보입니다.</p>`}
    ${homeworkSection()}
    <h2>주간 테스트 <span class="muted small">토·일 · 지난주에 배운 단어 (약한 단어 전부 + 나머지 일부) · 객관식</span></h2>
    <div id="weekly">${weeklySection()}</div>
    ${daysLeft <= 5 ? `<div class="alert">⚠ 새 지문이 <b>약 ${daysLeft}일분</b> 남았습니다 (예상 소진 ${runout.slice(5).replace("-", "/")}).
      컴퓨터를 켜고 Claude 앱을 열어 두면 저녁 8시 예약 작업이 자동으로 채웁니다.
      바닥나도 앱은 멈추지 않고 예전에 틀린 지문을 다시 냅니다.</div>` : ""}
    <div class="kpis">
      <div class="kpi"><div class="v">${D.state.level}</div><div class="l">지문 난이도 수준 (1~5)</div></div>
      <div class="kpi"><div class="v">${D.state.word_level}</div><div class="l">단어 수준 (1~5)</div></div>
      <div class="kpi"><div class="v">${streak()}일</div><div class="l">연속 학습</div></div>
      <div class="kpi"><div class="v">${learned}</div><div class="l">외운 단어 · 완전 암기 ${mastered}</div></div>
      <div class="kpi"><div class="v">${learned ? Math.round(avgR * 100) + "%" : "–"}</div><div class="l">외운 단어 평균 기억 확률</div></div>
      <div class="kpi"><div class="v">${due}</div><div class="l">오늘까지 복습할 단어</div></div>
    </div>

    <h2>지문 창고 <span class="muted small">아직 학생에게 내지 않은 지문 · 매일 독해 ${PASSAGES_PER_DAY}개 + 어법 1개씩 씁니다</span></h2>
    ${stockSection(unused, poolLeft, grammarLeft, daysLeft, runout)}

    <h2>날짜별 기록</h2>
    ${dailyTable()}
    <div id="detail"></div>

    <h2>지문 분석 제출물 <span class="muted small">학생이 올린 PDF (채점 없음)</span></h2>
    ${submissionList()}

    <h2>단어 숙지도 <span class="muted small">기억 확률 = 지금 물어보면 맞힐 확률 추정치. 90% 아래로 떨어지는 날이 복습일입니다.</span></h2>
    <div id="mastery">${masterySection()}</div>

    <h2>유형별 정답률</h2>${typeTable()}

    <h2>지문·정답·풀이 <span class="muted small">(정답은 Claude가 직접 풀어 만든 것입니다. 검증 전 지문은 표시됩니다)</span></h2>
    ${bank()}`;

  $app.querySelectorAll("tr.click").forEach((tr) =>
    tr.addEventListener("click", () => {
      $app.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
      tr.classList.add("sel");
      showDay(tr.dataset.day);
    })
  );
  // A day in the 14-day strip opens that day's detail below the date table.
  $app.querySelectorAll(".hw-dot[data-day]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!D.daily.some((d) => d.day === b.dataset.day)) return;
      $app.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
      $app.querySelector(`tr.click[data-day="${b.dataset.day}"]`)?.classList.add("sel");
      showDay(b.dataset.day);
      $app.querySelector("#detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );
  bindMastery();
  bindWeekly();
  $app.querySelectorAll(".open-pdf").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openPdf(b); }));
  if (D.daily.length) showDay(D.daily[0].day);
}

// ───────────── homework check (did the student do yesterday's / today's work?) ─────────────
/** Each part of a day's work with done/total, and the day's overall status. */
function dayWork(day) {
  const d = D.daily.find((x) => x.day === day);
  if (!d) return { day, opened: false, status: "none", parts: [], ms: 0 };
  const s = d.summary || {};
  const ev = D.events.filter((e) => e.day === day);
  const read = s.readingDone || [];
  const needsAnalysis = d.passage_ids.some((id) => D.passageById[id]?.qtype !== GRAMMAR);
  const parts = [];
  if (d.review_ids.length) {
    const n = new Set(s.reviewsDone || []).size;
    parts.push({ name: "복습", done: n, total: d.review_ids.length, ok: n >= d.review_ids.length });
  }
  if (d.word_ids.length) {
    const n = (s.wordsDone || []).length;
    const ok = n >= d.word_ids.length && Boolean(s.finalDone);
    parts.push({
      name: "단어 외우기", done: n, total: d.word_ids.length, ok,
      note: n >= d.word_ids.length && !s.finalDone ? "최종 점검 남음" : "",
    });
  }
  if (d.passage_ids.length) {
    const correct = read.filter((r) => r.correct).length;
    parts.push({
      name: "독해 + 어법", done: read.length, total: d.passage_ids.length, ok: read.length >= d.passage_ids.length,
      note: read.length ? `${correct}/${read.length} 정답` : "",
    });
  }
  if (s.weekly) {
    const T = s.weekly, right = T.results.filter((r) => r.ok).length;
    parts.push({
      name: "주간 테스트", done: T.results.length, total: T.ids.length, ok: Boolean(T.done),
      note: T.results.length ? `${right}/${T.results.length} 정답` : "",
    });
  }
  if (needsAnalysis) parts.push({ name: "지문 분석 PDF", done: s.analysis ? 1 : 0, total: 1, ok: Boolean(s.analysis), note: s.analysis ? "제출함" : "" });
  const started = parts.some((p) => p.done > 0) || ev.length > 0;
  const status = parts.every((p) => p.ok) ? "done" : started ? "part" : "none";
  return { day, opened: true, status, parts, ms: ev.reduce((a, e) => a + (e.ms || 0), 0), analysis: s.analysis };
}

const HW_LABEL = { done: "다 했어요", part: "일부만 했어요", none: "안 했어요" };
const HW_MARK = { done: "✓", part: "◐", none: "✗" };
const weekday = (day) => "일월화수목금토"[new Date(day + "T00:00:00Z").getUTCDay()];
const md = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`;

function homeworkCard(day, title) {
  const w = dayWork(day);
  const isToday = day === DAY;
  // Today is still going: "not yet" instead of "didn't do it".
  const label = isToday && w.status !== "done" ? (w.status === "part" ? "하는 중" : "아직 시작 안 함") : HW_LABEL[w.status];
  const cls = isToday && w.status !== "done" ? "wait" : w.status;
  return `<div class="hw-card hw-${cls}">
    <div class="hw-head">
      <div><div class="hw-title">${title}</div><div class="muted small">${md(day)} (${weekday(day)})</div></div>
      <div class="hw-badge">${isToday && w.status === "none" ? "·" : HW_MARK[w.status]} ${label}</div>
    </div>
    ${w.opened
      ? `<ul class="hw-parts">${w.parts.map((p) => `
          <li class="${p.ok ? "ok" : p.done ? "half" : isToday ? "todo" : "no"}">
            <span class="hw-mk">${p.ok ? "✓" : p.done ? "◐" : isToday ? "·" : "✗"}</span>
            <span class="hw-name">${p.name}</span>
            <span class="hw-num">${p.total > 1 ? `${p.done}/${p.total}` : ""}${p.note ? ` <span class="muted small">${p.note}</span>` : ""}</span>
            ${p.name === "지문 분석 PDF" && w.analysis ? `<button class="btn open-pdf" data-path="${esc(w.analysis.path)}">PDF 열기</button>` : ""}
          </li>`).join("")}</ul>
         <div class="muted small">공부한 시간 약 ${w.ms ? mins(w.ms) : "0분"}</div>`
      : `<p class="muted">${isToday ? "오늘은 아직 앱을 열지 않았어요." : "이날은 앱을 열지 않았어요."}</p>`}
  </div>`;
}

function homeworkSection() {
  const days = Array.from({ length: 14 }, (_, i) => addDays(DAY, i - 13));
  const firstDay = D.daily.map((d) => d.day).sort()[0] || DAY; // before this the app wasn't in use
  const dots = days.map((day) => {
    const w = dayWork(day);
    const pre = day < firstDay;
    const cls = pre ? "pre" : day === DAY && w.status !== "done" ? "wait" : w.status;
    const tip = pre ? "시작 전" : day === DAY && w.status !== "done" ? "오늘 · 진행 중" : HW_LABEL[w.status];
    return `<button class="hw-dot hw-${cls}" ${w.opened ? `data-day="${day}"` : ""} title="${md(day)} ${tip}">
      <span class="hw-dm">${pre ? "–" : day === DAY && w.status === "none" ? "·" : HW_MARK[w.status]}</span><span class="hw-dd">${md(day)}</span><span class="hw-dw">${weekday(day)}</span></button>`;
  });
  const last7 = days.slice(6, 13).filter((d) => d >= firstDay).map(dayWork); // up to 7 days before today
  const full = last7.filter((w) => w.status === "done").length;
  return `<h2 style="margin-top:6px">과제 확인</h2>
    <div class="hw-grid">${homeworkCard(addDays(DAY, -1), "어제")}${homeworkCard(DAY, "오늘")}</div>
    <div class="hw-strip-head muted small">최근 2주 · 지난 ${last7.length}일 중 <b>${full}일</b> 다 했어요 · 날짜를 누르면 그날 기록이 아래에 열립니다</div>
    <div class="hw-strip">${dots.join("")}</div>`;
}

function stockSection(unused, poolLeft, grammarLeft, daysLeft, runout) {
  const reading = unused.filter((p) => p.qtype !== GRAMMAR);
  const bands = [
    { name: "쉬움 1~1.5", lo: 1, hi: 1.5 }, { name: "보통 2~2.5", lo: 2, hi: 2.5 },
    { name: "어려움 3~3.5", lo: 3, hi: 3.5 }, { name: "최상 4~5", lo: 4, hi: 5 },
  ].map((b) => ({ ...b, n: reading.filter((p) => p.difficulty >= b.lo && p.difficulty <= b.hi).length }));
  const lvl = D.state.level;
  const maxN = Math.max(1, ...bands.map((b) => b.n));
  const types = {};
  for (const p of reading) types[p.qtype] = (types[p.qtype] || 0) + 1;
  const lastAdded = D.passages.map((p) => p.created_at).filter(Boolean).sort().pop();
  const readDays = Math.floor(poolLeft / PASSAGES_PER_DAY);
  return `<div class="stock">
    <div class="kpi ${readDays <= 5 ? "warn" : ""}"><div class="v">${poolLeft}개</div><div class="l">남은 독해 지문 · ${readDays}일분</div></div>
    <div class="kpi ${grammarLeft <= 5 ? "warn" : ""}"><div class="v">${grammarLeft}개</div><div class="l">남은 어법 문제 · ${grammarLeft}일분</div></div>
    <div class="kpi ${daysLeft <= 5 ? "warn" : ""}"><div class="v">${runout.slice(5).replace("-", "/")}</div><div class="l">예상 소진일 (매일 공부할 때)</div></div>
    <div class="kpi"><div class="v">${D.passages.length}개</div><div class="l">전체 보유${lastAdded ? ` · 최근 보충 ${new Date(lastAdded).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}` : ""}</div></div>
  </div>
  <div class="two">
    <div class="card"><div class="small muted">남은 독해 지문 난이도 (학생 수준 ${lvl} 구간 강조)</div>
      ${bands.map((b) => `<div class="band ${lvl >= b.lo - 0.5 && lvl <= b.hi + 0.5 ? "here" : ""}">
        <span class="bn">${b.name}</span>
        <div class="bar-bg"><div class="bar-fg" style="width:${(100 * b.n) / maxN}%"></div></div><b>${b.n}</b></div>`).join("")}
    </div>
    <div class="card"><div class="small muted">남은 독해 지문 유형</div>
      <div class="types">${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<span class="pill">${esc(t)} ${n}</span>`).join("") || "<span class='muted'>없음</span>"}</div>
    </div>
  </div>`;
}

const TEST_KO = { meaning: "뜻 고르기", word: "단어 고르기", cloze: "빈칸", synonym: "유의어", sense: "여러 뜻", listen: "듣고 뜻", usage: "어색한 문장" };

/** All weekly tests, newest first: {week (its Saturday), day (set that holds it), T}. */
function weeklyTests() {
  return D.daily
    .filter((d) => d.summary?.weekly)
    .map((d) => ({ week: d.summary.weekly.week || d.day, day: d.day, T: d.summary.weekly }))
    .sort((a, b) => b.week.localeCompare(a.week));
}
const testScore = (T) => {
  const total = T.results.length, right = T.results.filter((r) => r.ok).length;
  return { total, right, p: total ? Math.round((100 * right) / total) : 0 };
};

function weeklySection() {
  const tests = weeklyTests();
  // This weekend's test not taken yet?
  const dow = new Date(DAY + "T00:00:00Z").getUTCDay();
  const sat = dow === 6 ? DAY : dow === 0 ? addDays(DAY, -1) : null;
  const pending = sat && !tests.some((t) => t.week === sat && t.T.done)
    ? `<div class="alert" style="border-color:var(--accent)">이번 주 테스트(${md(sat)} 토)는 아직 ${tests.some((t) => t.week === sat) ? "푸는 중" : "안 봤어요"} · 일요일까지 열려 있어요.</div>` : "";
  if (!tests.length) return pending + `<div class="card muted">아직 본 주간 테스트가 없습니다. 테스트는 매주 토요일에 열리고 일요일까지 볼 수 있습니다.</div>`;

  // How often each word was missed across all tests (for "또 틀림").
  const missCount = {};
  for (const { T } of tests) for (const r of T.results) if (!r.ok) missCount[r.id] = (missCount[r.id] || 0) + 1;

  const latest = tests[0], prev = tests[1];
  const s = testScore(latest.T), ps = prev ? testScore(prev.T) : null;
  const byKind = {};
  for (const r of latest.T.results) {
    const k = (byKind[r.kind] ||= { n: 0, ok: 0 });
    k.n++;
    if (r.ok) k.ok++;
  }
  const wrong = latest.T.results.filter((r) => !r.ok);
  const diff = ps ? s.p - ps.p : null;

  return pending + `
    <div class="card wk-latest">
      <div class="wk-head">
        <div>
          <div class="muted small">최근 테스트 · ${md(latest.week)} 주${latest.T.finished_on && latest.T.finished_on !== latest.week ? ` · ${md(latest.T.finished_on)}(${weekday(latest.T.finished_on)})에 봄` : ""}${latest.T.done ? "" : ` · <span class="x">진행 중 ${s.total}/${latest.T.ids.length}</span>`}</div>
          <div class="wk-score">${s.right}<span class="muted"> / ${s.total}</span> <span class="wk-pct">${s.p}%</span>
            ${diff !== null ? `<span class="small ${diff >= 0 ? "o" : "x"}">지난주 대비 ${diff >= 0 ? "▲" : "▼"} ${Math.abs(diff)}%p</span>` : ""}</div>
        </div>
        <div class="wk-actions">
          <button class="btn" data-copy="${latest.day}">틀린 단어 복사</button>
          <button class="btn primary" data-print="${latest.day}">복습 퀴즈지 인쇄</button>
        </div>
      </div>
      <div class="wk-kinds">${Object.entries(byKind).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n).map(([k, v]) => `
        <div class="band"><span class="bn">${TEST_KO[k] || k}</span>
          <div class="bar-bg"><div class="bar-fg ${v.ok / v.n < 0.6 ? "lv-fading" : ""}" style="width:${(100 * v.ok) / v.n}%"></div></div><b>${v.ok}/${v.n}</b></div>`).join("")}</div>
      ${wrong.length ? `<div class="tbl-wrap"><table>
        <tr><th>#</th><th>틀린 단어 (${wrong.length})</th><th>뜻</th><th>유형</th><th>학생이 고른 답</th><th>정답</th></tr>
        ${wrong.map((r, i) => {
          const w = D.wordById[r.id];
          const again = missCount[r.id] > 1;
          return `<tr><td class="muted">${i + 1}</td><td><b>${esc(w?.word || r.id)}</b>${again ? ` <span class="pill warn">${missCount[r.id]}번째 틀림</span>` : ""}</td>
            <td class="small">${esc(w?.meaning)}</td><td class="small">${TEST_KO[r.kind] || r.kind}</td>
            <td class="small x">${esc(r.picked || "")}</td><td class="small o">${esc(r.right || "")}</td></tr>`;
        }).join("")}</table></div>` : `<p class="o">틀린 단어 없음 🎉</p>`}
    </div>
    ${tests.length > 1 ? `<div class="tbl-wrap"><table>
      <tr><th>주</th><th>점수</th><th>정답률</th><th>틀린 단어</th><th></th></tr>
      ${tests.map(({ week, day, T }) => {
        const t = testScore(T);
        const miss = T.results.filter((r) => !r.ok).map((r) => D.wordById[r.id]?.word || r.id);
        return `<tr><td>${md(week)} 주</td><td><b>${t.right}/${t.total}</b>${T.done ? "" : ` <span class="pill warn">진행 중</span>`}</td>
          <td><div class="bar-cell"><div class="bar-bg"><div class="bar-fg" style="width:${t.p}%"></div></div>${t.p}%</div></td>
          <td class="small">${esc(miss.join(", ")) || "–"}</td>
          <td style="white-space:nowrap"><button class="btn" data-copy="${day}">복사</button> <button class="btn" data-print="${day}">인쇄</button></td></tr>`;
      }).join("")}</table></div>` : ""}`;
}

function testWrongWords(day) {
  const T = D.daily.find((d) => d.day === day)?.summary.weekly;
  return (T?.results || []).filter((r) => !r.ok).map((r) => D.wordById[r.id]).filter(Boolean);
}

function bindWeekly() {
  $app.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const words = testWrongWords(b.dataset.copy);
      const text = words.map((w, i) => `${i + 1}. ${w.word} - ${w.meaning}`).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        const t = b.textContent;
        b.textContent = `복사됨 (${words.length}개)`;
        setTimeout(() => (b.textContent = t), 1500);
      } catch {
        prompt("아래 내용을 복사하세요", text);
      }
    })
  );
  $app.querySelectorAll("[data-print]").forEach((b) => b.addEventListener("click", () => printQuiz(b.dataset.print)));
}

/** Review quiz sheet from a test's wrong words: questions (word → meaning, meaning → word), then the answer key. */
function printQuiz(day) {
  const T = D.daily.find((d) => d.day === day)?.summary.weekly;
  const words = testWrongWords(day);
  if (!words.length) return alert("틀린 단어가 없어요.");
  // Half the items ask for the meaning, half for the word, in mixed order.
  const items = words.map((w, i) => ({ w, toKo: i % 2 === 0 })).sort(() => Math.random() - 0.5);
  const sheet = document.createElement("div");
  sheet.className = "print-sheet";
  sheet.innerHTML = `
    <div class="print-bar no-print"><button class="btn primary" id="pq-print">인쇄</button><button class="btn" id="pq-close">닫기</button></div>
    <h1>주간 테스트 복습 퀴즈 · ${md(T?.week || day)} 주 · ${words.length}문제</h1>
    <p class="pg">이름: ____________ &nbsp; 날짜: ____________ &nbsp; 점수: ______ / ${words.length}</p>
    <ol class="pq">${items.map(({ w, toKo }) => `<li>${toKo ? `<b>${esc(w.word)}</b> <span class="pg">(${esc(w.pos)})</span> → 뜻: ______________________` : `${esc(w.meaning)} → 영어: ______________________`}</li>`).join("")}</ol>
    <div class="pq-key">
      <h1>정답</h1>
      <ol class="pq small">${items.map(({ w }) => `<li><b>${esc(w.word)}</b> = ${esc(w.meaning)}</li>`).join("")}</ol>
    </div>`;
  document.body.appendChild(sheet);
  document.body.classList.add("printing");
  const close = () => { sheet.remove(); document.body.classList.remove("printing"); };
  sheet.querySelector("#pq-print").addEventListener("click", () => window.print());
  sheet.querySelector("#pq-close").addEventListener("click", close);
  window.scrollTo(0, 0);
}

function submissionList() {
  if (!D.submissions.length) return `<div class="card muted">아직 제출된 분석이 없습니다.</div>`;
  return `<div class="tbl-wrap"><table>
    <tr><th>날짜</th><th>지문</th><th>학생 정답 여부</th><th>파일</th><th>제출 시각</th><th></th></tr>
    ${D.submissions.map((s) => {
      const p = D.passageById[s.passage_id];
      const d = D.daily.find((x) => x.day === s.day);
      const r = d?.summary.readingDone?.find((x) => x.id === s.passage_id);
      return `<tr>
        <td>${esc(s.day)}</td>
        <td>${esc(p?.source || s.passage_id)} <span class="small muted">${esc(p?.qtype || "")}</span></td>
        <td>${r ? `<span class="ox ${r.correct ? "o" : "x"}">${r.correct ? "O" : "X"}</span>` : "–"}</td>
        <td class="small">${esc(s.file_name || "")} ${s.size ? `(${(s.size / 1048576).toFixed(1)}MB)` : ""}</td>
        <td class="small">${new Date(s.submitted_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</td>
        <td><button class="btn open-pdf" data-path="${esc(s.path)}">PDF 열기</button></td>
      </tr>`;
    }).join("")}</table></div>`;
}

async function openPdf(btn) {
  // Open the tab right away (inside the click) so it isn't blocked, then fill it.
  const w = window.open("", "_blank");
  btn.disabled = true;
  try {
    const blob = await db.analysisFile(btn.dataset.path);
    if (!blob) {
      w?.close();
      alert("로컬 테스트 모드에서는 파일이 저장되지 않아요.");
      return;
    }
    const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    if (w) w.location.href = url;
    else location.href = url;
  } catch (e) {
    w?.close();
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ───────────── word mastery ─────────────
const LABEL_ORDER = ["fading", "due", "fresh", "solid", "mastered"];
const LABEL_TEXT = { fading: "잊는 중", due: "복습 필요", fresh: "익히는 중", solid: "탄탄", mastered: "완전 암기" };

function wordRows() {
  const wrongBy = {}, msBy = {};
  for (const e of D.events) {
    if (!e.word_id) continue;
    if (!e.correct) wrongBy[e.word_id] = (wrongBy[e.word_id] || 0) + 1;
    if (e.kind === "drill" && e.first_try && e.ms) (msBy[e.word_id] ||= []).push(e.ms);
  }
  return D.progress
    .filter((p) => p.learned_on)
    .map((p) => {
      const ms = msBy[p.word_id] || [];
      return {
        p, w: D.wordById[p.word_id], R: recall(p, DAY), label: masteryLabel(p, DAY),
        wrong: wrongBy[p.word_id] || 0, avgMs: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null,
      };
    })
    .sort((a, b) => a.R - b.R);
}

function masterySection() {
  const rows = wordRows();
  if (!rows.length) return `<div class="card muted">아직 외운 단어가 없습니다.</div>`;
  const count = Object.fromEntries(LABEL_ORDER.map((k) => [k, rows.filter((r) => r.label.key === k).length]));
  // Reviews coming up over the next 14 days.
  const ahead = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(DAY, i);
    const n = D.progress.filter((p) => p.next_review && (i === 0 ? p.next_review <= d : p.next_review === d)).length;
    return { d, n };
  });
  const maxN = Math.max(1, ...ahead.map((a) => a.n));
  const shown = filter === "all" ? rows : rows.filter((r) => r.label.key === filter);
  const dday = (d) => {
    if (!d) return "더 안 봄";
    const n = Math.round((new Date(d) - new Date(DAY)) / 86400000);
    return n <= 0 ? `<b class="x">오늘</b>` : `${d.slice(5)} (D-${n})`;
  };
  return `
    <div class="chips">
      <button class="chip ${filter === "all" ? "on" : ""}" data-f="all">전체 ${rows.length}</button>
      ${LABEL_ORDER.map((k) => `<button class="chip lv-${k} ${filter === k ? "on" : ""}" data-f="${k}">${LABEL_TEXT[k]} ${count[k]}</button>`).join("")}
    </div>
    <div class="card forecast">
      <div class="small muted">앞으로 14일 복습 예정 단어 수</div>
      <div class="fc-row">${ahead.map((a, i) => `
        <div class="fc" title="${a.d}: ${a.n}개">
          <div class="fc-bar"><div style="height:${(100 * a.n) / maxN}%"></div></div>
          <div class="fc-n">${a.n || ""}</div><div class="fc-d">${i === 0 ? "오늘" : a.d.slice(8)}</div>
        </div>`).join("")}</div>
    </div>
    <div class="tbl-wrap"><table>
      <tr><th>단어</th><th>뜻</th><th>기억 확률</th><th>상태</th><th>기억 지속</th><th>첫날 퀴즈</th><th>평균 응답</th><th>복습 · 실수</th><th>다음 복습</th></tr>
      ${shown.map(({ p, w, R, label, wrong, avgMs }) => `<tr>
        <td><b>${esc(w?.word || p.word_id)}</b></td>
        <td class="small">${esc(w?.meaning)}</td>
        <td><div class="bar-cell"><div class="bar-bg"><div class="bar-fg lv-${label.key}" style="width:${Math.round(R * 100)}%"></div></div>${Math.round(R * 100)}%</div></td>
        <td><span class="pill lv-${label.key}">${label.text}</span></td>
        <td>${p.stability != null ? (p.stability < 1 ? "1일 미만" : Math.round(p.stability) + "일") : "–"}</td>
        <td>${p.drill_score != null ? Math.round(p.drill_score * 100) + "점" : "–"}</td>
        <td>${avgMs ? (avgMs / 1000).toFixed(1) + "초" : "–"}</td>
        <td>${p.reps || 0}회 · <span class="${p.lapses ? "x" : ""}">${p.lapses || 0}</span> <span class="small muted">(오답 ${wrong})</span></td>
        <td>${dday(p.next_review)}</td>
      </tr>`).join("")}
    </table></div>
    <p class="small muted">기억 지속 = 마지막 복습 후 기억 확률이 90%로 떨어지기까지 걸리는 일수. 첫날 퀴즈 = 처음 외운 날 7단계 퀴즈를 첫 시도에 맞힌 정도(어려운 단계·빠른 응답일수록 높음). 복습에서 맞히면 기억 지속이 늘고, 틀리면 30%로 줄어듭니다.</p>`;
}

function bindMastery() {
  $app.querySelectorAll("#mastery .chip").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.f;
      $app.querySelector("#mastery").innerHTML = masterySection();
      bindMastery();
    })
  );
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
      <td>${(d.summary.wordsDone || []).length}/${d.word_ids.length}${(d.summary.relearnIds || []).length ? ` <span class="tag-re">(다시 ${d.summary.relearnIds.length})</span>` : ""} · 첫 시도 ${pct(drill.filter((e) => e.correct).length, drill.length)}</td>
      <td>${rev.length ? `${rev.filter((e) => e.correct).length}/${rev.length}` : "–"}</td>
      <td>${d.passage_ids.map((id) => {
        const r = read.find((x) => x.id === id);
        const p = D.passageById[id];
        return `${r ? `<span class="ox ${r.correct ? "o" : "x"}">${r.correct ? "O" : "X"}</span>` : "·"} <span class="small">${esc(p?.qtype)}</span>`;
      }).join(" &nbsp; ")}</td>
      <td>${d.summary.analysis ? `<button class="btn open-pdf" data-path="${esc(d.summary.analysis.path)}">PDF</button>` : "–"}</td>
      <td>${d.level_at_start}${st ? ` → ${st.levelAfter}` : ""}</td>
      <td>${ms ? mins(ms) : "–"}</td>
    </tr>`;
  });
  return `<div class="tbl-wrap"><table>
    <tr><th>날짜</th><th>단어 (완료 · 첫 시도 정답률)</th><th>복습</th><th>독해</th><th>분석</th><th>수준</th><th>소요</th></tr>
    ${rows.join("")}</table></div>`;
}

function showDay(day) {
  const d = D.daily.find((x) => x.day === day);
  const ev = D.events.filter((e) => e.day === day);
  const wordRows = d.word_ids.map((id) => {
    const w = D.wordById[id];
    const mine = ev.filter((e) => e.kind === "drill" && e.word_id === id);
    const wrongStages = mine.filter((e) => !e.correct).map((e) => stageKo(e.stage));
    const re = (d.summary.relearnIds || []).includes(id);
    return `<tr><td><b>${esc(w?.word)}</b>${re ? `<span class="tag-re">다시 배우기</span>` : ""}</td><td>${esc(w?.meaning)}</td>
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
    <div class="detail-head"><h2>${day} 상세</h2>
      <button class="btn primary" id="class-pdf">수업용 PDF 만들기</button></div>
    <div class="two">
      <div><div class="tbl-wrap"><table><tr><th>단어</th><th>뜻</th><th>오답</th></tr>${wordRows.join("")}</table></div></div>
      <div class="card">${passages.join("")}</div>
    </div>`;
  $app.querySelector("#class-pdf").addEventListener("click", () => printClass(day));
}

// ───────────── class handout: one day's words + reading questions, then an answer key ─────────────
/** Passage text for print: underlines kept, blanks as lines, paragraphs kept. */
function printBody(text) {
  return esc(text)
    .replace(/\{u\}/g, "<u>").replace(/\{\/u\}/g, "</u>")
    .replace(/_{3,}/g, "<span class='pblank'></span>")
    .split(/\n{2,}/).map((x) => `<p>${x.replace(/\n/g, "<br>")}</p>`).join("");
}

function printClass(day) {
  const d = D.daily.find((x) => x.day === day);
  if (!d) return;
  const read = d.summary.readingDone || [];
  const words = d.word_ids.map((id) => D.wordById[id]).filter(Boolean);
  const reviews = (d.review_ids || []).map((id) => D.wordById[id]).filter(Boolean);
  // One numbered item per question (a passage normally has one).
  const items = d.passage_ids.flatMap((id) => {
    const p = D.passageById[id];
    return p ? p.questions.map((q) => ({ p, q, r: read.find((x) => x.id === id && x.qnum === q.qnum) })) : [];
  });
  const choicesHtml = (q) => {
    const symbolsOnly = q.choices.every((c, i) => c.trim() === CIRCLED[i]); // 어법·무관: marks are in the text
    return symbolsOnly
      ? `<div class="pc-row">${q.choices.map((c) => `<span>${esc(c)}</span>`).join("")}</div>`
      : `<ol class="pc-list">${q.choices.map((c, i) => `<li><span class="pc-n">${CIRCLED[i]}</span> ${esc(c)}</li>`).join("")}</ol>`;
  };
  const wordList = (list) => `<div class="pw-grid">${list.map((w) => `
      <div class="pw"><b>${esc(w.word)}</b> <span class="pw-pos">${esc(w.pos)}</span><div>${esc(w.meaning)}</div></div>`).join("")}</div>`;

  const sheet = document.createElement("div");
  sheet.className = "print-sheet class-sheet";
  sheet.innerHTML = `
    <div class="print-bar no-print">
      <button class="btn primary" id="pc-print">PDF로 저장 / 인쇄</button>
      <button class="btn" id="pc-close">닫기</button>
      <span class="muted small">인쇄 창에서 대상(프린터)을 "PDF로 저장"으로 고르면 파일로 받아집니다.</span>
    </div>
    <h1 class="pc-title">영어 수업 자료 · ${md(day)} (${weekday(day)})</h1>
    <p class="pg">단어 ${words.length}개${reviews.length ? ` · 복습 단어 ${reviews.length}개` : ""} · 독해 ${items.length}문제</p>

    <h2 class="pc-h">1. 이날 외운 단어</h2>
    ${words.length ? wordList(words) : `<p class="pg">이날은 새 단어가 없었습니다.</p>`}
    ${reviews.length ? `<h3 class="pc-h3">복습한 단어</h3>${wordList(reviews)}` : ""}

    <h2 class="pc-h">2. 독해 문제</h2>
    ${items.map(({ p, q }, i) => `
      <section class="pc-q">
        <div class="pc-qhead"><b>${i + 1}.</b> ${esc(p.instruction)} <span class="pg">(${esc(p.source)} · ${esc(p.qtype)})</span></div>
        ${p.box ? `<div class="given">${esc(p.box).replace(/\n/g, "<br>")}</div>` : ""}
        <div class="pbody">${printBody(p.body)}</div>
        ${p.glossary?.length ? `<div class="pg">${p.glossary.map((g) => "* " + esc(g)).join("&nbsp;&nbsp;")}</div>` : ""}
        ${choicesHtml(q)}
      </section>`).join("")}

    <div class="pc-key">
      <h1 class="pc-title">답지 · ${md(day)}</h1>
      <table class="pc-sum"><tr><th>번호</th><th>유형</th><th>정답</th><th>학생 답</th></tr>
        ${items.map(({ p, q, r }, i) => `<tr><td>${i + 1}</td><td>${esc(p.qtype)}</td><td><b>${CIRCLED[q.answer - 1]}</b></td>
          <td>${r ? `${CIRCLED[r.pick - 1]} ${r.correct ? "○" : "✕"}` : "안 풂"}</td></tr>`).join("")}
      </table>
      ${items.map(({ p, q, r }, i) => `
        <section class="pc-a">
          <div class="pc-qhead"><b>${i + 1}. 정답 ${CIRCLED[q.answer - 1]}</b> <span class="pg">${esc(p.source)} · ${esc(p.qtype)}${r ? ` · 학생 ${CIRCLED[r.pick - 1]} ${r.correct ? "(맞음)" : "(틀림)"}` : " · 학생 안 풂"}</span></div>
          ${q.choices.some((c, j) => c.trim() !== CIRCLED[j]) ? `<div class="pg">정답 선택지: ${esc(q.choices[q.answer - 1])}</div>` : ""}
          ${q.point ? `<div><b>어법 포인트</b> ${esc(q.point)}</div>` : ""}
          <div class="pc-expl"><b>해설</b> ${esc(q.explanation)}</div>
          ${p.answer_verified ? "" : `<div class="pg">※ 정답·해설은 Claude가 직접 풀어 만든 것으로, 아직 선생님 검증 전입니다.</div>`}
        </section>`).join("")}
    </div>`;
  document.body.appendChild(sheet);
  document.body.classList.add("printing");
  const title = document.title;
  document.title = `영어수업자료_${day}`; // default PDF file name
  const close = () => { sheet.remove(); document.body.classList.remove("printing"); document.title = title; };
  sheet.querySelector("#pc-print").addEventListener("click", () => window.print());
  sheet.querySelector("#pc-close").addEventListener("click", close);
  window.scrollTo(0, 0);
}

function passageView(p, q) {
  return `${p.box ? `<div class="pbody given">${esc(p.box)}</div>` : ""}
    <div class="pbody">${esc(p.body.replace(/\{\/?u\}/g, ""))}</div>
    <ol class="small">${q.choices.map((c, i) => `<li ${i + 1 === q.answer ? 'class="o"' : ""}>${esc(c)}</li>`).join("")}</ol>
    ${q.point ? `<p class="small"><b>어법 포인트</b> ${esc(q.point)}</p>` : ""}
    <p class="small"><b>풀이</b> ${esc(q.explanation)}</p>`;
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
