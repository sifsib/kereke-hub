"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { db } from "../../../../lib/firebase";
import { useAppUser } from "../../../../lib/useAppUser";
import { collection, query, where, getDocs } from "firebase/firestore";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";

// ────────────────────────────────────────────────────────────────────────────
// NARRATIVE ANNUAL REPORT
//
// An executive, board-facing report for one year. It pulls the same underlying
// data as the individual reports (membership, attendance, finance, visitors),
// rolls it up by month, quarter, half-year and full year, draws a few graphs,
// and writes a plain-language narrative off the numbers. Owner/admin only, since
// it combines finance with everything else. Printable to PDF.
// ────────────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface MonthBucket {
  joins: number;
  suspensions: number;
  present: number;
  marked: number;
  income: number;
  expense: number;
  guests: number;
  guestsDone: number;
  guestsNeeding: number;
}

const emptyMonth = (): MonthBucket => ({
  joins: 0, suspensions: 0, present: 0, marked: 0, income: 0, expense: 0, guests: 0, guestsDone: 0, guestsNeeding: 0,
});

const money = (n: number) =>
  `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function tsToDate(v: unknown): string {
  const t = v as { toDate?: () => Date } | undefined;
  if (t && typeof t.toDate === "function") {
    try { return t.toDate().toISOString().slice(0, 10); } catch { return ""; }
  }
  return typeof v === "string" ? v.slice(0, 10) : "";
}

// Aggregate a set of month indexes into one bucket.
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

export default function NarrativeReportPage() {
  const { appUser, tenantId, churchName, loading: userLoading } = useAppUser();
  const router = useRouter();
  const canView = ["owner", "admin"].includes(appUser?.role || "");

  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [months, setMonths] = useState<MonthBucket[] | null>(null);
  const [activeNow, setActiveNow] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!tenantId || !canView) return;
    setLoading(true);
    setError("");
    const yr = String(year);
    const inYear = (d: string) => d.startsWith(yr);
    const monthIdx = (d: string) => Number(d.slice(5, 7)) - 1;

    Promise.all([
      getDocs(query(collection(db, "members"), where("tenantId", "==", tenantId))),
      getDocs(query(collection(db, "attendance"), where("tenantId", "==", tenantId))),
      getDocs(query(collection(db, "transactions"), where("tenantId", "==", tenantId))),
      getDocs(query(collection(db, "visitors"), where("tenantId", "==", tenantId))),
    ])
      .then(([mSnap, aSnap, tSnap, vSnap]) => {
        const buckets = Array.from({ length: 12 }, emptyMonth);
        let active = 0;
        mSnap.forEach((d) => {
          const m = d.data() as Record<string, unknown>;
          if (m.status !== "suspended") active += 1;
          const created = tsToDate(m.createdAt);
          if (inYear(created)) buckets[monthIdx(created)].joins += 1;
          if (m.status === "suspended") {
            const s = tsToDate(m.suspendedAt);
            if (inYear(s)) buckets[monthIdx(s)].suspensions += 1;
          }
        });
        aSnap.forEach((d) => {
          const a = d.data() as Record<string, unknown>;
          const date = (a.serviceDate as string) || "";
          if (!inYear(date)) return;
          const b = buckets[monthIdx(date)];
          b.marked += 1;
          if (a.status === "present") b.present += 1;
        });
        tSnap.forEach((d) => {
          const t = d.data() as Record<string, unknown>;
          const date = (t.date as string) || "";
          if (!inYear(date)) return;
          const b = buckets[monthIdx(date)];
          const amt = (t.amount as number) || 0;
          if (t.type === "expense") b.expense += amt;
          else b.income += amt;
        });
        vSnap.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const date = (v.serviceDate as string) || "";
          if (!inYear(date)) return;
          const b = buckets[monthIdx(date)];
          b.guests += 1;
          if (v.followUpStatus === "done") b.guestsDone += 1;
          if (v.followUpStatus !== "none") b.guestsNeeding += 1;
        });
        setMonths(buckets);
        setActiveNow(active);
      })
      .catch((err) => {
        console.error("Narrative report failed:", err);
        setError("Could not build the report right now. Please try again.");
      })
      .finally(() => setLoading(false));
  }, [tenantId, canView, year]);

  const derived = useMemo(() => {
    if (!months) return null;
    const annual = agg(months, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const h1 = agg(months, [0, 1, 2, 3, 4, 5]);
    const h2 = agg(months, [6, 7, 8, 9, 10, 11]);
    const quarters = [0, 1, 2, 3].map((q) => agg(months, [q * 3, q * 3 + 1, q * 3 + 2]));
    return { annual, h1, h2, quarters };
  }, [months]);

  // Auto-written narrative from the numbers.
  const narrative = useMemo(() => {
    if (!months || !derived) return [];
    const { annual, h1, h2 } = derived;
    const paras: string[] = [];
    const strongestGiving = months.reduce((best, m, i) => (m.income > months[best].income ? i : best), 0);
    const leanestGiving = months.reduce((worst, m, i) => (m.income < months[worst].income ? i : worst), 0);
    const bestNetMonth = months.reduce((best, m, i) => (net(m) > net(months[best]) ? i : best), 0);

    paras.push(
      `In ${year}, the church welcomed ${annual.joins} new member${annual.joins === 1 ? "" : "s"} and recorded ${annual.suspensions} suspension${annual.suspensions === 1 ? "" : "s"}, a net change of ${net(annual) >= 0 ? "+" : ""}${net(annual)}. The strongest month for net growth was ${MONTHS[bestNetMonth]}. The active membership currently stands at ${activeNow}.`
    );
    paras.push(
      `Momentum ${net(h2) > net(h1) ? "built through the year" : net(h2) < net(h1) ? "eased in the second half" : "held steady across the two halves"}: the first half closed at a net ${net(h1) >= 0 ? "+" : ""}${net(h1)} and the second half at ${net(h2) >= 0 ? "+" : ""}${net(h2)}.`
    );
    paras.push(
      `Average attendance for the year was ${attRate(annual)}%, moving from ${attRate(h1)}% in the first half to ${attRate(h2)}% in the second.`
    );
    paras.push(
      `On finances, income totalled ${money(annual.income)} against ${money(annual.expense)} in expenses, leaving a ${finNet(annual) >= 0 ? "surplus" : "shortfall"} of ${money(Math.abs(finNet(annual)))}. Giving was strongest in ${MONTHS[strongestGiving]} and leanest in ${MONTHS[leanestGiving]}.`
    );
    paras.push(
      `The church received ${annual.guests} first-time guest${annual.guests === 1 ? "" : "s"} over the year, and followed up ${followRate(annual)}% of those who needed it.`
    );
    return paras;
  }, [months, derived, year, activeNow]);

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
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Annual Report</h1>
        <p className="text-sm text-gray-500">This report combines finance with the rest of the church data, so it is limited to owners and admins.</p>
      </div>
    );
  }

  const chartMonthly = (months || []).map((m, i) => ({
    month: MONTHS[i],
    net: net(m),
    attendance: attRate(m),
    income: Math.round(m.income),
    expense: Math.round(m.expense),
    guests: m.guests,
  }));

  const periodRows = derived
    ? [
        { label: "Q1 (Jan–Mar)", b: derived.quarters[0] },
        { label: "Q2 (Apr–Jun)", b: derived.quarters[1] },
        { label: "H1 (Jan–Jun)", b: derived.h1, strong: true },
        { label: "Q3 (Jul–Sep)", b: derived.quarters[2] },
        { label: "Q4 (Oct–Dec)", b: derived.quarters[3] },
        { label: "H2 (Jul–Dec)", b: derived.h2, strong: true },
        { label: "Full Year", b: derived.annual, total: true },
      ]
    : [];

  return (
    <div id="narrative-report">
      {/* Print styling: on print, show only this report, hide the dashboard chrome. */}
      <style>{`@media print {
        body * { visibility: hidden; }
        #narrative-report, #narrative-report * { visibility: visible; }
        #narrative-report { position: absolute; left: 0; top: 0; width: 100%; padding: 0 8mm; }
        .no-print { display: none !important; }
      }`}</style>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <button onClick={() => router.push("/dashboard/reports")} className="no-print text-sm text-gray-500 hover:text-gray-800 mb-1">
            ← Reports
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{churchName || "Church"} — Annual Report {year}</h1>
          <p className="text-sm text-gray-500 mt-1">
            Membership, attendance, finances and guests for {year}, by month, quarter and half-year.
          </p>
        </div>
        <div className="no-print flex items-center gap-2">
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            {[0, 1, 2, 3].map((i) => thisYear - i).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button
            onClick={() => window.print()}
            disabled={!months}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition disabled:opacity-40 shadow-sm"
          >
            🖨 Print / PDF
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4">{error}</p>}

      {loading || !derived ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* Headline numbers */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {[
              { label: "Net membership change", value: `${net(derived.annual) >= 0 ? "+" : ""}${net(derived.annual)}` },
              { label: "Avg attendance", value: `${attRate(derived.annual)}%` },
              { label: "Net finances", value: money(finNet(derived.annual)) },
              { label: "First-time guests", value: String(derived.annual.guests) },
            ].map((s) => (
              <div key={s.label} className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs text-gray-500">{s.label}</p>
                <p className="text-xl font-bold text-gray-900 mt-1">{s.value}</p>
              </div>
            ))}
          </div>

          {/* Narrative */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
            <h2 className="text-sm font-bold text-gray-900 mb-3">The year in words</h2>
            <div className="space-y-2">
              {narrative.map((p, i) => (
                <p key={i} className="text-sm text-gray-700 leading-relaxed">{p}</p>
              ))}
            </div>
          </div>

          {/* Graphs */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Net membership by month</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartMonthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="net" fill="#059669" radius={[3, 3, 0, 0]} />
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
                  <Bar dataKey="guests" name="Guests" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Period breakdown table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800">By quarter and half-year</h3>
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
                  {periodRows.map((r) => (
                    <tr key={r.label} className={r.total ? "bg-emerald-50/60 font-semibold" : r.strong ? "bg-gray-50/60" : ""}>
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

          {/* Monthly detail */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800">Month by month</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wider">
                    <th className="text-left px-4 py-3">Month</th>
                    <th className="text-right px-4 py-3">Net</th>
                    <th className="text-right px-4 py-3">Attendance</th>
                    <th className="text-right px-4 py-3">Income</th>
                    <th className="text-right px-4 py-3">Expense</th>
                    <th className="text-right px-4 py-3">Guests</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(months || []).map((m, i) => (
                    <tr key={i}>
                      <td className="px-4 py-2.5 text-gray-800">{MONTHS[i]}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{net(m) >= 0 ? "+" : ""}{net(m)}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{attRate(m)}%</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{money(m.income)}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{money(m.expense)}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{m.guests}</td>
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
