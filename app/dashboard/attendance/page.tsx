"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { db } from "../../../lib/firebase";
import DateInput from "../../../components/ui/DateInput";
import { useAppUser } from "../../../lib/useAppUser";
import ExportMemberButton from "../../components/ExportMemberButton";
import InfoTooltip from "../../components/InfoTooltip";
import { formatSurnameFirst, compareBySurname } from "../../../lib/nameFormat";
import {
  collection,
  query,
  where,
  getDocs,
  setDoc,
  doc,
  getDoc,
  serverTimestamp,
} from "firebase/firestore";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  role: string;
  branch?: string;
  cellRegion?: string;
  ministryGroup?: string;
  absenceException?: { tag: string } | null;
  createdAt?: { toDate: () => Date } | null; // Firestore Timestamp
  householdId?: string;
  householdRole?: string;
  status?: string;
}

interface AttendanceRecord {
  status: "present" | "absent";
  reported?: boolean | null;
  absenceReason?: string | null;
}

interface ServiceSession {
  id: string;    // stored in tenants.serviceSessions
  day: string;   // "Sunday", "Monday", etc.
  name: string;  // "Celebration Service", "Midweek Prayer", etc.
}

// Day-of-week index for each day name
const DAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// ─── Component ─────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const { appUser, loading: userLoading } = useAppUser();

  const [members, setMembers] = useState<Member[]>([]);
  const [attendanceCache, setAttendanceCache] = useState<Record<string, AttendanceRecord>>({});
  const [loading, setLoading] = useState(true);

  // Church-configured service sessions
  const [sessions, setSessions] = useState<ServiceSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // Service state
  const [selectedDate, setSelectedDate] = useState("");
  const [activeSession, setActiveSession] = useState<ServiceSession | null>(null);
  const [dateError, setDateError] = useState("");

  // Attendance filter state
  const [filterType, setFilterType] = useState<"all" | "branch" | "cellRegion" | "ministryGroup">("all");
  const [filterValue, setFilterValue] = useState("");
  const [configBranches, setConfigBranches] = useState<string[]>([]);
  const [configCellRegions, setConfigCellRegions] = useState<string[]>([]);
  const [configMinistryGroups, setConfigMinistryGroups] = useState<string[]>([]);

  // Tracking start date lock
  const [trackingStartDate, setTrackingStartDate] = useState("");

  // QR modal state
  const [showQR, setShowQR] = useState(false);

  // Absence modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<Member | null>(null);
  const [isReported, setIsReported] = useState<boolean | null>(null);
  const [absenceReason, setAbsenceReason] = useState("");
  const [modalLoading, setModalLoading] = useState(false);

  // Family check-in state
  const [familyPanelOpen, setFamilyPanelOpen] = useState(false);
  const [familyCheckSearch, setFamilyCheckSearch] = useState("");
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null);
  const [checkedFamilyIds, setCheckedFamilyIds] = useState<Set<string>>(new Set());
  const [familyCheckingIn, setFamilyCheckingIn] = useState(false);
  const [pendingFamilyParam, setPendingFamilyParam] = useState<string | null>(null);

  // Pick up a ?family=<householdId> link (e.g. from the roster's Family view
  // modal) so the panel opens straight to that family once members load.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const param = new URLSearchParams(window.location.search).get("family");
    if (param) setPendingFamilyParam(param);
  }, []);

  // ─── Load tenant service sessions ──────────────────────────────────────────

  useEffect(() => {
    if (userLoading || !appUser) return;

    const loadSessions = async () => {
      try {
        const tenantSnap = await getDoc(doc(db, "tenants", appUser.tenantId));
        const td = tenantSnap.data() || {};
        const loaded: ServiceSession[] = td.serviceSessions || [];
        setSessions(loaded);
        setTrackingStartDate(td.trackingStartDate || "");
        setConfigBranches(td.branches || []);
        setConfigCellRegions(td.cellRegions || []);
        setConfigMinistryGroups(td.ministryGroups || []);

        // Set default date: today if it matches a session day, else nearest upcoming match
        const today = new Date();
        const todayDay = today.getDay();
        const matchToday = loaded.find(s => DAY_INDEX[s.day] === todayDay);

        if (matchToday) {
          const iso = toISO(today);
          setSelectedDate(iso);
          setActiveSession(matchToday);
        } else if (loaded.length > 0) {
          // Find nearest future service day
          let nearest: Date | null = null;
          let nearestSession: ServiceSession | null = null;
          for (const s of loaded) {
            const target = nextOccurrence(today, DAY_INDEX[s.day]);
            if (!nearest || target < nearest) { nearest = target; nearestSession = s; }
          }
          if (nearest && nearestSession) {
            setSelectedDate(toISO(nearest));
            setActiveSession(nearestSession);
          }
        }
      } catch (e) {
        console.error("Failed to load sessions:", e);
      } finally {
        setSessionsLoading(false);
      }
    };

    loadSessions();
  }, [appUser, userLoading]);

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function toISO(d: Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function nextOccurrence(from: Date, targetDay: number): Date {
    const d = new Date(from);
    const diff = (targetDay - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  function getSessionForDate(dateStr: string): ServiceSession | null {
    if (!dateStr) return null;
    const d = new Date(dateStr + "T00:00:00");
    const dayOfWeek = d.getDay();
    return sessions.find(s => DAY_INDEX[s.day] === dayOfWeek) || null;
  }

  const formatDisplayDate = (dateString: string) => {
    if (!dateString) return "";
    const date = new Date(dateString + "T00:00:00");
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  };

  // ─── Handle date change ─────────────────────────────────────────────────────

  const handleDateChange = (newDate: string) => {
    // Block dates before the church's tracking start date
    if (trackingStartDate && newDate < trackingStartDate) {
      const formatted = new Date(trackingStartDate + "T00:00:00").toLocaleDateString("en-GB", {
        day: "numeric", month: "long", year: "numeric",
      });
      setDateError(`This date is before your church's tracking start date. Please select a date from ${formatted} onwards.`);
      setSelectedDate(newDate);
      setActiveSession(null);
      return;
    }

    const match = getSessionForDate(newDate);

    if (!match) {
      const dayNames = sessions.map(s => s.day + "s").join(", ");
      setDateError(`This date is not a service day. Your services run on: ${dayNames || "no sessions configured"}.`);
      setSelectedDate(newDate);
      setActiveSession(null);
      return;
    }

    setDateError("");
    setSelectedDate(newDate);
    setActiveSession(match);
  };

  // ─── Load members + attendance when session/date changes ───────────────────

  useEffect(() => {
    if (userLoading || !appUser || !selectedDate || !activeSession) return;

    const loadData = async () => {
      setLoading(true);
      const tenantId = appUser.tenantId;
      const serviceId = `${selectedDate}_${activeSession.id}`;

      try {
        // Cell leaders only see their assigned cell group; branch admins only
        // see their assigned branch.
        const isCellLeader = appUser.role === "cell_leader";
        const isBranchAdmin = appUser.role === "branch_admin";
        const qMembers = isCellLeader && appUser.assignedCellRegion
          ? query(collection(db, "members"), where("tenantId", "==", tenantId), where("cellRegion", "==", appUser.assignedCellRegion))
          : isBranchAdmin && appUser.assignedBranch
          ? query(collection(db, "members"), where("tenantId", "==", tenantId), where("branch", "==", appUser.assignedBranch))
          : query(collection(db, "members"), where("tenantId", "==", tenantId));
        const membersSnap = await getDocs(qMembers);
        const memberList: Member[] = [];
        membersSnap.forEach((d) => memberList.push({ id: d.id, ...d.data() } as Member));
        memberList.sort(compareBySurname);
        setMembers(memberList);

        const qAttendance = query(
          collection(db, "attendance"),
          where("serviceId", "==", serviceId),
          where("tenantId", "==", tenantId)
        );
        const attendanceSnap = await getDocs(qAttendance);
        const cache: Record<string, AttendanceRecord> = {};
        attendanceSnap.forEach((d) => {
          const data = d.data();
          cache[data.personId] = {
            status: data.status,
            reported: data.reported,
            absenceReason: data.absenceReason,
          };
        });
        setAttendanceCache(cache);
      } catch (error) {
        console.error("Error loading attendance data:", error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [appUser, userLoading, selectedDate, activeSession]);

  // ─── Mark present ───────────────────────────────────────────────────────────

  const markPresent = async (personId: string) => {
    if (!appUser || !activeSession) return;
    const serviceId = `${selectedDate}_${activeSession.id}`;
    const attendanceId = `${personId}_${serviceId}`;

    setAttendanceCache((prev) => ({ ...prev, [personId]: { status: "present" } }));

    try {
      await setDoc(
        doc(db, "attendance", attendanceId),
        {
          tenantId: appUser.tenantId,
          personId,
          serviceId,
          serviceDate: selectedDate,
          serviceType: activeSession.id,
          sessionName: activeSession.name,
          sessionDay: activeSession.day,
          status: "present",
          reported: null,
          absenceReason: null,
          markedBy: appUser.email,
          markedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      console.error("Error marking present:", error);
      alert("Failed to save. Please try again.");
    }
  };

  // ─── Absence modal ──────────────────────────────────────────────────────────

  const openAbsentModal = (person: Member) => {
    setSelectedPerson(person);
    setIsReported(null);
    setAbsenceReason("");
    setIsModalOpen(true);
  };

  const submitAbsent = async () => {
    if (!appUser || !selectedPerson || !activeSession) return;
    setModalLoading(true);
    const serviceId = `${selectedDate}_${activeSession.id}`;
    const attendanceId = `${selectedPerson.id}_${serviceId}`;

    setAttendanceCache((prev) => ({
      ...prev,
      [selectedPerson.id]: {
        status: "absent",
        reported: isReported,
        absenceReason: isReported ? absenceReason : null,
      },
    }));

    try {
      await setDoc(
        doc(db, "attendance", attendanceId),
        {
          tenantId: appUser.tenantId,
          personId: selectedPerson.id,
          serviceId,
          serviceDate: selectedDate,
          serviceType: activeSession.id,
          sessionName: activeSession.name,
          sessionDay: activeSession.day,
          status: "absent",
          reported: isReported,
          absenceReason: isReported ? absenceReason.trim() : null,
          markedBy: appUser.email,
          markedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setIsModalOpen(false);
    } catch (error) {
      console.error("Error marking absent:", error);
      alert("Failed to save absence data.");
    } finally {
      setModalLoading(false);
    }
  };

  // ─── Filter helpers ────────────────────────────────────────────────────────

  // A member should not be counted on Sundays that happened before they were
  // captured, otherwise the historical numbers get inflated. Rule: the earliest
  // service a member may be marked for is the Sunday immediately on/before the
  // day they were captured (that is "1 Sunday back"). Anything earlier hides them.
  const earliestEligibleDate = (m: Member): string | null => {
    if (!m.createdAt || typeof m.createdAt.toDate !== "function") return null; // legacy members: always eligible
    const captured = m.createdAt.toDate();
    // Walk back to the most recent Sunday on/before the capture date.
    const sunday = new Date(captured);
    sunday.setHours(0, 0, 0, 0);
    sunday.setDate(sunday.getDate() - sunday.getDay()); // getDay() 0 = Sunday
    // Format as YYYY-MM-DD to compare against selectedDate strings.
    const y = sunday.getFullYear();
    const mo = String(sunday.getMonth() + 1).padStart(2, "0");
    const d = String(sunday.getDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  };

  // Suspended members are hidden from attendance entirely — they don't affect
  // present/absent counts, or any of the filter chip counts, while suspended.
  // Also hide members from services that pre-date their capture.
  const eligibleMembers = members.filter(m => {
    if (m.status === "suspended") return false;
    const eligibleFrom = earliestEligibleDate(m);
    if (eligibleFrom && selectedDate && selectedDate < eligibleFrom) return false;
    return true;
  });

  const filteredMembers = eligibleMembers.filter(m => {
    if (filterType === "branch") return m.branch === filterValue;
    if (filterType === "cellRegion") return m.cellRegion === filterValue;
    if (filterType === "ministryGroup") return m.ministryGroup === filterValue;
    return true;
  });

  // ─── Family grouping (for Family Check-in) ──────────────────────────────────

  const familyGroups = (() => {
    const map = new Map<string, Member[]>();
    filteredMembers.forEach(m => {
      if (!m.householdId) return;
      if (!map.has(m.householdId)) map.set(m.householdId, []);
      map.get(m.householdId)!.push(m);
    });
    return Array.from(map.entries())
      .filter(([, mems]) => mems.length > 1)
      .map(([householdId, mems]) => {
        const primaryMem = mems.find(m => m.householdRole === "primary") || mems[0];
        const label = primaryMem.lastName || (primaryMem.fullName || "").trim().split(/\s+/).slice(-1)[0] || "Family";
        return { householdId, label, members: mems };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  })();

  const filteredFamilyGroups = familyGroups.filter(g =>
    g.label.toLowerCase().includes(familyCheckSearch.trim().toLowerCase())
  );

  const selectedFamily = familyGroups.find(g => g.householdId === selectedFamilyId) || null;

  const selectFamily = (householdId: string) => {
    setSelectedFamilyId(householdId);
    const grp = familyGroups.find(g => g.householdId === householdId);
    setCheckedFamilyIds(new Set(grp ? grp.members.map(m => m.id) : []));
  };

  const toggleFamilyMember = (id: string) => {
    setCheckedFamilyIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const checkInFamily = async () => {
    if (checkedFamilyIds.size === 0) return;
    setFamilyCheckingIn(true);
    try {
      await Promise.all(Array.from(checkedFamilyIds).map(id => markPresent(id)));
      setFamilyPanelOpen(false);
      setSelectedFamilyId(null);
      setCheckedFamilyIds(new Set());
      setFamilyCheckSearch("");
    } finally {
      setFamilyCheckingIn(false);
    }
  };

  // Auto-open the panel once for a family passed in via ?family=<id>.
  useEffect(() => {
    if (!pendingFamilyParam || familyGroups.length === 0) return;
    const match = familyGroups.find(g => g.householdId === pendingFamilyParam);
    if (match) {
      setFamilyPanelOpen(true);
      selectFamily(match.householdId);
    }
    setPendingFamilyParam(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFamilyParam, familyGroups.length]);

  // ─── Stats ─────────────────────────────────────────────────────────────────

  const presentCount = filteredMembers.filter(m => attendanceCache[m.id]?.status === "present").length;
  const absentCount = filteredMembers.filter(m => attendanceCache[m.id]?.status === "absent").length;
  const pendingCount = filteredMembers.length - presentCount - absentCount;

  // ─── Export rows for selected day (sorted: present → absent w/ reason → absent no reason → pending) ──

  const attendanceExportRows = (() => {
    const toRow = (m: Member) => {
      const rec = attendanceCache[m.id];
      let status = "Pending";
      let absenceReported = "-";
      let absenceReason = "-";
      if (rec?.status === "present") { status = "Present"; }
      if (rec?.status === "absent") {
        status = "Absent";
        absenceReported = rec.reported ? "Yes" : "No";
        absenceReason = rec.absenceReason || "-";
      }
      const parts = (m.fullName || "").trim().split(/\s+/);
      return {
        firstName: m.firstName || parts[0] || "",
        lastName: m.lastName || parts.slice(1).join(" ") || "",
        role: m.role || "-",
        branch: m.branch || "-",
        cellRegion: m.cellRegion || "-",
        ministryGroup: m.ministryGroup || "-",
        status,
        absenceReported,
        absenceReason,
      };
    };

    const present = filteredMembers.filter(m => attendanceCache[m.id]?.status === "present");
    const absentReported = filteredMembers.filter(m => attendanceCache[m.id]?.status === "absent" && attendanceCache[m.id]?.reported === true);
    const absentNoReason = filteredMembers.filter(m => attendanceCache[m.id]?.status === "absent" && !attendanceCache[m.id]?.reported);
    const pending = filteredMembers.filter(m => !attendanceCache[m.id]);

    return [...present, ...absentReported, ...absentNoReason, ...pending].map(toRow);
  })();

  const attendanceExportColumns = [
    { key: "firstName" as const, label: "First Name" },
    { key: "lastName" as const, label: "Last Name" },
    { key: "role" as const, label: "Role" },
    { key: "branch" as const, label: "Branch" },
    { key: "cellRegion" as const, label: "Cell Group" },
    { key: "ministryGroup" as const, label: "Ministry Group" },
    { key: "status" as const, label: "Status" },
    { key: "absenceReported" as const, label: "Absence Reported" },
    { key: "absenceReason" as const, label: "Absence Reason" },
  ];

  // ─── No sessions configured ────────────────────────────────────────────────

  if (!sessionsLoading && sessions.length === 0) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <div className="text-4xl mb-4">📅</div>
        <h2 className="text-xl font-bold text-gray-800 mb-2">No service sessions configured</h2>
        <p className="text-sm text-gray-500 mb-6">
          An owner or admin needs to set up your church's service schedule before attendance can be recorded.
        </p>
        <a
          href="/dashboard/profile"
          className="inline-block px-6 py-2.5 bg-blue-600 text-white font-bold text-sm rounded-lg hover:bg-blue-700 transition"
        >
          Go to Profile to Set Up Services
        </a>
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl p-10 mx-auto flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-800">Attendance Capture</h1>
        <p className="text-gray-500 text-sm mt-1">
          Log congregation presence and monitor absenteeism
        </p>
      </div>

      {/* Service Selector */}
      <div className="bg-white border rounded-lg p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex flex-col gap-1 w-full sm:w-1/3">
          <label className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Service Date
            <InfoTooltip text="The day whose attendance you are capturing or reviewing." why="Attendance is stored per service, so pick the right date first. If there is no session set up for that day you will not be able to mark anyone." />
          </label>
          <DateInput
            value={selectedDate}
            onChange={handleDateChange}
            className="border p-2 rounded text-sm text-gray-700 focus:outline-blue-500"
          />
          {dateError && <p className="text-xs text-red-500 mt-1">{dateError}</p>}
        </div>

        {activeSession && !dateError && (
          <div className="flex items-center gap-3 bg-blue-50 px-4 py-3 rounded-lg border border-blue-100">
            <span className="w-3 h-3 rounded-full bg-blue-600"></span>
            <div className="flex-1">
              <p className="text-sm font-bold text-blue-900">{activeSession.name}</p>
              <p className="text-xs text-blue-700">{formatDisplayDate(selectedDate)}</p>
            </div>
            <button
              onClick={() => setShowQR(true)}
              className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 bg-white border border-blue-200 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors"
            >
              <span>&#x2317;</span> QR Check-in
            </button>
          </div>
        )}
      </div>

      {userLoading || loading || sessionsLoading ? (
        <div className="flex items-center gap-2">
          <div className="spinner !border-blue-600 !border-t-transparent"></div>
          <p className="text-gray-600">Loading roster...</p>
        </div>
      ) : !activeSession ? null : (
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          {/* Filter Bar */}
          <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
            {appUser?.role === "cell_leader" ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Showing:</span>
                <span className="text-xs px-3 py-1 rounded-full font-semibold bg-teal-100 text-teal-700 border border-teal-300">
                  {appUser.assignedCellRegion || "Your Cell"}
                </span>
                <span className="text-xs text-gray-400">(restricted to your assigned cell)</span>
              </div>
            ) : (
              <>
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Filter by:</span>

                <button
                  onClick={() => { setFilterType("all"); setFilterValue(""); }}
                  className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${filterType === "all" ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-gray-500 border-gray-200 hover:bg-gray-100"}`}
                >
                  All ({eligibleMembers.length})
                </button>

                {configBranches.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-xs text-gray-400 font-medium">Branch:</span>
                    {configBranches.map(b => (
                      <button key={b} onClick={() => { setFilterType("branch"); setFilterValue(b); }}
                        className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${filterType === "branch" && filterValue === b ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-gray-500 border-gray-200 hover:bg-gray-100"}`}>
                        {b}
                      </button>
                    ))}
                  </div>
                )}

                {configCellRegions.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-xs text-gray-400 font-medium">Cell Group:</span>
                    {configCellRegions.map(r => (
                      <button key={r} onClick={() => { setFilterType("cellRegion"); setFilterValue(r); }}
                        className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${filterType === "cellRegion" && filterValue === r ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-gray-500 border-gray-200 hover:bg-gray-100"}`}>
                        {r}
                      </button>
                    ))}
                  </div>
                )}

                {configMinistryGroups.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-xs text-gray-400 font-medium">Group:</span>
                    {configMinistryGroups.map(g => (
                      <button key={g} onClick={() => { setFilterType("ministryGroup"); setFilterValue(g); }}
                        className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${filterType === "ministryGroup" && filterValue === g ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-gray-500 border-gray-200 hover:bg-gray-100"}`}>
                        {g}
                      </button>
                    ))}
                  </div>
                )}

                {configBranches.length === 0 && configCellRegions.length === 0 && configMinistryGroups.length === 0 && (
                  <span className="text-xs text-gray-400 italic">Add Branches, Cell Groups and Ministry Groups in Configure Lists to enable filtering.</span>
                )}
              </>
            )}
          </div>

          {/* Stats Header */}
          <div className="bg-gray-50 p-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="flex gap-6">
              <div className="flex items-center gap-2">
                <span className="font-bold text-green-600">{presentCount}</span>
                <span className="text-gray-500">Present</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-red-600">{absentCount}</span>
                <span className="text-gray-500">Absent</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-gray-800">{pendingCount}</span>
                <span className="text-gray-500">Pending</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {familyGroups.length > 0 && (
                <button
                  onClick={() => setFamilyPanelOpen(true)}
                  className="text-xs font-semibold text-teal-700 bg-teal-50 border border-teal-200 px-3 py-1.5 rounded-lg hover:bg-teal-100 transition-colors flex items-center gap-1.5"
                >
                  🏠 Family Check-in
                </button>
              )}
              <ExportMemberButton
                data={attendanceExportRows}
                filename={`Attendance_${activeSession?.name.replace(/\s+/g, "_") ?? "Service"}_${selectedDate}`}
                columns={attendanceExportColumns}
                disabled={filteredMembers.length === 0}
              />
            </div>
          </div>

          {/* Roster List */}
          <div className="divide-y divide-gray-100">
            {filteredMembers.length === 0 ? (
              <p className="p-8 text-center text-gray-400 text-sm">
                No members found for this filter.
              </p>
            ) : (
              filteredMembers.map((person) => {
                const record = attendanceCache[person.id];
                const isPresent = record?.status === "present";
                const isAbsent = record?.status === "absent";

                return (
                  <div
                    key={person.id}
                    className={`flex flex-col sm:flex-row sm:items-center sm:justify-between p-4 transition-colors gap-3 sm:gap-0 ${
                      isPresent ? "bg-green-50/30" : isAbsent ? "bg-red-50/30" : "hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{formatSurnameFirst(person)}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-xs text-gray-500">{person.role}</span>
                        {person.cellRegion && (
                          <span className="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-500">
                            {person.cellRegion}
                          </span>
                        )}
                        {person.ministryGroup && (
                          <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded border border-blue-100">
                            {person.ministryGroup}
                          </span>
                        )}
                        {person.absenceException?.tag && (
                          <span className="text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-200 px-2 py-0.5 rounded-full">
                            Exception: {person.absenceException.tag}
                          </span>
                        )}
                        {isAbsent && record.absenceReason && (
                          <span className="text-xs text-red-500 italic flex items-center gap-1">
                            <span className="w-1 h-1 rounded-full bg-red-500"></span>
                            {record.absenceReason}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex gap-2 w-full sm:w-auto">
                      <button
                        onClick={() => markPresent(person.id)}
                        className={`flex-1 sm:flex-none px-4 py-1.5 rounded text-sm font-medium transition-colors border ${
                          isPresent
                            ? "bg-green-100 text-green-800 border-green-200"
                            : "bg-white text-gray-600 border-gray-200 hover:border-green-500 hover:text-green-600"
                        }`}
                      >
                        Present
                      </button>
                      <button
                        onClick={() => openAbsentModal(person)}
                        className={`flex-1 sm:flex-none px-4 py-1.5 rounded text-sm font-medium transition-colors border ${
                          isAbsent
                            ? "bg-red-100 text-red-800 border-red-200"
                            : "bg-white text-gray-600 border-gray-200 hover:border-red-500 hover:text-red-600"
                        }`}
                      >
                        Absent
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* QR Check-in Modal */}
      {showQR && activeSession && appUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 flex flex-col gap-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-800">QR Code Check-in</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  {activeSession.name} &bull; {formatDisplayDate(selectedDate)}
                </p>
              </div>
              <button onClick={() => setShowQR(false)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
            </div>

            {/* QR Code image via qrserver.com — no package needed */}
            {(() => {
              const checkInUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/checkin/${appUser.tenantId}/${selectedDate}_${activeSession.id}`;
              const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(checkInUrl)}`;
              return (
                <>
                  <div className="flex justify-center">
                    <Image src={qrSrc} alt="Check-in QR Code" width={220} height={220} className="rounded-lg border p-2 bg-white" unoptimized />
                  </div>
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Check-in link</p>
                    <p className="text-xs text-gray-600 break-all bg-gray-50 border rounded p-2 select-all">{checkInUrl}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { navigator.clipboard.writeText(checkInUrl); }}
                      className="flex-1 text-sm font-medium py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      Copy Link
                    </button>
                    <a
                      href={qrSrc}
                      download={`checkin-qr-${selectedDate}.png`}
                      className="flex-1 text-sm font-medium py-2 rounded-lg bg-blue-600 text-white text-center hover:bg-blue-700 transition-colors"
                    >
                      Download QR
                    </a>
                  </div>
                  <p className="text-xs text-gray-400 text-center">
                    Members scan this with their phone camera to check themselves in.
                  </p>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Absence Details Modal */}
      {isModalOpen && selectedPerson && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 flex flex-col gap-5">
            <div>
              <h3 className="text-lg font-bold text-gray-800">Mark Absent</h3>
              <p className="text-gray-500 text-sm mt-1">
                Did <strong>{selectedPerson.fullName}</strong> report this absence to leadership beforehand?
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setIsReported(true)}
                className={`flex-1 py-2 rounded border font-medium text-sm transition-colors ${
                  isReported === true
                    ? "bg-blue-50 border-blue-600 text-blue-700"
                    : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                Yes, reported
              </button>
              <button
                onClick={() => setIsReported(false)}
                className={`flex-1 py-2 rounded border font-medium text-sm transition-colors ${
                  isReported === false
                    ? "bg-blue-50 border-blue-600 text-blue-700"
                    : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                No, not reported
              </button>
            </div>

            {isReported === true && (
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Reason
                  <InfoTooltip text="Why this member was away, when the absence was reported beforehand." why="Tracking reasons helps you tell a genuine heads-up apart from someone quietly drifting away, so your care team knows who actually needs a check-in." />
                </label>
                <input
                  type="text"
                  value={absenceReason}
                  onChange={(e) => setAbsenceReason(e.target.value)}
                  placeholder="e.g. Traveling, ill, working..."
                  className="border p-2 rounded text-sm text-gray-700 focus:outline-blue-500"
                  autoFocus
                />
              </div>
            )}

            <div className="flex justify-end gap-3 mt-2">
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-gray-500 hover:text-gray-700 font-medium py-2 px-4 rounded text-sm"
              >
                Cancel
              </button>
              <button
                onClick={submitAbsent}
                disabled={
                  isReported === null ||
                  (isReported === true && !absenceReason.trim()) ||
                  modalLoading
                }
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white font-medium py-2 px-5 rounded transition-colors text-sm flex items-center gap-2"
              >
                {modalLoading ? "Saving..." : "Save Record"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Family Check-in Modal */}
      {familyPanelOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-800">Family Check-in</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  {selectedFamily ? "Untick anyone from this family who isn't here today." : "Find a family, then check in everyone who's here in one go."}
                </p>
              </div>
              <button
                onClick={() => { setFamilyPanelOpen(false); setSelectedFamilyId(null); setFamilyCheckSearch(""); }}
                className="text-gray-400 hover:text-gray-600 text-2xl leading-none shrink-0"
              >
                &times;
              </button>
            </div>

            {!selectedFamily ? (
              <>
                <input
                  value={familyCheckSearch}
                  onChange={e => setFamilyCheckSearch(e.target.value)}
                  placeholder="Search by family surname..."
                  className="border p-2 rounded text-sm text-gray-700 focus:outline-blue-500"
                  autoFocus
                />
                <div className="border rounded-lg max-h-64 overflow-y-auto divide-y divide-gray-50">
                  {filteredFamilyGroups.length === 0 ? (
                    <p className="p-4 text-sm text-gray-400 italic">No matching families found.</p>
                  ) : filteredFamilyGroups.map(g => (
                    <button
                      key={g.householdId}
                      onClick={() => selectFamily(g.householdId)}
                      className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-teal-50 transition-colors flex items-center justify-between"
                    >
                      <span className="font-medium">{g.label} Family</span>
                      <span className="text-xs text-gray-400">{g.members.length} members</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col divide-y divide-gray-50 border rounded-lg">
                  {selectedFamily.members.map(m => (
                    <label key={m.id} className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={checkedFamilyIds.has(m.id)}
                        onChange={() => toggleFamilyMember(m.id)}
                        className="h-4 w-4 rounded text-teal-600 border-gray-300"
                      />
                      <span className="text-sm text-gray-700 flex-1">{formatSurnameFirst(m)}</span>
                      {attendanceCache[m.id]?.status === "present" && (
                        <span className="text-[10px] bg-green-50 text-green-700 border border-green-200 px-1.5 py-0.5 rounded">Already in</span>
                      )}
                    </label>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={checkInFamily}
                    disabled={familyCheckingIn || checkedFamilyIds.size === 0}
                    className="flex-1 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-300 text-white font-bold py-2.5 rounded-lg transition-colors text-sm"
                  >
                    {familyCheckingIn ? "Checking in..." : `Check In Selected (${checkedFamilyIds.size})`}
                  </button>
                  <button
                    onClick={() => setSelectedFamilyId(null)}
                    className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Back
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
