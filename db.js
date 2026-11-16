// Data layer: Supabase REST when configured, otherwise localStorage + local content bundle.

const cfg = window.APP_CONFIG || {};
export const REMOTE = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

// Today in Korea, as YYYY-MM-DD.
export function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}
export function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ───────────── Supabase REST ─────────────
async function rest(method, path, body, prefer) {
  const headers = {
    apikey: cfg.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 || method !== "GET" ? null : res.json();
}
const upsert = (table, rows) =>
  rest("POST", table, rows, "resolution=merge-duplicates,return=minimal");

// ───────────── Local fallback ─────────────
const LS = "vocabapp:";
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
let bundle = null;
async function localBundle() {
  if (!bundle) bundle = await (await fetch("../content/bundle.json", { cache: "no-store" })).json();
  return bundle;
}
function upsertLocal(key, rows, pk) {
  const all = lsGet(key, []);
  for (const r of rows) {
    const i = all.findIndex((x) => x[pk] === r[pk]);
    if (i >= 0) all[i] = { ...all[i], ...r };
    else all.push(r);
  }
  lsSet(key, all);
}

// ───────────── Public API ─────────────
export const db = {
  async passages() {
    return REMOTE ? rest("GET", "passages?select=*&order=id") : (await localBundle()).passages;
  },
  async words() {
    return REMOTE ? rest("GET", "words?select=*") : (await localBundle()).words;
  },
  async state() {
    if (REMOTE) return (await rest("GET", "student_state?id=eq.1&select=*"))[0];
    return lsGet("state", { id: 1, level: 2.5, word_level: 2.5 });
  },
  async saveState(s) {
    s = { ...s, id: 1, updated_at: new Date().toISOString() };
    return REMOTE ? upsert("student_state", [s]) : lsSet("state", s);
  },
  async daily(day) {
    if (REMOTE) return (await rest("GET", `daily_sets?day=eq.${day}&select=*`))[0] || null;
    return lsGet("daily", []).find((d) => d.day === day) || null;
  },
  async allDaily() {
    if (REMOTE) return rest("GET", "daily_sets?select=*&order=day.desc");
    return lsGet("daily", []).sort((a, b) => (a.day < b.day ? 1 : -1));
  },
  async saveDaily(set) {
    return REMOTE ? upsert("daily_sets", [set]) : upsertLocal("daily", [set], "day");
  },
  async progress() {
    return REMOTE ? rest("GET", "word_progress?select=*") : lsGet("progress", []);
  },
  async saveProgress(rows) {
    if (!rows.length) return;
    rows = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    return REMOTE ? upsert("word_progress", rows) : upsertLocal("progress", rows, "word_id");
  },
  async logEvents(rows) {
    if (!rows.length) return;
    if (REMOTE) return rest("POST", "events", rows, "return=minimal");
    const all = lsGet("events", []);
    let id = all.length ? all[all.length - 1].id + 1 : 1;
    for (const r of rows) all.push({ id: id++, at: new Date().toISOString(), ...r });
    lsSet("events", all);
  },
  async events() {
    return REMOTE ? rest("GET", "events?select=*&order=at") : lsGet("events", []);
  },
};
