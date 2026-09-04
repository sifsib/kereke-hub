"use client";

import { useEffect, useState, useMemo } from "react";
import { db } from "../../../../lib/firebase";
import DateInput from "../../../../components/ui/DateInput";
import { useAppUser } from "../../../../lib/useAppUser";
import {
  collection,
  query,
  where,
  getDocs,
  getDoc,
  doc,
} from "firebase/firestore";

// Cell groups belong to a branch via cellGroupBranch. Groups with no branch
// assigned stay visible under every branch (legacy-safe).
function cellGroupsForBranch(
  cellGroups: string[],
  cellGroupBranch: Record<string, string>,
  branch: string,
): string[] {
  if (!branch || branch === "all") return cellGroups;
  return cellGroups.filter(cg => !cellGroupBranch[cg] || cellGroupBranch[cg] === branch);
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  fullName: string;
  role: string;
  branch?: string;
  cellRegion?: string;
  ministryGroup?: string;
}

interface AttendanceRecord {
  id: string;
  personId: string;
  serviceId: string;
  serviceDate: string;
  serviceType: string;
  sessionName: string;
  status: "present" | "absent";
  reported?: boolean | null;
  absenceReason?: string | null;
}

interface ServiceSession {
  id: string;
  day: string;
  name: string;
}

type Period = "week" | "mtd" | "month" | "qtd" | "quarter" | "ytd" | "year" | "custom";
type View = "overview" | "region" | "person" | "dropoff" | "drilldown";

const DAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// ─── Date helpers ───────────────────────────────────────────────────────────

function toISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getPeriodRange(period: Period, customStart?: string, customEnd?: string): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (period) {
    case "week": {
      const day = now.getDay();
      const mon = new Date(now); mon.setDate(now.getDate() - ((day + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { start: toISO(mon), end: toISO(sun) };
    }
    case "mtd":
      return { start: `${y}-${String(m + 1).padStart(2, "0")}-01`, end: toISO(now) };
    case "month": {
      const last = new Date(y, m + 1, 0);
      return { start: `${y}-${String(m + 1).padStart(2, "0")}-01`, end: toISO(last) };
    }
    case "qtd": {
      const qStart = new Date(y, Math.floor(m / 3) * 3, 1);
      return { start: toISO(qStart), end: toISO(now) };
    }
    case "quarter": {
      const qs = Math.floor(m / 3) * 3;
      const qEnd = new Date(y, qs + 3, 0);
      return { start: toISO(new Date(y, qs, 1)), end: toISO(qEnd) };
    }
    case "ytd":
      return { start: `${y}-01-01`, end: toISO(now) };
    case "year":
      return { start: `${y}-01-01`, end: `${y}-12-31` };
    case "custom":
      return { start: customStart || toISO(now), end: customEnd || toISO(now) };
    default:
      return { start: toISO(now), end: toISO(now) };
  }
}

function formatDateDisplay(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function formatPeriodLabel(start: string, end: string) {
  return `${formatDateDisplay(start)} to ${formatDateDisplay(end)}`;
}

function getPctColor(pct: number) {
  if (pct >= 75) return "text-emerald-600";
  if (pct >= 50) return "text-amber-500";
  return "text-red-500";
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function AttendanceReportPage() {
  const { appUser, loading: userLoading } = useAppUser();

  const [allMembers, setMembers] = useState<Member[]>([]);
  const [allAttendance, setAllAttendance] = useState<AttendanceRecord[]>([]);
  const [sessions, setSessions] = useState<ServiceSession[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [cellGroupBranch, setCellGroupBranch] = useState<Record<string, string>>({});
  const [allCellRegions, setAllCellRegions] = useState<string[]>([]);
  const [branchFilter, setBranchFilter] = useState("all");

  // Everything downstream reads these branch-scoped lists, so switching branch
  // narrows the whole report at once.
  const members = useMemo(
    () => branchFilter === "all" ? allMembers : allMembers.filter(m => m.branch === branchFilter),
    [allMembers, branchFilter],
  );
  const cellRegions = useMemo(
    () => cellGroupsForBranch(allCellRegions, cellGroupBranch, branchFilter),
    [allCellRegions, cellGroupBranch, branchFilter],
  );
  const [loading, setLoading] = useState(true);

  // UI state
  const [period, setPeriod] = useState<Period>("mtd");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string>("all");
  const [view, setView] = useState<View>("overview");
  const [regionFilter, setRegionFilter] = useState("all");
  const [drilldownMemberId, setDrilldownMemberId] = useState<string | null>(null);

  // ─── Load all data once ─────────────────────────────────────────────────────

  useEffect(() => {
    if (userLoading || !appUser) return;

    const load = async () => {
      setLoading(true);
      const tenantId = appUser.tenantId;

      try {
        // Tenant config
        const tenantSnap = await getDoc(doc(db, "tenants", tenantId));
        const td = tenantSnap.data() || {};
        setSessions(td.serviceSessions || []);
        setBranches(td.branches || []);
        setCellGroupBranch(td.cellGroupBranch || {});
        setAllCellRegions(td.cellRegions || []);

        // Members. Cell leaders are scoped to their cell group; branch admins
        // to their branch.
        const isCellLeader = appUser.role === "cell_leader";
        const isBranchAdmin = appUser.role === "branch_admin";
        const mQuery = isCellLeader && appUser.assignedCellRegion
          ? query(collection(db, "members"), where("tenantId", "==", tenantId), where("cellRegion", "==", appUser.assignedCellRegion))
          : isBranchAdmin && appUser.assignedBranch
          ? query(collection(db, "members"), where("tenantId", "==", tenantId), where("branch", "==", appUser.assignedBranch))
          : query(collection(db, "members"), where("tenantId", "==", tenantId));
        const mSnap = await getDocs(mQuery);
        const mList: Member[] = [];
        // Suspended members don't count toward attendance stats — the whole
        // report (overall %, cell group breakdown, falling-off alerts, by-member
        // list) should run on active members only.
        mSnap.forEach(d => {
          const data = d.data() as any;
          if (data.status === "suspended") return;
          mList.push({ id: d.id, ...data } as Member);
        });
        mList.sort((a, b) => a.fullName.localeCompare(b.fullName));
        setMembers(mList);

        // All attendance for this tenant
        const aSnap = await getDocs(
          query(collection(db, "attendance"), where("tenantId", "==", tenantId))
        );
        const aList: AttendanceRecord[] = [];
        aSnap.forEach(d => aList.push({ id: d.id, ...d.data() } as AttendanceRecord));
        setAllAttendance(aList);
      } catch (e) {
        console.error("Failed to load report data:", e);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [appUser, userLoading]);

  // ─── Derived data ───────────────────────────────────────────────────────────

  const { start, end } = useMemo(
    () => getPeriodRange(period, customStart, customEnd),
    [period, customStart, customEnd]
  );

  // All unique service dates in the period (matching session filter)
  const servicesInPeriod = useMemo(() => {
    const ids = new Set<string>();
    allAttendance.forEach(a => {
      if (a.serviceDate >= start && a.serviceDate <= end) {
        if (activeSessionId === "all" || a.serviceType === activeSessionId) {
          ids.add(a.serviceId);
        }
      }
    });
    return Array.from(ids).sort();
  }, [allAttendance, start, end, activeSessionId]);

  const attendanceInPeriod = useMemo(
    () => allAttendance.filter(a => servicesInPeriod.includes(a.serviceId)),
    [allAttendance, servicesInPeriod]
  );

  function getStatus(personId: string, serviceId: string) {
    const rec = attendanceInPeriod.find(a => a.personId === personId && a.serviceId === serviceId);
    if (!rec) return "unknown";
    if (rec.status === "present") return "present";
    return rec.reported ? "absent-reported" : "absent";
  }

  function personStats(personId: string) {
    let present = 0, absentReported = 0, absent = 0;
    servicesInPeriod.forEach(sid => {
      const s = getStatus(personId, sid);
      if (s === "present") present++;
      else if (s === "absent-reported") absentReported++;
      else if (s === "absent") absent++;
    });
    const total = servicesInPeriod.length;
    const pct = total > 0 ? Math.round((present / total) * 100) : null;
    return { present, absentReported, absent, total, pct };
  }

  function regionStats(region: string) {
    const inRegion = members.filter(m => m.cellRegion === region);
    if (inRegion.length === 0 || servicesInPeriod.length === 0) return { pct: 0, present: 0, slots: 0 };
    let present = 0;
    const slots = inRegion.length * servicesInPeriod.length;
    inRegion.forEach(m => {
      servicesInPeriod.forEach(sid => {
        if (getStatus(m.id, sid) === "present") present++;
      });
    });
    return { pct: Math.round((present / slots) * 100), present, slots };
  }

  // People falling off: 3 consecutive unreported absences OR 5 consecutive absent
  const fallingOff = useMemo(() => {
    const last5 = [...servicesInPeriod].sort((a, b) => b.localeCompare(a)).slice(0, 5);
    if (last5.length < 3) return [];
    const flagged: { member: Member; reason: string; dots: string[] }[] = [];

    members.forEach(member => {
      const statuses = last5.map(sid => {
        const rec = attendanceInPeriod.find(a => a.personId === member.id && a.serviceId === sid);
        if (!rec) return { status: "absent", reported: false };
        return { status: rec.status, reported: !!rec.reported };
      });
      const last3 = statuses.slice(0, 3);
      const unreported3 = last3.every(s => s.status === "absent" && !s.reported);
      const all5Absent = statuses.length === 5 && statuses.every(s => s.status === "absent");

      if (unreported3 || all5Absent) {
        flagged.push({
          member,
          reason: all5Absent ? "5 consecutive absences" : "3 unreported absences in a row",
          dots: statuses.map(s => s.status === "present" ? "present" : s.reported ? "reported" : "absent"),
        });
      }
    });
    return flagged;
  }, [members, servicesInPeriod, attendanceInPeriod]);

  // ─── Overview stats ─────────────────────────────────────────────────────────

  const overallStats = useMemo(() => {
    if (servicesInPeriod.length === 0 || members.length === 0) return null;
    let present = 0;
    const slots = members.length * servicesInPeriod.length;
    members.forEach(m => {
      servicesInPeriod.forEach(sid => {
        if (getStatus(m.id, sid) === "present") present++;
      });
    });
    return { pct: Math.round((present / slots) * 100), services: servicesInPeriod.length, people: members.length };
  }, [members, servicesInPeriod, attendanceInPeriod]);

  // ─── Render helpers ─────────────────────────────────────────────────────────

  const periodTabs: { label: string; value: Period }[] = [
    { label: "Week", value: "week" },
    { label: "MTD", value: "mtd" },
    { label: "Month", value: "month" },
    { label: "QTD", value: "qtd" },
    { label: "Quarter", value: "quarter" },
    { label: "YTD", value: "ytd" },
    { label: "Year", value: "year" },
    { label: "Custom", value: "custom" },
  ];

  // ─── Loading ────────────────────────────────────────────────────────────────

  if (userLoading || loading) {
    return (
      <div className="max-w-4xl mx-auto p-10 flex items-center gap-3">
        <div className="spinner !border-blue-600 !border-t-transparent" />
        <p className="text-gray-500 text-sm">Loading report data...</p>
      </div>
    );
  }

  // ─── Drilldown view ─────────────────────────────────────────────────────────

  if (view === "drilldown" && drilldownMemberId) {
    const member = members.find(m => m.id === drilldownMemberId);
    if (!member) { setView("person"); return null; }
    const stats = personStats(member.id);
    const history = [...servicesInPeriod].sort((a, b) => b.localeCompare(a)).map(sid => {
      const rec = attendanceInPeriod.find(a => a.personId === member.id && a.serviceId === sid);
      const dateStr = sid.split("_")[0];
      const status = getStatus(member.id, sid);
      return { sid, dateStr, status, reason: rec?.absenceReason, sessionName: rec?.sessionName };
    });

    return (
      <div className="max-w-3xl mx-auto p-6 flex flex-col gap-6">
        <button
          onClick={() => { setView("person"); setDrilldownMemberId(null); }}
          className="text-sm text-blue-600 hover:underline flex items-center gap-1 w-fit"
        >
          &lsaquo; Back to By Member
        </button>

        <div>
          <h2 className="text-2xl font-bold text-gray-800">{member.fullName}</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {member.role}
            {member.cellRegion && <> &middot; {member.cellRegion}</>}
            {member.ministryGroup && <> &middot; {member.ministryGroup}</>}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Attendance", value: stats.pct != null ? `${stats.pct}%` : "N/A", color: stats.pct != null ? getPctColor(stats.pct) : "text-gray-500" },
            { label: "Present", value: stats.present, color: "text-emerald-600" },
            { label: "Absent", value: stats.absentReported + stats.absent, color: "text-red-500" },
          ].map(s => (
            <div key={s.label} className="bg-white border rounded-lg p-4 text-center shadow-sm">
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500 mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {stats.absentReported + stats.absent > 0 && (
          <p className="text-xs text-gray-500">
            Of absences: <strong>{stats.absentReported}</strong> reported, <strong>{stats.absent}</strong> not reported
          </p>
        )}

        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Service History</p>
          </div>
          {history.length === 0 ? (
            <p className="p-6 text-sm text-gray-400 text-center">No services recorded in this period.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {history.map(({ sid, dateStr, status, reason, sessionName }) => {
                const label = status === "present" ? "Present"
                  : status === "absent-reported" ? "Absent (reported)"
                  : "Absent";
                const color = status === "present" ? "text-emerald-600"
                  : status === "absent-reported" ? "text-amber-500"
                  : "text-red-500";
                const dot = status === "present" ? "bg-emerald-500"
                  : status === "absent-reported" ? "bg-amber-400"
                  : "bg-red-400";
                return (
                  <div key={sid} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-800">{formatDateDisplay(dateStr)}</p>
                      {sessionName && <p className="text-xs text-gray-400">{sessionName}</p>}
                      {reason && <p className="text-xs text-gray-500 italic mt-0.5">{reason}</p>}
                    </div>
                    <span className={`flex items-center gap-1.5 text-sm font-semibold ${color}`}>
                      <span className={`w-2 h-2 rounded-full ${dot}`} />
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Main report views ──────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto p-6 flex flex-col gap-6">

      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-800">Attendance Report</h1>
        <p className="text-gray-500 text-sm mt-1">
          Analyse attendance trends across services, branches, cell groups, and members
        </p>
      </div>

      {/* Period selector */}
      <div className="bg-white border rounded-lg p-4 shadow-sm flex flex-col gap-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Period</p>
        <div className="flex flex-wrap gap-2">
          {periodTabs.map(t => (
            <button
              key={t.value}
              onClick={() => setPeriod(t.value)}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-colors ${
                period === t.value
                  ? "bg-blue-100 text-blue-700 border-blue-300"
                  : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {period === "custom" && (
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Start</label>
              <DateInput value={customStart} onChange={(val) => setCustomStart(val)}
                className="border rounded p-1.5 text-sm text-gray-700 focus:outline-blue-500" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">End</label>
              <DateInput value={customEnd} onChange={(val) => setCustomEnd(val)}
                className="border rounded p-1.5 text-sm text-gray-700 focus:outline-blue-500" />
            </div>
          </div>
        )}

        <p className="text-xs text-gray-400">
          {formatPeriodLabel(start, end)} &middot; {servicesInPeriod.length} service{servicesInPeriod.length !== 1 ? "s" : ""}
        </p>

        {/* Session filter */}
        {sessions.length > 1 && (
          <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-100">
            <span className="text-xs text-gray-400 font-medium self-center">Session:</span>
            <button
              onClick={() => setActiveSessionId("all")}
              className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${
                activeSessionId === "all" ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
              }`}
            >
              All
            </button>
            {sessions.map(s => (
              <button key={s.id} onClick={() => setActiveSessionId(s.id)}
                className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${
                  activeSessionId === s.id ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        {/* Branch filter — scopes the whole report to one campus */}
        {branches.length > 1 && (
          <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-100">
            <span className="text-xs text-gray-400 font-medium self-center">Branch:</span>
            <button
              onClick={() => { setBranchFilter("all"); setRegionFilter("all"); }}
              className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${
                branchFilter === "all" ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
              }`}
            >
              All
            </button>
            {branches.map(b => (
              <button key={b} onClick={() => { setBranchFilter(b); setRegionFilter("all"); }}
                className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${
                  branchFilter === b ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
                }`}
              >
                {b}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Section tabs */}
      <div className="flex gap-2 border-b border-gray-200 pb-0">
        {[
          { label: "Overview", value: "overview" as View },
          { label: "By Cell Group", value: "region" as View },
          { label: "By Member", value: "person" as View },
          { label: `Falling Off${fallingOff.length > 0 ? ` (${fallingOff.length})` : ""}`, value: "dropoff" as View },
        ].map(tab => (
          <button
            key={tab.value}
            onClick={() => setView(tab.value)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
              view === tab.value
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ─────────────────────────────────────────────────────────── */}
      {view === "overview" && (
        <div className="flex flex-col gap-6">
          {!overallStats || servicesInPeriod.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No attendance data for this period.</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: "Avg. Attendance", value: `${overallStats.pct}%`, color: getPctColor(overallStats.pct) },
                  { label: "Services", value: overallStats.services, color: "text-gray-800" },
                  { label: "Members", value: overallStats.people, color: "text-gray-800" },
                ].map(s => (
                  <div key={s.label} className="bg-white border rounded-lg p-5 text-center shadow-sm">
                    <p className={`text-3xl font-bold ${s.color}`}>{s.value}</p>
                    <p className="text-xs text-gray-500 mt-1">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Region summary in overview */}
              {cellRegions.length > 0 && (
                <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b bg-gray-50">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Cell Groups at a Glance</p>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {cellRegions
                      .map(r => ({ region: r, stats: regionStats(r) }))
                      .filter(row => row.stats.slots > 0)
                      .sort((a, b) => b.stats.pct - a.stats.pct)
                      .map(({ region, stats }) => (
                        <div key={region} className="flex items-center justify-between px-4 py-3">
                          <p className="text-sm font-medium text-gray-700">{region}</p>
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-gray-400">{stats.present} / {stats.slots}</span>
                            <span className={`text-sm font-bold ${getPctColor(stats.pct)}`}>{stats.pct}%</span>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Falling off callout */}
              {fallingOff.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
                  <span className="text-amber-500 text-lg">⚠</span>
                  <div>
                    <p className="text-sm font-semibold text-amber-800">
                      {fallingOff.length} member{fallingOff.length > 1 ? "s" : ""} may be falling off
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      Check the Falling Off tab for details.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── BY REGION ────────────────────────────────────────────────────────── */}
      {view === "region" && (
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          {cellRegions.length === 0 ? (
            <p className="p-8 text-center text-sm text-gray-400">
              No Cell Groups configured. Add them in Configure Lists to enable cell group reporting.
            </p>
          ) : servicesInPeriod.length === 0 ? (
            <p className="p-8 text-center text-sm text-gray-400">No attendance data for this period.</p>
          ) : (
            <>
              <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Cell Group Breakdown</p>
                <select
                  value={regionFilter}
                  onChange={e => setRegionFilter(e.target.value)}
                  className="text-xs border rounded p-1 text-gray-600 focus:outline-blue-500"
                >
                  <option value="all">All cell groups</option>
                  {cellRegions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>

              {/* Region rows */}
              {(regionFilter === "all" ? cellRegions : [regionFilter])
                .map(r => {
                  const stats = regionStats(r);
                  const inRegion = members.filter(m => m.cellRegion === r);
                  return (
                    <div key={r}>
                      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b">
                        <p className="text-sm font-semibold text-gray-700">{r}</p>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-gray-400">{stats.present}/{stats.slots} slots</span>
                          <span className={`text-sm font-bold ${getPctColor(stats.pct)}`}>{stats.pct}%</span>
                        </div>
                      </div>
                      {regionFilter !== "all" && (
                        <div className="divide-y divide-gray-100">
                          {inRegion
                            .map(m => {
                              const ps = personStats(m.id);
                              return { m, ps };
                            })
                            .sort((a, b) => (a.ps.pct ?? 0) - (b.ps.pct ?? 0))
                            .map(({ m, ps }) => (
                              <button
                                key={m.id}
                                onClick={() => { setDrilldownMemberId(m.id); setView("drilldown"); }}
                                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 text-left transition-colors"
                              >
                                <p className="text-sm text-gray-700">{m.fullName}</p>
                                <div className="flex items-center gap-2">
                                  <span className={`text-sm font-semibold ${ps.pct != null ? getPctColor(ps.pct) : "text-gray-400"}`}>
                                    {ps.pct != null ? `${ps.pct}%` : "N/A"}
                                  </span>
                                  <span className="text-gray-300 text-xs">&rsaquo;</span>
                                </div>
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </>
          )}
        </div>
      )}

      {/* ── BY MEMBER ────────────────────────────────────────────────────────── */}
      {view === "person" && (
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Member Attendance (lowest first)
            </p>
            <select
              value={regionFilter}
              onChange={e => setRegionFilter(e.target.value)}
              className="text-xs border rounded p-1 text-gray-600 focus:outline-blue-500"
            >
              <option value="all">All cell groups</option>
              {cellRegions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          {servicesInPeriod.length === 0 ? (
            <p className="p-8 text-center text-sm text-gray-400">No attendance data for this period.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {members
                .filter(m => regionFilter === "all" || m.cellRegion === regionFilter)
                .map(m => ({ m, ps: personStats(m.id) }))
                .sort((a, b) => (a.ps.pct ?? 0) - (b.ps.pct ?? 0))
                .map(({ m, ps }) => (
                  <button
                    key={m.id}
                    onClick={() => { setDrilldownMemberId(m.id); setView("drilldown"); }}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left transition-colors"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">{m.fullName}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {m.cellRegion && (
                          <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{m.cellRegion}</span>
                        )}
                        <span className="text-xs text-gray-400">{ps.present}/{ps.total} services</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-bold ${ps.pct != null ? getPctColor(ps.pct) : "text-gray-400"}`}>
                        {ps.pct != null ? `${ps.pct}%` : "N/A"}
                      </span>
                      <span className="text-gray-300 text-xs">&rsaquo;</span>
                    </div>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {/* ── FALLING OFF ──────────────────────────────────────────────────────── */}
      {view === "dropoff" && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-gray-400">
            Flagged when a member misses 3 consecutive services without reporting, or 5 consecutive services regardless.
            Based on the {Math.min(servicesInPeriod.length, 5)} most recent services in this period.
          </p>

          {servicesInPeriod.length < 3 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              At least 3 services are needed to detect patterns. Widen your period or select All sessions.
            </p>
          ) : fallingOff.length === 0 ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6 text-center">
              <p className="text-emerald-700 font-semibold text-sm">No one is falling off right now.</p>
            </div>
          ) : (
            <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
              <div className="divide-y divide-gray-100">
                {fallingOff.map(({ member, reason, dots }) => (
                  <div key={member.id} className="px-4 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <button
                          onClick={() => { setDrilldownMemberId(member.id); setView("drilldown"); }}
                          className="text-sm font-semibold text-gray-800 hover:text-blue-600 transition-colors text-left"
                        >
                          {member.fullName}
                        </button>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {member.cellRegion && <>{member.cellRegion} &middot; </>}{reason}
                        </p>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        {dots.map((dot, i) => (
                          <span
                            key={i}
                            title={dot}
                            className={`w-3 h-3 rounded-full ${
                              dot === "present" ? "bg-emerald-400"
                              : dot === "reported" ? "bg-amber-300"
                              : "bg-red-400"
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-gray-400">
            Dots: <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 align-middle mx-1" />Present
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-300 align-middle mx-1" />Absent (reported)
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-400 align-middle mx-1" />Absent
          </p>
        </div>
      )}

    </div>
  );
}
