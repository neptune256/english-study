// 첫 화면: 영어 / 수학 고르기. 오늘 상태를 한 줄씩 보여 줍니다 (불러오기 실패해도 버튼은 그대로 동작).
import { db, today, REMOTE } from "./db.js";
import { mdb } from "./math-data.js";
import { streak } from "./math-plan.js";

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

mdb.sessions().then((sessions) => {
  const daily = sessions.find((s) => s.id === `${DAY}-daily`);
  const n = streak(sessions, DAY);
  const fire = n ? ` · 🔥 ${n}일 연속` : "";
  if (daily?.finished_at) return show("st-math", `오늘의 5문제 완료 ✓${fire}`, "done");
  const d = daily?.draft;
  const done = d ? d.ids.filter((id) => d.done?.[id]).length : 0;
  show("st-math", `오늘의 5문제 ${done}/${d ? d.ids.length : 5}${fire}`, "todo");
}).catch(() => {});
