"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { db } from "../../../../lib/firebase";
import { useAppUser } from "../../../../lib/useAppUser";
import { collection, query, where, getDocs } from "firebase/firestore";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell,
} from "recharts";

// ────────────────────────────────────────────────────────────────────────────
// BOARD OVERVIEW (narrative report)
//
// An executive, board-facing overview for a chosen period: a month, a quarter,
// a half-year, or the full year. It rolls up membership, attendance, finances
// and first-time guests, draws graphs, writes a plain-language narrative, and
// compares the period against the one before it (even across a year boundary).
// Owner/admin only, since it combines finance with everything else. Printable.
// ────────────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type PeriodType = "month" | "quarter" | "half" | "year";

interface MonthBucket {
  joins: number; suspensions: number; present: number; marked: number;
  income: number; expense: number; guests: number; guestsDone: number; guestsNeeding: number;
}
const emptyMonth = (): MonthBucket => ({
  joins: 0, suspensions: 0, present: 0, marked: 0, income: 0, expense: 0, guests: 0, guestsDone: 0, guestsNeeding: 0,
});

interface RawMember { created: string; suspended: string; isSuspended: boolean; }
interface RawAtt { date: string; present: boolean; }
interface RawTx { date: string; expense: boolean; amount: number; }
interface RawVis { date: string; followUp: string; }

const money = (n: number) =>
  `R ${Math.round(n).toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function tsToDate(v: unknown): string {
  const t = v as { toDate?: () => Date } | undefined;
  if (t && typeof t.toDate === "function") {
    try { return t.toDate().toISOString().slice(0, 10); } catch { return ""; }
  }
  return typeof v === "string" ? v.slice(0, 10) : "";
}

function agg(months: MonthBucket[], idxs: number[]) {
  const b = emptyMonth();
  idxs.forEach((i) => {
    const m = months[i];
    b.joins += m.joins; b.suspensions += m.suspensions;
    b.present += m.present; b.marked += m.marked;
    b.income += m.income; b.expense += m.expense;
    b.guests += m.guests; b.guestsDone += m.guestsDone; b.guestsNeeding += m.guestsNeeding;
  });
  return b;
}
const net = (b: MonthBucket) => b.joins - b.suspensions;
const attRate = (b: MonthBucket) => (b.marked > 0 ? Math.round((b.present / b.marked) * 100) : 0);
const finNet = (b: MonthBucket) => b.income - b.expense;
const followRate = (b: MonthBucket) => (b.guestsNeeding > 0 ? Math.round((b.guestsDone / b.guestsNeeding) * 100) : 0);

const QUARTER_IDX = (q: number) => [q * 3, q * 3 + 1, q * 3 + 2];
const HALF_IDX = (h: number) => (h === 0 ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11]);

function windowFor(type: PeriodType, unit: number): number[] {
  if (type === "month") return [unit];
  if (type === "quarter") return QUARTER_IDX(unit);
  if (type === "half") return HALF_IDX(unit);
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
}

// The equivalent window one period earlier, which may fall in the prior year.
function prevWindow(type: PeriodType, year: number, unit: number): { year: number; idxs: number[] } {
  if (type === "year") return { year: year - 1, idxs: windowFor("year", 0) };
  if (type === "month") return unit === 0 ? { year: year - 1, idxs: [11] } : { year, idxs: [unit - 1] };
  if (type === "quarter") return unit === 0 ? { year: year - 1, idxs: QUARTER_IDX(3) } : { year, idxs: QUARTER_IDX(unit - 1) };
  // half
  return unit === 0 ? { year: year - 1, idxs: HALF_IDX(1) } : { year, idxs: HALF_IDX(0) };
}

function periodLabel(type: PeriodType, year: number, unit: number): string {
  if (type === "month") return `${MONTHS_FULL[unit]} ${year}`;
  if (type === "quarter") return `Q${unit + 1} ${year}`;
  if (type === "half") return `H${unit + 1} ${year}`;
  return `${year}`;
}
function shortPrevLabel(type: PeriodType, year: number, unit: number): string {
  const p = prevWindow(type, year, unit);
  if (type === "month") return `${MONTHS[p.idxs[0]]} ${p.year}`;
  if (type === "quarter") return `Q${Math.floor(p.idxs[0] / 3) + 1} ${p.year}`;
  if (type === "half") return `H${p.idxs[0] === 0 ? 1 : 2} ${p.year}`;
  return `${p.year}`;
}

export default function BoardOverviewPage() {
  const { appUser, tenantId, churchName, loading: userLoading } = useAppUser();
  const router = useRouter();
  const canView = ["owner", "admin"].includes(appUser?.role || "");

  const now = new Date();
  const thisYear = now.getFullYear();

  // Default to the most recently COMPLETED month (the usual board send).
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const [type, setType] = useState<PeriodType>("month");
  const [year, setYear] = useState(lastMonthDate.getFullYear());
  const [unit, setUnit] = useState(lastMonthDate.getMonth()); // month 0-11 / quarter 0-3 / half 0-1

  const [raw, setRaw] = useState<{ members: RawMember[]; att: RawAtt[]; tx: RawTx[]; vis: RawVis[]; activeNow: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!tenantId || !canView) return;
    setLoading(true);
    setError("");
    Promise.all([
      getDocs(query(collection(db, "members"), where("tenantId", "==", tenantId))),
      getDocs(query(collection(db, "attendance"), where("tenantId", "==", tenantId))),
      getDocs(query(collection(db, "transactions"), where("tenantId", "==", tenantId))),
      getDocs(query(collection(db, "visitors"), where("tenantId", "==", tenantId))),
    ])
      .then(([mSnap, aSnap, tSnap, vSnap]) => {
        let activeNow = 0;
        const members: RawMember[] = mSnap.docs.map((d) => {
          const m = d.data() as Record<string, unknown>;
          if (m.status !== "suspended") activeNow += 1;
          return { created: tsToDate(m.createdAt), suspended: tsToDate(m.suspendedAt), isSuspended: m.status === "suspended" };
        });
        const att: RawAtt[] = aSnap.docs.map((d) => {
          const a = d.data() as Record<string, unknown>;
          return { date: (a.serviceDate as string) || "", present: a.status === "present" };
        });
        const tx: RawTx[] = tSnap.docs.map((d) => {
          const t = d.data() as Record<string, unknown>;
          return { date: (t.date as string) || "", expense: t.type === "expense", amount: (t.amount as number) || 0 };
        });
        const vis: RawVis[] = vSnap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return { date: (v.serviceDate as string) || "", followUp: (v.followUpStatus as string) || "" };
        });
        setRaw({ members, att, tx, vis, activeNow });
      })
      .catch((err) => {
        console.error("Board overview failed:", err);
        setError("Could not build the report right now. Please try again.");
      })
      .finally(() => setLoading(false));
  }, [tenantId, canView]);

  // 12 monthly buckets for a given calendar year, from the already-loaded data.
  function bucketize(y: number): MonthBucket[] {
    const buckets = Array.from({ length: 12 }, emptyMonth);
    if (!raw) return buckets;
    const yr = String(y);
    const mi = (d: string) => Number(d.slice(5, 7)) - 1;
    raw.members.forEach((m) => {
      if (m.created.startsWith(yr)) buckets[mi(m.created)].joins += 1;
      if (m.isSuspended && m.suspended.startsWith(yr)) buckets[mi(m.suspended)].suspensions += 1;
    });
    raw.att.forEach((a) => {
      if (!a.date.startsWith(yr)) return;
      const b = buckets[mi(a.date)];
      b.marked += 1;
      if (a.present) b.present += 1;
    });
    raw.tx.forEach((t) => {
      if (!t.date.startsWith(yr)) return;
      const b = buckets[mi(t.date)];
      if (t.expense) b.expense += t.amount; else b.income += t.amount;
    });
    raw.vis.forEach((v) => {
      if (!v.date.startsWith(yr)) return;
      const b = buckets[mi(v.date)];
      b.guests += 1;
      if (v.followUp === "done") b.guestsDone += 1;
      if (v.followUp !== "none") b.guestsNeeding += 1;
    });
    return buckets;
  }

  const prev = prevWindow(type, year, unit);
  const currentMonths = useMemo(() => bucketize(year), [raw, year]);
  const prevMonths = useMemo(() => bucketize(prev.year), [raw, prev.year]);

  const idxs = windowFor(type, unit);
  const cur = useMemo(() => agg(currentMonths, idxs), [currentMonths, type, unit]);
  const pre = useMemo(() => agg(prevMonths, prev.idxs), [prevMonths, prev.year, type, unit]);

  const label = periodLabel(type, year, unit);
  const prevLabel = shortPrevLabel(type, year, unit);

  const narrative = useMemo(() => {
    if (!raw) return [] as string[];
    const paras: string[] = [];
    const netDelta = net(cur) - net(pre);
    const attDelta = attRate(cur) - attRate(pre);
    const finDelta = finNet(cur) - finNet(pre);
    const incPct = pre.income > 0 ? Math.round(((cur.income - pre.income) / pre.income) * 100) : null;
    const guestDelta = cur.guests - pre.guests;
    const dir = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "level");

    paras.push(
      `Over ${label}, the church welcomed ${cur.joins} new member${cur.joins === 1 ? "" : "s"} and recorded ${cur.suspensions} suspension${cur.suspensions === 1 ? "" : "s"}, a net of ${net(cur) >= 0 ? "+" : ""}${net(cur)}. That is ${dir(netDelta)} on ${prevLabel} (${net(pre) >= 0 ? "+" : ""}${net(pre)}). Active membership currently stands at ${raw.activeNow}.`
    );
    paras.push(
      `Average attendance was ${attRate(cur)}%, ${attDelta === 0 ? "in line with" : `${dir(attDelta)} ${Math.abs(attDelta)} point${Math.abs(attDelta) === 1 ? "" : "s"} on`} ${prevLabel} (${attRate(pre)}%).`
    );
    paras.push(
      `Income was ${money(cur.income)} against ${money(cur.expense)} in expenses, a ${finNet(cur) >= 0 ? "surplus" : "shortfall"} of ${money(Math.abs(finNet(cur)))}. Income was ${incPct === null ? "up from nil" : `${dir(cur.income - pre.income)} ${Math.abs(incPct)}%`} versus ${prevLabel}, and the bottom line moved by ${money(Math.abs(finDelta))}.`
    );
    paras.push(
      `The church received ${cur.guests} first-time guest${cur.guests === 1 ? "" : "s"} (${guestDelta >= 0 ? "+" : ""}${guestDelta} on ${prevLabel}), and followed up ${followRate(cur)}% of those who needed it.`
    );
    return paras;
  }, [raw, cur, pre, label, prevLabel]);

  if (userLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="max-w-xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Board Overview</h1>
        <p className="text-sm text-gray-500">This report combines finance with the rest of the church data, so it is limited to owners and admins.</p>
      </div>
    );
  }

  const selectedSet = new Set(idxs);
  const chartMonthly = currentMonths.map((m, i) => ({
    month: MONTHS[i],
    net: net(m),
    attendance: attRate(m),
    income: Math.round(m.income),
    expense: Math.round(m.expense),
    guests: m.guests,
    selected: selectedSet.has(i),
  }));

  // Breakdown rows adapt to the selected period.
  function buildRows(): { label: string; b: MonthBucket; strong?: boolean; total?: boolean }[] {
    if (type === "year") {
      return [
        { label: "Q1 (Jan–Mar)", b: agg(currentMonths, QUARTER_IDX(0)) },
        { label: "Q2 (Apr–Jun)", b: agg(currentMonths, QUARTER_IDX(1)) },
        { label: "H1 (Jan–Jun)", b: agg(currentMonths, HALF_IDX(0)), strong: true },
        { label: "Q3 (Jul–Sep)", b: agg(currentMonths, QUARTER_IDX(2)) },
        { label: "Q4 (Oct–Dec)", b: agg(currentMonths, QUARTER_IDX(3)) },
        { label: "H2 (Jul–Dec)", b: agg(currentMonths, HALF_IDX(1)), strong: true },
        { label: "Full Year", b: cur, total: true },
      ];
    }
    if (type === "half") {
      const qs = unit === 0 ? [0, 1] : [2, 3];
      return [
        ...qs.map((q) => ({ label: `Q${q + 1} (${MONTHS[q * 3]}–${MONTHS[q * 3 + 2]})`, b: agg(currentMonths, QUARTER_IDX(q)) })),
        { label: label, b: cur, total: true },
      ];
    }
    if (type === "quarter") {
      return [
        ...idxs.map((i) => ({ label: MONTHS_FULL[i], b: currentMonths[i] })),
        { label: label, b: cur, total: true },
      ];
    }
    // month: this month vs the previous month for context
    return [
      { label: prevLabel, b: pre },
      { label: label, b: cur, total: true },
    ];
  }
  const rows = buildRows();

  const tiles = [
    { label: "Net membership", value: `${net(cur) >= 0 ? "+" : ""}${net(cur)}`, sub: `${prevLabel}: ${net(pre) >= 0 ? "+" : ""}${net(pre)}` },
    { label: "Avg attendance", value: `${attRate(cur)}%`, sub: `${prevLabel}: ${attRate(pre)}%` },
    { label: "Net finances", value: money(finNet(cur)), sub: `${prevLabel}: ${money(finNet(pre))}` },
    { label: "First-time guests", value: String(cur.guests), sub: `${prevLabel}: ${pre.guests}` },
  ];

  return (
    <div id="board-report">
      <style>{`@media print {
        body * { visibility: hidden; }
        #board-report, #board-report * { visibility: visible; }
        #board-report { position: absolute; left: 0; top: 0; width: 100%; padding: 0 8mm; }
        .no-print { display: none !important; }
      }`}</style>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <button onClick={() => router.push("/dashboard/reports")} className="no-print text-sm text-gray-500 hover:text-gray-800 mb-1">
            ← Reports
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{churchName || "Church"} — {label} Overview</h1>
          <p className="text-sm text-gray-500 mt-1">
            Membership, attendance, finances and guests, compared to {prevLabel}.
          </p>
        </div>
        <button
          onClick={() => window.print()}
          disabled={!raw}
          className="no-print flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition disabled:opacity-40 shadow-sm"
        >
          🖨 Print / PDF
        </button>
      </div>

      {/* Period controls */}
      <div className="no-print flex flex-wrap items-end gap-3 mb-6">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Period</label>
          <div className="flex gap-1">
            {(["month", "quarter", "half", "year"] as PeriodType[]).map((t) => (
              <button
                key={t}
                onClick={() => { setType(t); if (t === "quarter") setUnit(Math.min(unit, 3)); if (t === "half") setUnit(Math.min(unit, 1)); if (t === "month" && unit > 11) setUnit(0); }}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border capitalize transition-colors ${
                  type === t ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                {t === "half" ? "Half-year" : t}
              </button>
            ))}
          </div>
        </div>
        {type !== "year" && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              {type === "month" ? "Month" : type === "quarter" ? "Quarter" : "Half"}
            </label>
            <select
              value={unit}
              onChange={(e) => setUnit(Number(e.target.value))}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              {type === "month" && MONTHS_FULL.map((m, i) => <option key={i} value={i}>{m}</option>)}
              {type === "quarter" && [0, 1, 2, 3].map((q) => <option key={q} value={q}>Q{q + 1}</option>)}
              {type === "half" && [0, 1].map((h) => <option key={h} value={h}>H{h + 1}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Year</label>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            {[0, 1, 2, 3].map((i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4">{error}</p>}

      {loading || !raw ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* Headline numbers */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {tiles.map((s) => (
              <div key={s.label} className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs text-gray-500">{s.label}</p>
                <p className="text-xl font-bold text-gray-900 mt-1">{s.value}</p>
                <p className="text-xs text-gray-400 mt-0.5">{s.sub}</p>
              </div>
            ))}
          </div>

          {/* Narrative */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
            <h2 className="text-sm font-bold text-gray-900 mb-3">{label} in words</h2>
            <div className="space-y-2">
              {narrative.map((p, i) => <p key={i} className="text-sm text-gray-700 leading-relaxed">{p}</p>)}
            </div>
          </div>

          {/* Graphs — full-year trend with the selected period highlighted */}
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">{year} trend {type !== "year" ? "(selected period highlighted)" : ""}</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Net membership by month</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartMonthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="net" radius={[3, 3, 0, 0]}>
                    {chartMonthly.map((d, i) => <Cell key={i} fill={d.selected ? "#059669" : "#cbd5e1"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Attendance % by month</h3>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartMonthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                  <Tooltip />
                  <Line type="monotone" dataKey="attendance" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Income vs expense by month</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartMonthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => money(v)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="income" name="Income" fill="#059669" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="expense" name="Expense" fill="#ef4444" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">First-time guests by month</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartMonthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="guests" name="Guests" radius={[3, 3, 0, 0]}>
                    {chartMonthly.map((d, i) => <Cell key={i} fill={d.selected ? "#8b5cf6" : "#ddd6fe"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Breakdown table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800">Breakdown</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wider">
                    <th className="text-left px-4 py-3">Period</th>
                    <th className="text-right px-4 py-3">Joined</th>
                    <th className="text-right px-4 py-3">Suspended</th>
                    <th className="text-right px-4 py-3">Net</th>
                    <th className="text-right px-4 py-3">Attendance</th>
                    <th className="text-right px-4 py-3">Income</th>
                    <th className="text-right px-4 py-3">Expense</th>
                    <th className="text-right px-4 py-3">Net Finance</th>
                    <th className="text-right px-4 py-3">Guests</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r, i) => (
                    <tr key={i} className={r.total ? "bg-emerald-50/60 font-semibold" : r.strong ? "bg-gray-50/60" : ""}>
                      <td className="px-4 py-2.5 text-gray-800">{r.label}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{r.b.joins}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{r.b.suspensions}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{net(r.b) >= 0 ? "+" : ""}{net(r.b)}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{attRate(r.b)}%</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{money(r.b.income)}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{money(r.b.expense)}</td>
                      <td className={`px-4 py-2.5 text-right ${finNet(r.b) >= 0 ? "text-emerald-700" : "text-red-600"}`}>{money(finNet(r.b))}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{r.b.guests}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-gray-400 mt-4">
            Finances are drawn from recorded transactions (approved cell offerings post here automatically). Generated {new Date().toLocaleString("en-ZA")}.
          </p>
        </>
      )}
    </div>
  );
}
