// 첫 화면: 영어 / 수학 고르기. 오늘 상태를 한 줄씩 보여 줍니다 (불러오기 실패해도 버튼은 그대로 동작).
import { db, today, REMOTE } from "./db.js";
import { mdb, isDue } from "./math-data.js";

const DAY = new URLSearchParams(location.search).get("day") || today(); // ?day= for testing
const $ = (id) => document.getElementById(id);

// keep ?local=1 / ?day= when moving on
for (const id of ["go-english", "go-math"]) $(id).href += location.search;
$("day").textContent = DAY;
if (!REMOTE) $("local").classList.remove("hidden");

const show = (id, text, cls) => {
  $(id).textContent = text;
  if (cls) $(id).classList.add(cls);
};

db.daily(DAY).then((set) => {
  if (!set) return show("st-english", "오늘 아직 시작 안 했어요", "todo");
  if (set.reading_done_at && set.summary?.analysis) return show("st-english", "오늘 학습 완료 ✓", "done");
  if (set.reading_done_at) return show("st-english", "지문 분석만 남았어요", "todo");
  show("st-english", "진행 중 · 이어서 하기", "todo");
}).catch(() => {});

Promise.all([mdb.review(), mdb.sessions()]).then(([review, sessions]) => {
  const due = review.filter((r) => isDue(r, DAY)).length;
  const draft = sessions.find((s) => s.mode === "exam" && !s.finished_at);
  const solvedToday = sessions.some((s) => s.day === DAY && s.finished_at);
  const parts = [];
  if (draft) parts.push("푸는 중인 모의고사 있음");
  if (due) parts.push(`다시 풀 오답 ${due}개`);
  if (parts.length) show("st-math", parts.join(" · "), "todo");
  else if (solvedToday) show("st-math", "오늘 풀었어요 ✓", "done");
  else show("st-math", "다시 풀 오답 없음");
}).catch(() => {});
