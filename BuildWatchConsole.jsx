import { Fragment, useState, useEffect, useMemo, useRef, createContext, useContext } from "react";
import {
  MapPin, ChevronRight, Volume2, Wind, Droplets, CheckCircle2, AlertTriangle,
  X, Clock, HardHat, ShieldCheck, LogOut, ClipboardList, SlidersHorizontal, LayoutDashboard, Lock, Building2, ChevronDown, Download,
} from "lucide-react";

/* ------------------------------------------------------------------ *
 *  MOCK DATA — site names/types/coordinates taken from the original file
 * ------------------------------------------------------------------ */
const CENTER = [3.2155, 101.4945]; // map centre (approx.)
const ACTIONS = [
  "Contractor instructed to pause heavy machinery",
  "Acoustic curtain deployed",
  "Working hours adjusted",
  "Equipment relocated behind barrier",
];
// Expected noise / dust thresholds per work-intensity level (admin-editable)
const DEFAULT_CFG = {
  mistMargin: 10, // misting has no fixed duration: it stops once dust is this % below the threshold
  levels: {
    light: { noise: 65, dust: 25 },
    moderate: { noise: 75, dust: 45 },
    heavy: { noise: 85, dust: 70 },
  },
};

// Working day is 08:00 – 18:00. Times are for today.
const DAY0 = new Date(); DAY0.setHours(0, 0, 0, 0);
const at = (h, m = 0) => DAY0.getTime() + (h * 60 + m) * 60000;
const tm = (t) => { const [h, m] = t.split(":").map(Number); return at(h, m); };
// DEMO ONLY: outside 08:00–18:00 the demo clock starts at 10:30 so works are visibly ongoing.
// For production use `const clock = () => Date.now();`
const CLOCK_OFFSET = (() => { const h = new Date().getHours(); return h >= 8 && h < 18 ? 0 : at(10, 30) - Date.now(); })();
const clock = () => Date.now() + CLOCK_OFFSET;

// work(id, "HH:MM", "HH:MM", type, area, expectedNoise, expectedDust)
const work = (id, from, to, type, areaNo, noise, dust) => ({ id, start: tm(from), end: tm(to), type, area: areaNo, noise, dust });
// area(id, pm25, pm10, pre-misting pm25, dB)
const area = (id, pm25, pm10, pre, db) => ({ id, pm25, pm10, pre, db });

const INITIAL_SITES = [
  {
    id: "site-a", name: "Site A, landed phase 2", type: "Landed construction", address: "Landed Phase 2", pos: [3.221, 101.49],
    areas: [area(1, 58, 90, 100, 80), area(2, 52, 80, 90, 79), area(3, 12, 22, 20, 61)],
    schedule: [
      work("a1", "08:00", "09:00", "Site Briefing & Safety Check", 1, "light", "light"),
      work("a2", "09:00", "12:00", "Core Drilling & Wall Hacking", 1, "heavy", "heavy"),
      work("a3", "10:00", "11:30", "Debris Removal", 1, "light", "moderate"),
      work("a4", "09:30", "12:30", "Drainage Trenching", 2, "moderate", "moderate"),
      work("a5", "13:30", "15:30", "Slope Turfing", 3, "light", "light"),
      work("a6", "16:00", "18:00", "Site Cleanup & Inspection", 1, "light", "light"),
    ],
  },
  {
    id: "site-b", name: "Site B, terrace renovation", type: "Renovation", address: "Terrace Row", pos: [3.2105, 101.504],
    areas: [area(1, 41, 63, 74, 71), area(2, 14, 25, 22, 58)],
    schedule: [
      work("b1", "08:30", "12:00", "Conduit Installation", 1, "moderate", "light"),
      work("b2", "09:00", "11:30", "DB Board Delivery", 2, "light", "light"),
      work("b3", "13:00", "16:00", "Wall Chasing", 1, "heavy", "heavy"),
      work("b4", "16:00", "18:00", "Cable Pulling", 2, "light", "light"),
    ],
  },
  {
    id: "site-c", name: "Site C, commercial block", type: "Commercial", address: "Commercial Block", pos: [3.198, 101.485],
    areas: [area(1, 19, 31, 28, 77), area(2, 22, 37, 33, 66), area(3, 11, 18, 17, 60)],
    schedule: [
      work("c1", "08:00", "11:00", "HVAC Test Run", 1, "moderate", "light"),
      work("c2", "10:00", "13:00", "Fire Alarm Test", 2, "moderate", "light"),
      work("c3", "13:30", "16:00", "MSB Energising", 3, "light", "light"),
      work("c4", "16:00", "18:00", "Test Reporting & Handover Check", 2, "light", "light"),
    ],
  },
];

// Incident = one continuous breach of one kind (noise | dust) in one area.
// New incidents are opened automatically when a reading crosses its threshold and closed when it recovers.
const T0 = clock();
const INITIAL_EVENTS = [
  { id: "EV-801", siteId: "site-c", area: 2, kind: "dust", start: T0 - 3600000, end: T0 - 3000000, level: "moderate", limit: 45, peak: 112, action: "", actionAt: null },
  { id: "EV-800", siteId: "site-b", area: 1, kind: "noise", start: T0 - 7200000, end: T0 - 6300000, level: "moderate", limit: 75, peak: 78, action: "Equipment relocated behind barrier", actionAt: T0 - 6900000 },
];

/* ------------------------------------------------------------------ *
 *  STATUS LOGIC (driven by admin-editable thresholds)
 * ------------------------------------------------------------------ */
const STATUS = {
  green: { label: "Normal", hex: "#16a34a", pill: "bg-green-100 text-green-800", Icon: CheckCircle2, icon: "text-green-600" },
  amber: { label: "Warning · Misting", hex: "#eab308", pill: "bg-yellow-100 text-yellow-800", Icon: Droplets, icon: "text-yellow-500" },
  red: { label: "Critical · Breach", hex: "#dc2626", pill: "bg-red-100 text-red-800", Icon: AlertTriangle, icon: "text-red-600" },
};
const RANK = { green: 0, amber: 1, red: 2 };
const LEVELS = ["light", "moderate", "heavy"];
const LVL = {
  light: { label: "Light", cls: "border-orange-200 bg-orange-50 text-orange-700" },
  moderate: { label: "Moderate", cls: "border-orange-300 bg-orange-200 text-orange-900" },
  heavy: { label: "Heavy", cls: "border-orange-600 bg-orange-600 text-white" },
};
const maxLvl = (arr) => arr.reduce((m, l) => (LEVELS.indexOf(l) > LEVELS.indexOf(m) ? l : m), "light");
const workState = (w, now = clock()) => (w.end <= now ? "done" : w.start <= now ? "active" : "upcoming");
const fmt = (ms) => new Date(ms).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit", hour12: true });

// An area's expected level = the heaviest of the works running in it right now.
// A reading above that level's threshold is a breach.
const check = (site, a, c, now = clock()) => {
  const works = site.schedule.filter((w) => w.area === a.id && workState(w, now) === "active");
  const noiseLvl = maxLvl(works.map((w) => w.noise));
  const dustLvl = maxLvl(works.map((w) => w.dust));
  const noiseLimit = c.levels[noiseLvl].noise, dustLimit = c.levels[dustLvl].dust;
  const noiseBreach = a.db > noiseLimit, dustBreach = a.pm25 > dustLimit;
  const dustTarget = Math.round(dustLimit * (1 - c.mistMargin / 100)); // misting keeps running until dust is at or below this
  const mist = !!a.mist;
  return { works, noiseLvl, dustLvl, noiseLimit, dustLimit, dustTarget, noiseBreach, dustBreach, mist, status: noiseBreach ? "red" : dustBreach || mist ? "amber" : "green" };
};
const siteStatus = (s, c) => s.areas.map((a) => check(s, a, c).status).reduce((w, x) => (RANK[x] > RANK[w] ? x : w), "green");
const peakOf = (s) => ({
  n: s.areas.reduce((m, a) => (a.db > m.db ? a : m)),
  d: s.areas.reduce((m, a) => (a.pm25 > m.pm25 ? a : m)),
});

const CfgCtx = createContext(DEFAULT_CFG);
const useCfg = () => useContext(CfgCtx);

/* ------------------------------------------------------------------ *
 *  SMALL UI PIECES  (orange + white theme)
 * ------------------------------------------------------------------ */
const card = "rounded-xl border border-orange-100 bg-white shadow-sm";
const btn = "rounded-lg bg-orange-500 px-4 py-2.5 font-semibold text-white hover:bg-orange-600";
const field = "w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-orange-500";

function StatusPill({ status }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.pill}`}>
      <s.Icon size={12} /> {s.label}
    </span>
  );
}

function Meter({ icon: Icon, label, value, unit, limit, sub, caption }) {
  const ratio = value / limit;
  const color = ratio >= 1 ? "bg-red-500" : ratio >= 0.8 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className={`${card} p-4 sm:p-5`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-orange-600">
        <Icon size={14} /> {label}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-4xl font-bold tabular-nums sm:text-5xl">{value}</span>
        <span className="text-slate-500">{unit}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-orange-50">
        <div className={`h-full transition-all duration-500 ${color}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-slate-500">
        <span>{sub}</span><span>Limit {limit} {unit}</span>
      </div>
      <div className="mt-3 inline-block rounded-md bg-orange-500 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
        Highest Active Floor Reading
      </div>
      <div className="mt-1 text-xs text-slate-500">{caption}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  LOGIN PAGE
 * ------------------------------------------------------------------ */
function LoginPage({ sites, onLogin }) {
  const [role, setRole] = useState("admin");
  const [siteId, setSiteId] = useState(sites[0].id);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");

  const submit = () => {
    if (!email.trim() || !pw.trim()) return setErr("Enter your email and password.");
    onLogin({ role, siteId: role === "manager" ? siteId : null, email });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-orange-50 p-5">
      <div className={`${card} w-full max-w-md p-8`}>
        <div className="flex items-center gap-2 text-2xl font-bold">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500 text-white"><ShieldCheck /></span>
          BuildWatch
        </div>
        <p className="mt-2 text-sm text-slate-500">Site Operations Console · Environmental telemetry, misting automation and compliance.</p>

        <div className="mt-6 grid grid-cols-2 gap-2">
          {[["admin", "Administrator"], ["manager", "Site Manager"]].map(([k, l]) => (
            <button key={k} onClick={() => setRole(k)}
              className={`rounded-lg border px-3 py-2.5 text-sm font-semibold ${role === k ? "border-orange-500 bg-orange-500 text-white" : "border-orange-200 bg-white text-slate-700 hover:bg-orange-50"}`}>
              {l}
            </button>
          ))}
        </div>

        <div className="mt-5 space-y-4">
          {role === "manager" && (
            <label className="block text-xs font-semibold uppercase text-slate-500">Assigned site
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={`${field} mt-1 font-normal normal-case`}>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.type})</option>)}
              </select>
            </label>
          )}
          <label className="block text-xs font-semibold uppercase text-slate-500">Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@township.com" className={`${field} mt-1 font-normal normal-case`} />
          </label>
          <label className="block text-xs font-semibold uppercase text-slate-500">Password
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="••••••••" className={`${field} mt-1 font-normal normal-case`} />
          </label>
          {err && <div className="text-sm font-medium text-red-600">{err}</div>}
          <button onClick={submit} className={`${btn} flex w-full items-center justify-center gap-2`}><Lock size={16} /> Sign in to Console</button>
        </div>
        <p className="mt-4 text-center text-xs text-slate-400">Demo only – any non-empty credentials work.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  LEAFLET MAP (cdnjs; with a bundler use react-leaflet)
 * ------------------------------------------------------------------ */
function useLeaflet() {
  const [L, setL] = useState(window.L || null);
  useEffect(() => {
    if (window.L) return setL(window.L);
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    js.onload = () => setL(window.L);
    document.head.appendChild(js);
  }, []);
  return L;
}

const pin = (L, hex) =>
  L.divIcon({
    className: "", iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<div style="width:26px;height:26px;border-radius:50%;background:${hex};border:3px solid #fff;box-shadow:0 0 0 3px ${hex}55,0 2px 6px rgba(0,0,0,.4)"></div>`,
  });

function SiteMap({ sites, onOpen }) {
  const c = useCfg();
  const L = useLeaflet();
  const el = useRef(null), map = useRef(null), markers = useRef({}), openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    if (!L || map.current) return;
    map.current = L.map(el.current).setView(CENTER, 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map.current);
    return () => { map.current?.remove(); map.current = null; markers.current = {}; };
  }, [L]);

  useEffect(() => {
    if (!L || !map.current) return;
    sites.forEach((s) => {
      const st = siteStatus(s, c);
      const icon = pin(L, STATUS[st].hex);
      const tip = `<b>${s.name}</b><br/>${STATUS[st].label}`;
      if (markers.current[s.id]) markers.current[s.id].setIcon(icon).setTooltipContent(tip);
      else markers.current[s.id] = L.marker(s.pos, { icon }).addTo(map.current)
        .bindTooltip(tip, { direction: "top", offset: [0, -12] }).on("click", () => openRef.current(s.id));
    });
  }, [L, sites, c]);

  return (
    <div className={`relative overflow-hidden ${card}`}>
      <div ref={el} style={{ height: 380, zIndex: 0 }} />
      <div className="absolute bottom-3 left-3 flex gap-3 rounded-lg bg-white/95 px-3 py-2 text-xs font-medium text-slate-700 shadow" style={{ zIndex: 500 }}>
        {Object.values(STATUS).map((s) => (
          <span key={s.label} className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.hex }} /> {s.label}</span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  OVERVIEW (HOME) PAGE
 * ------------------------------------------------------------------ */
function OverviewPage({ sites, onOpen }) {
  const c = useCfg();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Map Overview</h1>
        <p className="text-sm text-slate-500">{sites.length} active site{sites.length > 1 ? "s" : ""}</p>
      </div>
      <SiteMap sites={sites} onOpen={onOpen} />
      <div className="grid gap-3 md:grid-cols-2">
        {sites.map((s) => {
          const st = siteStatus(s, c);
          return (
            <button key={s.id} onClick={() => onOpen(s.id)} className={`${card} flex items-center gap-4 p-4 text-left transition hover:bg-orange-50`}>
              <span className="h-14 w-1.5 rounded-full" style={{ background: STATUS[st].hex }} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{s.name}</div>
                <div className="mt-0.5 flex items-center gap-1 text-sm text-slate-500"><MapPin size={13} /> {s.address} · {s.type}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2"><StatusPill status={st} /><span className="text-xs font-medium text-slate-500">{s.schedule.filter((w) => workState(w) === "active").length} works ongoing</span></div>
              </div>
              <ChevronRight className="text-orange-500" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  AREA DEEP-DIVE MODAL
 * ------------------------------------------------------------------ */
function LevelChip({ kind, level, limit }) {
  const Icon = kind === "noise" ? Volume2 : Wind;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold ${LVL[level].cls}`}>
      <Icon size={12} /> {LVL[level].label} · ≤{limit} {kind === "noise" ? "dB" : "µg/m³"}
    </span>
  );
}

function AreaPanel({ site, area: a, ev, onClose, onAction }) {
  const c = useCfg();
  const ck = check(site, a, c);
  const mist = ck.mist;
  const cut = mist ? Math.max(0, Math.round((1 - a.pm25 / a.pre) * 100)) : 0;
  const verdict = (bad) => (
    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${bad ? "bg-red-100 text-red-800" : "bg-green-100 text-green-800"}`}>{bad ? "Breached" : "Within limit"}</span>
  );

  return (
    <div className={`${card} p-5`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-orange-500 text-lg font-bold text-white">{a.id}</span>
          <div>
            <h2 className="text-xl font-bold">Area {a.id}</h2>
            <div className="mt-1"><StatusPill status={ck.status} /></div>
          </div>
        </div>
        <button onClick={onClose} className="rounded-full p-2 hover:bg-orange-50" aria-label="Close"><X size={20} /></button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <section className="rounded-xl bg-orange-50 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-500"><HardHat size={16} className="text-orange-500" /> Work Done / Current Activity</div>
          {ck.works.length ? ck.works.map((w) => (
            <div key={w.id} className="mt-3">
              <div className="font-semibold">Active Work: {w.type}</div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <LevelChip kind="noise" level={w.noise} limit={c.levels[w.noise].noise} />
                <LevelChip kind="dust" level={w.dust} limit={c.levels[w.dust].dust} />
              </div>
            </div>
          )) : <div className="mt-3 font-semibold">No active work – baseline (Light) limits apply</div>}
          <div className="mt-4 text-xs text-slate-500">
            Expected for this area (heaviest concurrent work): Noise {LVL[ck.noiseLvl].label} ≤{ck.noiseLimit} dB · Dust {LVL[ck.dustLvl].label} ≤{ck.dustLimit} µg/m³
          </div>
        </section>

        <section className="rounded-xl border border-orange-100 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-semibold"><Wind size={16} className="text-orange-500" /> Dust Breach</h3>{verdict(ck.dustBreach)}
          </div>
          <div className="text-4xl font-bold tabular-nums">{a.pm25}<span className="ml-1 text-sm font-normal text-slate-500">µg/m³ PM2.5</span></div>
          <div className="text-sm text-slate-500">PM10: {a.pm10} µg/m³ · Limit {ck.dustLimit}</div>
          <div className="mt-4 rounded-lg bg-orange-50 p-3">
            <div className="text-xs font-semibold uppercase text-slate-500">Automated Mitigation</div>
            <div className="mt-1 flex items-center gap-2 font-medium">
              <span className={`h-2.5 w-2.5 rounded-full ${mist ? "animate-pulse bg-sky-500" : "bg-slate-400"}`} />
              Automatic Water Misting: {mist ? `Active – runs until PM2.5 ≤ ${ck.dustTarget} µg/m³` : "Standby"}
            </div>
          </div>
          <div className="mt-4">
            <div className="text-xs font-semibold uppercase text-slate-500">Post-Mitigation Impact</div>
            {mist ? (
              <>
                {[["Before misting", a.pre, "bg-red-500"], ["After misting", a.pm25, "bg-green-500"]].map(([l, v, col]) => (
                  <div key={l} className="mt-2">
                    <div className="flex justify-between text-xs"><span>{l}</span><span className="tabular-nums">{v} µg/m³</span></div>
                    <div className="mt-1 h-2.5 rounded-full bg-orange-50"><div className={`h-full rounded-full ${col}`} style={{ width: `${Math.min(100, (v / a.pre) * 100)}%` }} /></div>
                  </div>
                ))}
                <div className="mt-2 text-sm font-semibold text-green-700">Dust suppressed by {cut}% after misting</div>
                <div className="text-xs text-slate-500">Misting stops at ≤ {ck.dustTarget} µg/m³ (threshold {ck.dustLimit}, minus {c.mistMargin}%)</div>
              </>
            ) : <div className="mt-1 text-sm text-slate-500">No misting needed – within the expected dust limit.</div>}
          </div>
        </section>

        <section className="rounded-xl border border-orange-100 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-semibold"><Volume2 size={16} className="text-orange-500" /> Noise Breach</h3>{verdict(ck.noiseBreach)}
          </div>
          <div className={`text-4xl font-bold tabular-nums ${ck.noiseBreach ? "text-red-600" : ""}`}>{a.db}<span className="ml-1 text-sm font-normal text-slate-500">dB(A)</span></div>
          <div className="text-sm text-slate-500">Limit for {LVL[ck.noiseLvl].label} work: {ck.noiseLimit} dB(A)</div>
          <label className="mt-4 flex items-center gap-2 rounded-lg bg-orange-50 p-3 text-sm font-medium">
            <input type="checkbox" checked={ck.noiseBreach} readOnly className="h-4 w-4 accent-orange-500" />
            {ck.noiseBreach ? "Alert automatically dispatched to Site Manager" : "No alert required"}
          </label>
          <div className="mt-4">
            <div className="text-xs font-semibold uppercase text-slate-500">Actions Taken</div>
            <select value={ev?.action ?? ""} disabled={!ev} onChange={(e) => onAction(ev.id, e.target.value)} className={`${field} mt-1 disabled:opacity-50`}>
              <option value="">{ev ? "— No action recorded —" : "— No active noise breach —"}</option>
              {ACTIONS.map((x) => <option key={x}>{x}</option>)}
            </select>
            {ev && !ev.action && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1 text-xs font-bold uppercase text-white">
                <AlertTriangle size={12} /> Action Taken: No · Pending Response
              </div>
            )}
            {ev?.action && <div className="mt-2 text-sm font-medium text-green-700">✓ {ev.action}</div>}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  SITE DETAILS PAGE
 * ------------------------------------------------------------------ */
const len = (w) => { const m = Math.round((w.end - w.start) / 60000); return m >= 60 ? `${(m / 60).toFixed(1).replace(".0", "")} h` : `${m} min`; };
const BAR = { light: "bg-orange-200 text-orange-900", moderate: "bg-orange-400 text-white", heavy: "bg-orange-600 text-white" };

function LvlTag({ level, limit, unit }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold ${LVL[level].cls}`}>
      {LVL[level].label} <span className="font-normal opacity-80">≤{limit} {unit}</span>
    </span>
  );
}

// Swim-lane overview: one lane per area, bars are works, overlapping works stack
function Gantt({ site, now, onOpen }) {
  const H = 3600000, ws = site.schedule;
  const t0 = at(8), t1 = at(18); // fixed working day
  const span = t1 - t0, pos = (t) => ((t - t0) / span) * 100;
  const hr = (t) => { const h = new Date(t).getHours(); return `${h % 12 || 12}${h < 12 ? "am" : "pm"}`; };
  const ticks = []; for (let t = t0; t <= t1; t += H) ticks.push(t);
  const nowRatio = now >= t0 && now <= t1 ? (now - t0) / span : null;

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ minWidth: 560 }}>
        <div className="flex">
          <div className="w-16 shrink-0" />
          <div className="relative h-6 flex-1">
            {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2 text-[11px] font-medium text-slate-400" style={{ left: `${pos(t)}%` }}>{hr(t)}</span>)}
          </div>
        </div>
        {site.areas.map((a) => {
          const ends = [];
          const placed = ws.filter((w) => w.area === a.id).sort((x, y) => x.start - y.start).map((w) => {
            let i = ends.findIndex((e) => e <= w.start); if (i < 0) i = ends.length; ends[i] = w.end; return [w, i];
          });
          return (
            <div key={a.id} className="flex border-t border-orange-100">
              <div className="w-16 shrink-0 py-2.5 text-xs font-bold uppercase text-slate-500">Area {a.id}</div>
              <div className="relative flex-1" style={{ height: Math.max(1, ends.length) * 30 + 8 }}>
                {ticks.map((t) => <i key={t} className="absolute bottom-0 top-0 w-px bg-orange-50" style={{ left: `${pos(t)}%` }} />)}
                {placed.map(([w, i]) => (
                  <button key={w.id} onClick={() => onOpen(a.id)} title={`${w.type} · ${fmt(w.start)} – ${fmt(w.end)}`}
                    className={`absolute truncate rounded-md px-2 text-left text-xs font-semibold ${BAR[maxLvl([w.noise, w.dust])]} ${workState(w, now) === "done" ? "opacity-50" : ""}`}
                    style={{ left: `${pos(w.start)}%`, width: `${((w.end - w.start) / span) * 100}%`, top: 4 + i * 30, height: 26, lineHeight: "26px" }}>
                    {w.type}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {nowRatio !== null && (
          <div className="pointer-events-none absolute bottom-0 top-6" style={{ left: `calc(4rem + (100% - 4rem) * ${nowRatio})`, width: 2, background: "#dc2626" }}>
            <span className="absolute -top-5 -translate-x-1/2 rounded bg-red-600 px-1.5 text-[10px] font-bold uppercase text-white" style={{ left: 1 }}>Now</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Schedule({ site, onOpen }) {
  const c = useCfg();
  const now = clock();
  const sorted = [...site.schedule].sort((a, b) => a.start - b.start || a.area - b.area);
  const live = sorted.filter((w) => workState(w, now) === "active").length;
  const done = sorted.filter((w) => workState(w, now) === "done").length;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Clock size={18} className="text-orange-500" /> Full Daily Work Schedule <span className="text-sm font-normal text-slate-500">8:00 AM – 6:00 PM</span></h2>
        <div className="flex gap-2 text-xs font-semibold">
          <span className="rounded-full bg-orange-500 px-2.5 py-1 text-white">{live} ongoing</span>
          <span className="rounded-full bg-orange-100 px-2.5 py-1 text-orange-800">{sorted.length - live - done} upcoming</span>
          <span className="rounded-full bg-stone-200 px-2.5 py-1 text-slate-600">{done} completed</span>
        </div>
      </div>

      <div className={`${card} overflow-hidden`}>
        <div className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span className="font-semibold uppercase">Timeline by area</span>
            {LEVELS.map((l) => <span key={l} className="flex items-center gap-1.5"><i className={`inline-block h-2.5 w-4 rounded-sm ${BAR[l].split(" ")[0]}`} /> {LVL[l].label}</span>)}
            <span className="text-slate-400">· bar colour = heaviest expected level</span>
          </div>
          <Gantt site={site} now={now} onOpen={onOpen} />
        </div>

        {live > 1 && (
          <div className="border-t border-orange-100 bg-orange-100 px-4 py-2 text-sm font-medium text-orange-900">
            {live} works are running at the same time. Each area is judged against its heaviest concurrent work.
          </div>
        )}

        <div className="overflow-x-auto border-t border-orange-100">
          <table className="w-full text-left text-sm">
            <thead className="bg-orange-50 text-xs uppercase text-orange-700">
              <tr>
                <th className="py-2.5 pl-4 pr-3">Time</th><th className="px-3">Work</th><th className="px-3">Area</th>
                <th className="px-3">Expected noise</th><th className="px-3">Expected dust</th><th className="px-3 pr-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-orange-100">
              {sorted.map((w) => {
                const st = workState(w, now), a = site.areas.find((x) => x.id === w.area), ck = check(site, a, c, now);
                const chips = [];
                if (ck.noiseBreach) chips.push(["red", `Noise breach · ${a.db} dB`]);
                if (ck.dustBreach) chips.push(["amber", `Dust breach · ${a.pm25}`]);
                if (st === "active" && !chips.length) chips.push(["green", "Within limits"]);
                return (
                  <tr key={w.id} onClick={() => onOpen(w.area)}
                    className={`cursor-pointer hover:bg-orange-50 ${st === "active" ? "bg-orange-50" : ""} ${st === "done" ? "opacity-60" : ""}`}>
                    <td className="whitespace-nowrap py-3 pl-4 pr-3 font-mono font-semibold tabular-nums" style={st === "active" ? { boxShadow: "inset 4px 0 0 #f97316" } : undefined}>
                      {fmt(w.start)} – {fmt(w.end)}
                      <div className="font-sans text-xs font-normal text-slate-400">{len(w)}</div>
                    </td>
                    <td className="px-3 py-3 font-semibold">{w.type}</td>
                    <td className="px-3 py-3"><span className="rounded-md bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-700">Area {w.area}</span></td>
                    <td className="px-3 py-3"><LvlTag level={w.noise} limit={c.levels[w.noise].noise} unit="dB" /></td>
                    <td className="px-3 py-3"><LvlTag level={w.dust} limit={c.levels[w.dust].dust} unit="µg/m³" /></td>
                    <td className="px-3 py-3 pr-4">
                      {st === "active" ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="flex items-center gap-1 rounded-full bg-orange-500 px-2 py-0.5 text-[11px] font-bold uppercase text-white"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> Live</span>
                          {chips.map(([k, t]) => <span key={t} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[k].pill}`}>{t}</span>)}
                        </div>
                      ) : st === "done"
                        ? <span className="flex items-center gap-1 text-xs font-semibold text-slate-500"><CheckCircle2 size={14} /> Completed</span>
                        : <span className="text-xs font-semibold uppercase text-orange-600">Upcoming</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function SiteDetail({ site, sites, onSelect, events, onAction }) {
  const c = useCfg();
  const [openId, setOpenId] = useState(null);
  const panel = useRef(null);
  useEffect(() => { if (openId) panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [openId]);
  const { n, d } = peakOf(site);
  const cn = check(site, n, c), cd = check(site, d, c);
  const selected = site.areas.find((a) => a.id === openId);
  const ev = selected && events.find((e) => e.siteId === site.id && e.area === selected.id && e.kind === "noise" && !e.end);

  return (
    <div className="space-y-6">
      {sites.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase text-slate-500">Select site</span>
          {sites.map((x) => (
            <button key={x.id} onClick={() => onSelect(x.id)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold ${x.id === site.id ? "border-orange-500 bg-orange-500 text-white" : "border-orange-200 bg-white text-slate-700 hover:bg-orange-50"}`}>
              <i className="h-2.5 w-2.5 rounded-full border border-white" style={{ background: STATUS[siteStatus(x, c)].hex }} /> {x.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{site.name}</h1>
          <div className="flex items-center gap-1 text-sm text-slate-500"><MapPin size={13} /> {site.address} · {site.type}</div>
        </div>
        <StatusPill status={siteStatus(site, c)} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Meter icon={Volume2} label="Noise" value={n.db} unit="dB(A)" limit={cn.noiseLimit} sub="Peak across all floors" caption={`Source: Area ${n.id} · expected ${LVL[cn.noiseLvl].label}`} />
        <Meter icon={Wind} label="Dust PM2.5 / PM10" value={d.pm25} unit="µg/m³" limit={cd.dustLimit} sub={`PM10: ${d.pm10} µg/m³`} caption={`Source: Area ${d.id} · expected ${LVL[cd.dustLvl].label}`} />
      </div>

      <section>
        <h2 className="mb-2 text-lg font-bold">Areas &amp; Zone Status</h2>
        <div className={`${card} divide-y divide-orange-100 overflow-hidden`}>
          {site.areas.map((a) => {
            const ck = check(site, a, c), S = STATUS[ck.status], on = openId === a.id;
            const sub = ck.noiseBreach ? `Noise breach · ${a.db} dB (limit ${ck.noiseLimit})` : ck.dustBreach ? `Dust breach · misting active (limit ${ck.dustLimit})` : ck.mist ? `Misting until PM2.5 ≤ ${ck.dustTarget} µg/m³` : "Within limits";
            return (
              <Fragment key={a.id}>
                <button onClick={() => setOpenId(on ? null : a.id)} className={`flex w-full items-center gap-4 px-4 py-3.5 text-left hover:bg-orange-50 ${on ? "bg-orange-50" : ""}`}>
                  <span className={`flex h-10 w-10 items-center justify-center rounded-full font-bold ${on ? "bg-orange-500 text-white" : "bg-orange-100 text-orange-700"}`}>{a.id}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">Area {a.id}</span>
                    <span className="block truncate text-sm text-slate-500">{sub} · {ck.works.length} ongoing</span>
                  </span>
                  <S.Icon size={20} className={S.icon} />
                  <span className="hidden sm:block"><StatusPill status={ck.status} /></span>
                  <ChevronRight size={18} className={`text-orange-500 transition ${on ? "rotate-90" : ""}`} />
                </button>
                {on && (
                  <div ref={panel} className="bg-orange-50 p-4">
                    <AreaPanel site={site} area={a} ev={ev} onClose={() => setOpenId(null)} onAction={onAction} />
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </section>

      <Schedule site={site} onOpen={setOpenId} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  INCIDENT AUDIT LOG
 * ------------------------------------------------------------------ */
const KIND = { noise: { label: "Noise breach", Icon: Volume2, unit: "dB" }, dust: { label: "Dust breach", Icon: Wind, unit: "µg/m³" } };
const dur = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const outcomeOf = (e) => (!e.end ? "In progress" : e.kind === "dust" ? "Controlled by misting" : e.action ? "Compliance restored" : "Cleared – no action logged");

function Timeline({ e, c }) {
  const steps = [
    [e.start, "Breach detected", `${e.peak} ${KIND[e.kind].unit} vs limit ${e.limit}`, "done"],
    e.kind === "noise"
      ? [e.start, "Alert dispatched", "Sent automatically to Site Manager", "done"]
      : [e.start, "Auto misting started", `Runs until PM2.5 ≤ ${Math.round(e.limit * (1 - c.mistMargin / 100))} µg/m³`, "done"],
    ...(e.kind === "noise" ? [e.actionAt
      ? [e.actionAt, "Action taken", e.action, "done"]
      : [null, e.end ? "No action recorded" : "Awaiting manager action", "Pending response", e.end ? "skip" : "wait"]] : []),
    e.end ? [e.end, "Resolved", outcomeOf(e), "done"] : [null, "Ongoing", `Ongoing for ${dur(clock() - e.start)}`, "wait"],
  ];
  return (
    <div className="flex flex-wrap gap-3">
      {steps.map(([t, title, sub, st], i) => (
        <div key={i} className={`min-w-[170px] flex-1 rounded-lg border bg-white p-3 ${st === "wait" ? "border-red-200" : "border-orange-100"}`}>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-500">
            <span className={`h-2 w-2 rounded-full ${st === "done" ? "bg-green-500" : st === "wait" ? "animate-pulse bg-red-500" : "bg-slate-300"}`} />
            {t ? fmt(t) : "—"}
          </div>
          <div className="mt-1 text-sm font-semibold">{title}</div>
          <div className="text-xs text-slate-500">{sub}</div>
        </div>
      ))}
    </div>
  );
}

function IncidentLog({ events, sites }) {
  const c = useCfg();
  const [f, setF] = useState({ site: "all", kind: "all", status: "all" });
  const [openId, setOpenId] = useState(null);
  const nameOf = (id) => sites.find((s) => s.id === id)?.name ?? id;
  const rows = events
    .filter((e) => (f.site === "all" || e.siteId === f.site) && (f.kind === "all" || e.kind === f.kind)
      && (f.status === "all" || (f.status === "open" ? !e.end : !!e.end)))
    .sort((a, b) => b.start - a.start);
  const response = (e) => (e.kind === "dust" ? `Auto misting · until PM2.5 ≤ ${Math.round(e.limit * (1 - c.mistMargin / 100))}` : `Alert sent to Site Manager · ${e.action || "no action yet"}`);

  const stats = [
    ["Ongoing", events.filter((e) => !e.end).length, "text-orange-600", "Breaches still happening"],
    ["Awaiting action", events.filter((e) => !e.end && e.kind === "noise" && !e.action).length, "text-red-600", "Open noise, no action logged"],
    ["Noise breaches", events.filter((e) => e.kind === "noise").length, "text-slate-900", "All time"],
    ["Dust breaches", events.filter((e) => e.kind === "dust").length, "text-slate-900", "All time"],
  ];

  const exportCsv = () => {
    const head = ["ID", "Start", "End", "Site", "Area", "Type", "Peak", "Limit", "Expected level", "Response", "Outcome"];
    const body = rows.map((e) => [e.id, new Date(e.start).toISOString(), e.end ? new Date(e.end).toISOString() : "", nameOf(e.siteId), e.area, KIND[e.kind].label, e.peak, e.limit, e.level, response(e), outcomeOf(e)]);
    const csv = [head, ...body].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url; link.download = "buildwatch-incidents.csv"; link.click();
    URL.revokeObjectURL(url);
  };

  const sel = (k, opts) => (
    <select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className={`${field} w-auto`}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Incident Audit Log</h1>
          <p className="text-sm text-slate-500">Every threshold breach, the automated response and the action taken – opened and closed automatically.</p>
        </div>
        <button onClick={exportCsv} className={`${btn} flex items-center gap-2 py-2 text-sm`}><Download size={15} /> Export CSV</button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(([l, v, col, hint]) => (
          <div key={l} className={`${card} p-4`}>
            <div className="text-xs font-semibold uppercase text-slate-500">{l}</div>
            <div className={`mt-1 text-3xl font-bold tabular-nums ${v && col !== "text-slate-900" ? col : ""}`}>{v}</div>
            <div className="text-xs text-slate-500">{hint}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {sites.length > 1 && sel("site", [["all", "All sites"], ...sites.map((s) => [s.id, s.name])])}
        {sel("kind", [["all", "All types"], ["noise", "Noise"], ["dust", "Dust"]])}
        {sel("status", [["all", "All statuses"], ["open", "Ongoing"], ["resolved", "Resolved"]])}
        <span className="self-center text-sm text-slate-500">{rows.length} incident{rows.length === 1 ? "" : "s"}</span>
      </div>

      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-left text-sm">
          <thead className="bg-orange-50 text-xs uppercase text-orange-700">
            <tr>{["Incident", "Site · Area", "Type", "Reading vs limit", "Response", "Duration", "Status", ""].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-orange-100">
            {rows.map((e) => {
              const K = KIND[e.kind], open = openId === e.id;
              return (
                <Fragment key={e.id}>
                  <tr onClick={() => setOpenId(open ? null : e.id)} className="cursor-pointer align-top hover:bg-orange-50">
                    <td className="px-4 py-3"><div className="font-mono font-semibold">{e.id}</div><div className="whitespace-nowrap text-xs text-slate-500">{new Date(e.start).toLocaleDateString("en-MY")} · {fmt(e.start)}</div></td>
                    <td className="px-4 py-3"><div className="font-medium">{nameOf(e.siteId)}</div><div className="text-xs text-slate-500">Area {e.area}</div></td>
                    <td className="px-4 py-3"><span className="inline-flex items-center gap-1 whitespace-nowrap font-medium"><K.Icon size={14} className="text-orange-500" /> {K.label}</span></td>
                    <td className="px-4 py-3"><div className="font-semibold tabular-nums">{e.peak} {K.unit}</div><div className="text-xs text-slate-500">limit {e.limit} · {LVL[e.level].label}</div></td>
                    <td className="max-w-[220px] px-4 py-3">
                      {response(e)}
                      {e.kind === "noise" && !e.action && !e.end && <div className="mt-1 text-xs font-bold uppercase text-red-600">Pending response</div>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">{dur((e.end ?? clock()) - e.start)}</td>
                    <td className="px-4 py-3">
                      {e.end
                        ? <div><span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-800">Resolved</span><div className="mt-1 text-xs text-slate-500">{outcomeOf(e)}</div></div>
                        : <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-600" /> Ongoing</span>}
                    </td>
                    <td className="px-4 py-3"><ChevronDown size={16} className={`text-orange-500 transition ${open ? "rotate-180" : ""}`} /></td>
                  </tr>
                  {open && <tr className="bg-orange-50"><td colSpan={8} className="px-4 py-4"><Timeline e={e} c={c} /></td></tr>}
                </Fragment>
              );
            })}
            {!rows.length && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No incidents match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  THRESHOLD CONFIG (admin only)
 * ------------------------------------------------------------------ */
function ConfigPage({ cfg, setCfg }) {
  const setLvl = (l, k, v) => setCfg({ ...cfg, levels: { ...cfg.levels, [l]: { ...cfg.levels[l], [k]: Number(v) || 0 } } });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Threshold Configuration</h1>
        <p className="text-sm text-slate-500">Administrator only. Each scheduled work is tagged Light, Moderate or Heavy; exceeding that level's threshold counts as a breach.</p>
      </div>
      <div className={`${card} space-y-5 p-5`}>
        <h3 className="font-semibold text-orange-600">Expected thresholds by work level</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr><th className="py-2 pr-4">Level</th><th className="pr-4">Max noise (dB)</th><th>Max dust PM2.5 (µg/m³)</th></tr>
            </thead>
            <tbody>
              {LEVELS.map((l) => (
                <tr key={l} className="border-t border-orange-100">
                  <td className="py-3 pr-4"><span className={`rounded-md border px-2 py-1 text-xs font-bold ${LVL[l].cls}`}>{LVL[l].label}</span></td>
                  <td className="pr-4"><input type="number" value={cfg.levels[l].noise} onChange={(e) => setLvl(l, "noise", e.target.value)} className={`${field} max-w-[140px]`} /></td>
                  <td><input type="number" value={cfg.levels[l].dust} onChange={(e) => setLvl(l, "dust", e.target.value)} className={`${field} max-w-[140px]`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="font-semibold text-orange-600">Misting</h3>
        <p className="text-sm text-slate-500">Misting has no fixed duration. It starts when dust exceeds its threshold and keeps running until PM2.5 has dropped below the threshold by this margin.</p>
        <label className="block max-w-[260px] text-xs font-semibold uppercase text-slate-500">Reduction below threshold (%)
          <input type="number" value={cfg.mistMargin} onChange={(e) => setCfg({ ...cfg, mistMargin: Number(e.target.value) || 0 })} className={`${field} mt-1 font-normal`} />
        </label>
        <button onClick={() => setCfg(DEFAULT_CFG)} className="rounded-lg border border-orange-300 px-4 py-2 text-sm font-semibold text-orange-700 hover:bg-orange-50">Reset to defaults</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  APP SHELL: session, page switching, live telemetry simulation
 * ------------------------------------------------------------------ */
export default function App() {
  const [session, setSession] = useState(null); // { role, siteId, email }
  const [view, setView] = useState({ page: "overview", siteId: null });
  const [sites, setSites] = useState(() => INITIAL_SITES.map((s) => ({ ...s, areas: s.areas.map((a) => ({ ...a, mist: check(s, a, DEFAULT_CFG).dustBreach })) })));
  const [events, setEvents] = useState(INITIAL_EVENTS);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // Simulated live telemetry – replace with your real feed
  useEffect(() => {
    const j = (v, lo, hi, s) => Math.max(lo, Math.min(hi, v + Math.round((Math.random() * 2 - 1) * s)));
    const id = setInterval(() => setSites((p) => p.map((s) => ({
      ...s, areas: s.areas.map((a) => {
        const ck = check(s, a, cfgRef.current);
        // starts when dust exceeds the limit, keeps going until it is at/below the target (no fixed timer)
        const mist = a.mist ? a.pm25 > ck.dustTarget : a.pm25 > ck.dustLimit;
        const pm25 = Math.max(5, Math.min(90, mist ? a.pm25 - 1 - Math.floor(Math.random() * 4) : a.pm25 + Math.round(Math.random() * 5 - 2)));
        return { ...a, mist, pre: mist && !a.mist ? a.pm25 : a.pre, db: j(a.db, 50, 95, 2), pm25, pm10: Math.round(pm25 * 1.6) };
      }),
    }))), 4000);
    return () => clearInterval(id);
  }, []);

  // Open an incident when a reading crosses its threshold, track the peak, close it on recovery
  const seq = useRef(802);
  useEffect(() => {
    const now = clock();
    setEvents((prev) => {
      let next = prev;
      sites.forEach((s) => s.areas.forEach((a) => {
        const ck = check(s, a, cfg, now);
        [["noise", ck.noiseBreach, a.db, ck.noiseLimit, ck.noiseLvl], ["dust", ck.dustBreach, a.pm25, ck.dustLimit, ck.dustLvl]].forEach(([kind, bad, val, limit, level]) => {
          const open = next.find((e) => e.siteId === s.id && e.area === a.id && e.kind === kind && !e.end);
          if (bad && !open) next = [{ id: `EV-${seq.current++}`, siteId: s.id, area: a.id, kind, start: now, end: null, level, limit, peak: val, action: "", actionAt: null }, ...next];
          else if (bad) next = next.map((e) => (e === open ? { ...e, peak: Math.max(e.peak, val), limit, level } : e));
          else if (open) next = next.map((e) => (e === open ? { ...e, end: now } : e));
        });
      }));
      return next;
    });
  }, [sites, cfg]);

  const isAdmin = session?.role === "admin";
  const visible = useMemo(() => (isAdmin ? sites : sites.filter((s) => s.id === session?.siteId)), [isAdmin, sites, session]);
  const visibleEvents = events.filter((e) => visible.some((s) => s.id === e.siteId));

  const setAction = (eventId, action) =>
    setEvents((p) => p.map((e) => (e.id === eventId ? { ...e, action, actionAt: action ? clock() : null } : e)));

  const go = (page, siteId = null) => setView({ page, siteId });
  const login = (s) => { setSession(s); go("overview"); };

  if (!session) return <LoginPage sites={INITIAL_SITES} onLogin={login} />;

  const current = visible.find((s) => s.id === view.siteId);
  const nav = [["overview", "Overview", LayoutDashboard], ["site", "Site Details", Building2], ["log", "Incident Audit Log", ClipboardList], ...(isAdmin ? [["config", "Threshold Config", SlidersHorizontal]] : [])];

  return (
    <CfgCtx.Provider value={cfg}>
      <div className="min-h-screen bg-orange-50 text-slate-900">
        <header className="sticky top-0 border-b border-orange-100 bg-white" style={{ zIndex: 1000 }}>
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
            <div className="flex items-center gap-2 font-bold">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500 text-white"><ShieldCheck size={18} /></span> BuildWatch
            </div>
            <nav className="flex flex-1 gap-1">
              {nav.map(([k, label, Icon]) => {
                const on = view.page === k;
                return (
                  <button key={k} onClick={() => (k === "site" ? go("site", view.siteId || visible[0]?.id) : go(k))} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold ${on ? "bg-orange-500 text-white" : "text-slate-600 hover:bg-orange-50"}`}>
                    <Icon size={15} /> <span className="hidden sm:inline">{label}</span>
                  </button>
                );
              })}
            </nav>
            <span className="rounded-md bg-orange-100 px-2 py-1 text-xs font-bold uppercase text-orange-700">{isAdmin ? "Administrator" : "Site Manager"}</span>
            <button onClick={() => setSession(null)} className="flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-orange-600"><LogOut size={16} /> Sign out</button>
          </div>
        </header>

        <main className="mx-auto max-w-6xl p-5">
          {view.page === "site" && current ? <SiteDetail key={current.id} site={current} sites={visible} onSelect={(id) => go("site", id)} events={events} onAction={setAction} />
            : view.page === "log" ? <IncidentLog events={visibleEvents} sites={sites} />
            : view.page === "config" && isAdmin ? <ConfigPage cfg={cfg} setCfg={setCfg} />
            : <OverviewPage sites={visible} onOpen={(id) => go("site", id)} />}
        </main>
      </div>
    </CfgCtx.Provider>
  );
}
