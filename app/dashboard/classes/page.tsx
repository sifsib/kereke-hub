"use client";

import { useEffect, useMemo, useState } from "react";
import { db } from "../../../lib/firebase";
import { useAppUser } from "../../../lib/useAppUser";
import ExportMemberButton from "../../components/ExportMemberButton";
import {
  collection,
  query,
  where,
  getDoc,
  getDocs,
  doc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";

// ────────────────────────────────────────────────────────────────────────────
// CLASS TRACKING
//
// Tracks each member through the classes a church runs (Membership, Discipleship,
// Baptism, and any others the church defines). Each class is Not Started /
// In Progress / Completed with a completion date. Owner/admin manage the list of
// class types; staff update member progress inline or in bulk, filter, and export
// to CSV/Excel. This is separate from `membershipType` (the kind of membership a
// person is seeking), which it must never be confused with.
//
// A church's class types live on the tenant doc (tenant.classTypes), the same
// place cell groups and membership types are stored. Each member keeps a per-type
// status map at member.classes[typeId] = { status, date }. For the two built-in
// defaults we fall back to the original flat fields so nothing captured before
// this change is lost.
// ────────────────────────────────────────────────────────────────────────────

type ClassStatus = "not_started" | "in_progress" | "completed";

interface ClassType {
  id: string;
  name: string;
}

const STATUS_OPTIONS: { value: ClassStatus; label: string }[] = [
  { value: "not_started", label: "Not Started" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
];

const STATUS_LABEL: Record<ClassStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  completed: "Completed",
};

const STATUS_STYLE: Record<ClassStatus, string> = {
  not_started: "bg-gray-100 text-gray-500 border-gray-200",
  in_progress: "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

// The two class types every church starts with. Their ids are stable so the
// legacy flat fields keep resolving even after a church renames them.
const DEFAULT_CLASS_TYPES: ClassType[] = [
  { id: "membership", name: "Membership Class" },
  { id: "discipleship", name: "Discipleship Class" },
];

// Legacy flat fields, only for the two built-in class ids.
const LEGACY_FIELDS: Record<string, { status: string; date: string }> = {
  membership: { status: "membershipClassStatus", date: "membershipClassDate" },
  discipleship: { status: "discipleshipClassStatus", date: "discipleshipClassDate" },
};

interface ClassState {
  status: ClassStatus;
  date: string;
}

interface MemberRow {
  id: string;
  name: string;
  cellRegion: string;
  // Explicit per-type map from member.classes, plus legacy fallbacks kept aside.
  classes: Record<string, ClassState>;
  legacy: Record<string, ClassState>;
}

const todayStr = () => new Date().toISOString().split("T")[0];

function asStatus(v: unknown): ClassStatus {
  return v === "in_progress" || v === "completed" ? v : "not_started";
}

function newTypeId() {
  return `t_${Math.random().toString(36).slice(2, 9)}`;
}

export default function ClassesPage() {
  const { appUser, tenantId, loading: userLoading } = useAppUser();
  const role = appUser?.role || "";
  const canEdit = ["owner", "admin", "member_manager", "branch_admin"].includes(role);
  const canManageTypes = ["owner", "admin"].includes(role);

  const [classTypes, setClassTypes] = useState<ClassType[]>(DEFAULT_CLASS_TYPES);
  const [rows, setRows] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<ClassStatus | "all">("all");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkType, setBulkType] = useState<string>("");
  const [bulkStatus, setBulkStatus] = useState<ClassStatus>("completed");
  const [applying, setApplying] = useState(false);

  // Manage-classes modal (owner/admin)
  const [showManage, setShowManage] = useState(false);
  const [draftTypes, setDraftTypes] = useState<ClassType[]>([]);
  const [savingTypes, setSavingTypes] = useState(false);

  useEffect(() => {
    if (!tenantId) return;
    setLoading(true);
    Promise.all([
      getDoc(doc(db, "tenants", tenantId)),
      getDocs(query(collection(db, "members"), where("tenantId", "==", tenantId))),
    ])
      .then(([tenantSnap, memberSnap]) => {
        const tData = tenantSnap.data() as Record<string, unknown> | undefined;
        const configured = Array.isArray(tData?.classTypes) ? (tData!.classTypes as ClassType[]) : null;
        const types =
          configured && configured.length > 0
            ? configured.filter((t) => t && t.id && t.name)
            : DEFAULT_CLASS_TYPES;
        setClassTypes(types);
        setBulkType((prev) => prev || types[0]?.id || "");

        const list: MemberRow[] = memberSnap.docs
          .map((d) => {
            const data = d.data() as Record<string, unknown>;
            if (data.status === "suspended") return null;
            const name =
              (data.fullName as string) ||
              `${(data.firstName as string) || ""} ${(data.lastName as string) || ""}`.trim();
            const rawClasses = (data.classes as Record<string, { status?: unknown; date?: unknown }>) || {};
            const classes: Record<string, ClassState> = {};
            for (const [k, v] of Object.entries(rawClasses)) {
              classes[k] = { status: asStatus(v?.status), date: (v?.date as string) || "" };
            }
            const legacy: Record<string, ClassState> = {};
            for (const [id, f] of Object.entries(LEGACY_FIELDS)) {
              legacy[id] = { status: asStatus(data[f.status]), date: (data[f.date] as string) || "" };
            }
            return { id: d.id, name: name || "(no name)", cellRegion: (data.cellRegion as string) || "", classes, legacy };
          })
          .filter((m): m is MemberRow => m !== null)
          .sort((a, b) => a.name.localeCompare(b.name));
        setRows(list);
      })
      .catch((err) => console.error("Failed to load classes:", err))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Effective status for a member+type: explicit map wins, then legacy fallback
  // for the two built-ins, else Not Started.
  function stateOf(row: MemberRow, typeId: string): ClassState {
    return row.classes[typeId] || row.legacy[typeId] || { status: "not_started", date: "" };
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.cellRegion.toLowerCase().includes(q)) return false;
      if (filterType !== "all") {
        const s = stateOf(r, filterType).status;
        if (filterStatus !== "all" && s !== filterStatus) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, filterType, filterStatus]);

  const completedCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of classTypes) m[t.id] = rows.filter((r) => stateOf(r, t.id).status === "completed").length;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, classTypes]);

  async function setStatus(row: MemberRow, typeId: string, status: ClassStatus) {
    if (!canEdit) return;
    const existing = stateOf(row, typeId);
    const date = status === "completed" ? existing.date || todayStr() : "";
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, classes: { ...r.classes, [typeId]: { status, date } } } : r))
    );
    try {
      await updateDoc(doc(db, "members", row.id), {
        [`classes.${typeId}.status`]: status,
        [`classes.${typeId}.date`]: date,
      });
    } catch (err) {
      console.error("Failed to update class status:", err);
    }
  }

  async function setDate(row: MemberRow, typeId: string, date: string) {
    if (!canEdit) return;
    const status = stateOf(row, typeId).status;
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, classes: { ...r.classes, [typeId]: { status, date } } } : r))
    );
    try {
      await updateDoc(doc(db, "members", row.id), { [`classes.${typeId}.date`]: date });
    } catch (err) {
      console.error("Failed to update completion date:", err);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const allShown = filtered.length > 0 && filtered.every((r) => prev.has(r.id));
      return allShown ? new Set() : new Set(filtered.map((r) => r.id));
    });
  }

  async function applyBulk() {
    if (!canEdit || selected.size === 0 || !bulkType) return;
    setApplying(true);
    const date = bulkStatus === "completed" ? todayStr() : "";
    try {
      const ids = Array.from(selected);
      for (let i = 0; i < ids.length; i += 400) {
        const batch = writeBatch(db);
        ids.slice(i, i + 400).forEach((id) => {
          batch.update(doc(db, "members", id), {
            [`classes.${bulkType}.status`]: bulkStatus,
            [`classes.${bulkType}.date`]: date,
          });
        });
        await batch.commit();
      }
      setRows((prev) =>
        prev.map((r) =>
          selected.has(r.id) ? { ...r, classes: { ...r.classes, [bulkType]: { status: bulkStatus, date } } } : r
        )
      );
      setSelected(new Set());
    } catch (err) {
      console.error("Bulk update failed:", err);
      alert("Could not apply the update to everyone. Please try again.");
    } finally {
      setApplying(false);
    }
  }

  // ── Manage class types (owner/admin) ──────────────────────────────────────

  function openManage() {
    setDraftTypes(classTypes.map((t) => ({ ...t })));
    setShowManage(true);
  }

  function addDraftType() {
    setDraftTypes((prev) => [...prev, { id: newTypeId(), name: "" }]);
  }

  function updateDraftName(id: string, name: string) {
    setDraftTypes((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  }

  function removeDraftType(id: string) {
    setDraftTypes((prev) => prev.filter((t) => t.id !== id));
  }

  async function saveTypes() {
    if (!tenantId || !canManageTypes) return;
    const cleaned = draftTypes
      .map((t) => ({ id: t.id, name: t.name.trim() }))
      .filter((t) => t.name.length > 0);
    setSavingTypes(true);
    try {
      await updateDoc(doc(db, "tenants", tenantId), { classTypes: cleaned });
      setClassTypes(cleaned);
      if (!cleaned.some((t) => t.id === bulkType)) setBulkType(cleaned[0]?.id || "");
      if (filterType !== "all" && !cleaned.some((t) => t.id === filterType)) setFilterType("all");
      setShowManage(false);
    } catch (err) {
      console.error("Failed to save class types:", err);
      alert("Could not save the class list. Only owners and admins can change it.");
    } finally {
      setSavingTypes(false);
    }
  }

  // ── Export data ───────────────────────────────────────────────────────────

  const exportColumns = useMemo(() => {
    const cols: { key: string; label: string }[] = [
      { key: "name", label: "Member" },
      { key: "cellRegion", label: "Cell Group" },
    ];
    for (const t of classTypes) {
      cols.push({ key: `${t.id}__status`, label: `${t.name} — Status` });
      cols.push({ key: `${t.id}__date`, label: `${t.name} — Completed` });
    }
    return cols;
  }, [classTypes]);

  const exportData = useMemo(() => {
    return filtered.map((r) => {
      const row: Record<string, string> = { name: r.name, cellRegion: r.cellRegion || "" };
      for (const t of classTypes) {
        const s = stateOf(r, t.id);
        row[`${t.id}__status`] = STATUS_LABEL[s.status];
        row[`${t.id}__date`] = s.status === "completed" ? s.date : "";
      }
      return row;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, classTypes]);

  if (userLoading || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const allShownSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  const renderCell = (row: MemberRow, typeId: string) => {
    const { status, date } = stateOf(row, typeId);
    return (
      <div className="flex flex-col gap-1">
        {canEdit ? (
          <select
            value={status}
            onChange={(e) => setStatus(row, typeId, e.target.value as ClassStatus)}
            className={`text-xs font-semibold border rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${STATUS_STYLE[status]}`}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <span className={`inline-flex text-xs font-semibold border rounded-full px-2 py-0.5 ${STATUS_STYLE[status]}`}>
            {STATUS_LABEL[status]}
          </span>
        )}
        {status === "completed" &&
          (canEdit ? (
            <input
              type="date"
              value={date}
              max={todayStr()}
              onChange={(e) => setDate(row, typeId, e.target.value)}
              className="text-xs border border-gray-200 rounded px-1.5 py-0.5 text-gray-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          ) : (
            <span className="text-xs text-gray-400">{date || "—"}</span>
          ))}
      </div>
    );
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Classes</h1>
          <p className="text-sm text-gray-500 mt-1">
            Track members through your church's classes. This is separate from the type of membership a person is seeking.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManageTypes && (
            <button
              onClick={openManage}
              className="text-sm font-semibold text-gray-600 hover:text-gray-900 bg-white border border-gray-200 hover:border-gray-300 px-3 py-2 rounded-lg transition-colors"
            >
              ⚙️ Manage classes
            </button>
          )}
          <ExportMemberButton data={exportData} filename="class-tracking" columns={exportColumns} />
        </div>
      </div>

      {/* Summary */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
          <p className="text-xs text-gray-500">Members</p>
          <p className="text-xl font-bold text-gray-900">{rows.length}</p>
        </div>
        {classTypes.map((t) => (
          <div key={t.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500">{t.name} completed</p>
            <p className="text-xl font-bold text-emerald-700">{completedCounts[t.id] ?? 0}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-3 mb-4">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-500 mb-1">Search</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or cell group..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Class</label>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="all">All classes</option>
            {classTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as ClassStatus | "all")}
            disabled={filterType === "all"}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-gray-50 disabled:text-gray-400"
          >
            <option value="all">Any status</option>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* Bulk toolbar */}
      {canEdit && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-4">
          <span className="text-sm font-semibold text-emerald-800">{selected.size} selected</span>
          <span className="text-sm text-emerald-700">Set</span>
          <select
            value={bulkType}
            onChange={(e) => setBulkType(e.target.value)}
            className="border border-emerald-200 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            {classTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span className="text-sm text-emerald-700">to</span>
          <select
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value as ClassStatus)}
            className="border border-emerald-200 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            onClick={applyBulk}
            disabled={applying || !bulkType}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors"
          >
            {applying ? "Applying…" : "Apply"}
          </button>
          <button onClick={() => setSelected(new Set())} className="text-sm text-emerald-700 hover:text-emerald-900 font-medium ml-auto">
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {classTypes.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-400">
            No classes set up yet.{canManageTypes ? " Use “Manage classes” to add one." : " Ask your church admin to add one."}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-400">
            {rows.length === 0 ? "No members yet." : "No members match your filters."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {canEdit && (
                    <th className="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={allShownSelected}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                        aria-label="Select all"
                      />
                    </th>
                  )}
                  <th className="text-left px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Member</th>
                  <th className="text-left px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Cell Group</th>
                  {classTypes.map((t) => (
                    <th key={t.id} className="text-left px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {t.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                    {canEdit && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          onChange={() => toggleSelect(row.id)}
                          className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                          aria-label={`Select ${row.name}`}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3 font-medium text-gray-900">{row.name}</td>
                    <td className="px-4 py-3 text-gray-500">{row.cellRegion || "—"}</td>
                    {classTypes.map((t) => (
                      <td key={t.id} className="px-4 py-3">{renderCell(row, t.id)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Manage classes modal */}
      {showManage && canManageTypes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 max-h-[85vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Manage classes</h2>
            <p className="text-xs text-gray-500 mb-4">
              Rename a class, or add one your church runs (for example Baptism or Foundations). Removing a class hides its column; any progress already captured stays on the member records.
            </p>
            <div className="space-y-2 mb-4">
              {draftTypes.length === 0 && (
                <p className="text-sm text-gray-400">No classes yet. Add your first below.</p>
              )}
              {draftTypes.map((t) => (
                <div key={t.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={t.name}
                    onChange={(e) => updateDraftName(t.id, e.target.value)}
                    placeholder="Class name"
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <button
                    onClick={() => removeDraftType(t.id)}
                    className="p-1.5 text-red-400 hover:text-red-600"
                    aria-label="Remove class"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={addDraftType}
              className="w-full border-2 border-dashed border-gray-200 hover:border-emerald-400 text-gray-400 hover:text-emerald-600 rounded-lg py-2 text-sm font-medium transition-colors mb-5"
            >
              + Add class
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => setShowManage(false)}
                className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveTypes}
                disabled={savingTypes}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
              >
                {savingTypes ? "Saving…" : "Save classes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
