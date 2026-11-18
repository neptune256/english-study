// Data layer: Supabase REST when configured, otherwise localStorage + local content bundle.

const cfg = window.APP_CONFIG || {};
// ?local=1 forces the local test mode even when Supabase is configured (safe testing).
export const REMOTE =
  Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) && !new URLSearchParams(location.search).has("local");

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
// Supabase returns at most 1000 rows per request: read big tables page by page.
async function restAll(path, page = 1000) {
  const out = [];
  for (let offset = 0; ; offset += page) {
    const rows = await rest("GET", `${path}&limit=${page}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < page) return out;
  }
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
    return REMOTE ? restAll("passages?select=*&order=id") : (await localBundle()).passages;
  },
  async words() {
    return REMOTE ? restAll("words?select=*&order=id") : (await localBundle()).words;
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
    return REMOTE ? restAll("word_progress?select=*&order=word_id") : lsGet("progress", []);
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
  /** All events, or only one day's when `day` is given. */
  async events(day) {
    if (REMOTE) return restAll(`events?select=*${day ? `&day=eq.${day}` : ""}&order=at,id`);
    const all = lsGet("events", []);
    return day ? all.filter((e) => e.day === day) : all;
  },

  // ───── passage analysis PDFs (Supabase Storage bucket "analysis") ─────
  /** Upload a PDF and record it. In local test mode only the record is kept. */
  async submitAnalysis({ day, passageId, file }) {
    const path = `${day}/${passageId}-${Date.now()}.pdf`;
    const row = { day, passage_id: passageId, path, file_name: file.name, size: file.size };
    if (REMOTE) {
      const res = await fetch(`${cfg.SUPABASE_URL}/storage/v1/object/analysis/${path}`, {
        method: "POST",
        headers: {
          apikey: cfg.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
          "Content-Type": "application/pdf",
        },
        body: file,
      });
      if (!res.ok) throw new Error(`업로드 실패 (${res.status}) ${await res.text()}`);
      await rest("POST", "submissions", [row], "return=minimal");
    } else {
      const all = lsGet("submissions", []);
      all.push({ id: all.length + 1, submitted_at: new Date().toISOString(), ...row });
      lsSet("submissions", all);
    }
    return row;
  },
  async submissions() {
    return REMOTE ? rest("GET", "submissions?select=*&order=submitted_at.desc") : lsGet("submissions", []).reverse();
  },
  /** The PDF as a Blob (null in local test mode). */
  async analysisFile(path) {
    if (!REMOTE) return null;
    const res = await fetch(`${cfg.SUPABASE_URL}/storage/v1/object/analysis/${path}`, {
      headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) throw new Error(`파일을 열 수 없어요 (${res.status})`);
    return res.blob();
  },
};
