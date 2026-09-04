"use client";

import { useEffect, useMemo, useState } from "react";
import { db } from "../../../lib/firebase";
import { useAppUser } from "../../../lib/useAppUser";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";

// ────────────────────────────────────────────────────────────────────────────
// CLASS TRACKING
//
// Tracks each member through two church classes: the Membership Class and the
// Discipleship Class. Each is Not Started / In Progress / Completed with a
// completion date. Staff update inline from the list or in bulk for many
// members at once. This is separate from `membershipType` (the kind of
// membership a person is seeking), which it must never be confused with.
// ────────────────────────────────────────────────────────────────────────────

type ClassStatus = "not_started" | "in_progress" | "completed";
type ClassKey = "membership" | "discipleship";

const STATUS_OPTIONS: { value: ClassStatus; label: string }[] = [
  { value: "not_started", label: "Not Started" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
];

const STATUS_STYLE: Record<ClassStatus, string> = {
  not_started: "bg-gray-100 text-gray-500 border-gray-200",
  in_progress: "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

// Field names on the member doc for each class column.
const FIELDS: Record<ClassKey, { status: string; date: string; label: string }> = {
  membership: { status: "membershipClassStatus", date: "membershipClassDate", label: "Membership Class" },
  discipleship: { status: "discipleshipClassStatus", date: "discipleshipClassDate", label: "Discipleship Class" },
};

interface MemberRow {
  id: string;
  name: string;
  cellRegion: string;
  membershipClassStatus: ClassStatus;
  membershipClassDate: string;
  discipleshipClassStatus: ClassStatus;
  discipleshipClassDate: string;
}

const todayStr = () => new Date().toISOString().split("T")[0];

function asStatus(v: unknown): ClassStatus {
  return v === "in_progress" || v === "completed" ? v : "not_started";
}

export default function ClassesPage() {
  const { appUser, tenantId, loading: userLoading } = useAppUser();
  const canEdit = ["owner", "admin", "member_manager", "branch_admin"].includes(appUser?.role || "");

  const [rows, setRows] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [membershipFilter, setMembershipFilter] = useState<ClassStatus | "all">("all");
  const [discipleshipFilter, setDiscipleshipFilter] = useState<ClassStatus | "all">("all");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkColumn, setBulkColumn] = useState<ClassKey>("membership");
  const [bulkStatus, setBulkStatus] = useState<ClassStatus>("completed");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!tenantId) return;
    setLoading(true);
    getDocs(query(collection(db, "members"), where("tenantId", "==", tenantId)))
      .then((snap) => {
        const list: MemberRow[] = snap.docs
          .map((d) => {
            const data = d.data() as Record<string, unknown>;
            // Leave suspended members out, matching the rest of the active views.
            if (data.status === "suspended") return null;
            const name =
              (data.fullName as string) ||
              `${(data.firstName as string) || ""} ${(data.lastName as string) || ""}`.trim();
            return {
              id: d.id,
              name: name || "(no name)",
              cellRegion: (data.cellRegion as string) || "",
              membershipClassStatus: asStatus(data.membershipClassStatus),
              membershipClassDate: (data.membershipClassDate as string) || "",
              discipleshipClassStatus: asStatus(data.discipleshipClassStatus),
              discipleshipClassDate: (data.discipleshipClassDate as string) || "",
            };
          })
          .filter((m): m is MemberRow => m !== null)
          .sort((a, b) => a.name.localeCompare(b.name));
        setRows(list);
      })
      .catch((err) => console.error("Failed to load members:", err))
      .finally(() => setLoading(false));
  }, [tenantId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.cellRegion.toLowerCase().includes(q)) return false;
      if (membershipFilter !== "all" && r.membershipClassStatus !== membershipFilter) return false;
      if (discipleshipFilter !== "all" && r.discipleshipClassStatus !== discipleshipFilter) return false;
      return true;
    });
  }, [rows, search, membershipFilter, discipleshipFilter]);

  // Progress summary across all (unfiltered) members.
  const summary = useMemo(() => {
    const count = (key: ClassKey, status: ClassStatus) =>
      rows.filter((r) => (key === "membership" ? r.membershipClassStatus : r.discipleshipClassStatus) === status).length;
    return {
      membershipCompleted: count("membership", "completed"),
      discipleshipCompleted: count("discipleship", "completed"),
      total: rows.length,
    };
  }, [rows]);

  // Update one member's class. Completion date follows the status: set to a real
  // date when completed (today unless one is already set), cleared otherwise.
  async function setStatus(row: MemberRow, key: ClassKey, status: ClassStatus) {
    if (!canEdit) return;
    const f = FIELDS[key];
    const existingDate = key === "membership" ? row.membershipClassDate : row.discipleshipClassDate;
    const date = status === "completed" ? existingDate || todayStr() : "";
    // Optimistic local update.
    setRows((prev) =>
      prev.map((r) =>
        r.id === row.id
          ? key === "membership"
            ? { ...r, membershipClassStatus: status, membershipClassDate: date }
            : { ...r, discipleshipClassStatus: status, discipleshipClassDate: date }
          : r
      )
    );
    try {
      await updateDoc(doc(db, "members", row.id), { [f.status]: status, [f.date]: date });
    } catch (err) {
      console.error("Failed to update class status:", err);
    }
  }

  async function setDate(row: MemberRow, key: ClassKey, date: string) {
    if (!canEdit) return;
    const f = FIELDS[key];
    setRows((prev) =>
      prev.map((r) =>
        r.id === row.id
          ? key === "membership"
            ? { ...r, membershipClassDate: date }
            : { ...r, discipleshipClassDate: date }
          : r
      )
    );
    try {
      await updateDoc(doc(db, "members", row.id), { [f.date]: date });
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
      const allShown = filtered.every((r) => prev.has(r.id)) && filtered.length > 0;
      if (allShown) return new Set();
      return new Set(filtered.map((r) => r.id));
    });
  }

  async function applyBulk() {
    if (!canEdit || selected.size === 0) return;
    setApplying(true);
    const f = FIELDS[bulkColumn];
    const date = bulkStatus === "completed" ? todayStr() : "";
    try {
      // Firestore batches cap at 500 writes; chunk to be safe.
      const ids = Array.from(selected);
      for (let i = 0; i < ids.length; i += 400) {
        const batch = writeBatch(db);
        ids.slice(i, i + 400).forEach((id) => {
          batch.update(doc(db, "members", id), { [f.status]: bulkStatus, [f.date]: date });
        });
        await batch.commit();
      }
      setRows((prev) =>
        prev.map((r) =>
          selected.has(r.id)
            ? bulkColumn === "membership"
              ? { ...r, membershipClassStatus: bulkStatus, membershipClassDate: date }
              : { ...r, discipleshipClassStatus: bulkStatus, discipleshipClassDate: date }
            : r
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

  if (userLoading || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const renderCell = (row: MemberRow, key: ClassKey) => {
    const status = key === "membership" ? row.membershipClassStatus : row.discipleshipClassStatus;
    const date = key === "membership" ? row.membershipClassDate : row.discipleshipClassDate;
    return (
      <div className="flex flex-col gap-1">
        {canEdit ? (
          <select
            value={status}
            onChange={(e) => setStatus(row, key, e.target.value as ClassStatus)}
            className={`text-xs font-semibold border rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${STATUS_STYLE[status]}`}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <span className={`inline-flex text-xs font-semibold border rounded-full px-2 py-0.5 ${STATUS_STYLE[status]}`}>
            {STATUS_OPTIONS.find((o) => o.value === status)?.label}
          </span>
        )}
        {status === "completed" &&
          (canEdit ? (
            <input
              type="date"
              value={date}
              max={todayStr()}
              onChange={(e) => setDate(row, key, e.target.value)}
              className="text-xs border border-gray-200 rounded px-1.5 py-0.5 text-gray-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          ) : (
            <span className="text-xs text-gray-400">{date || "—"}</span>
          ))}
      </div>
    );
  };

  const allShownSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Classes</h1>
        <p className="text-sm text-gray-500 mt-1">
          Track members through the Membership and Discipleship classes. This is separate from the type of membership a person is seeking.
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500">Members</p>
          <p className="text-2xl font-bold text-gray-900">{summary.total}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500">Membership Class completed</p>
          <p className="text-2xl font-bold text-emerald-700">{summary.membershipCompleted}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500">Discipleship Class completed</p>
          <p className="text-2xl font-bold text-emerald-700">{summary.discipleshipCompleted}</p>
        </div>
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
          <label className="block text-xs font-medium text-gray-500 mb-1">Membership Class</label>
          <select
            value={membershipFilter}
            onChange={(e) => setMembershipFilter(e.target.value as ClassStatus | "all")}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="all">All statuses</option>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Discipleship Class</label>
          <select
            value={discipleshipFilter}
            onChange={(e) => setDiscipleshipFilter(e.target.value as ClassStatus | "all")}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="all">All statuses</option>
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
            value={bulkColumn}
            onChange={(e) => setBulkColumn(e.target.value as ClassKey)}
            className="border border-emerald-200 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="membership">Membership Class</option>
            <option value="discipleship">Discipleship Class</option>
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
            disabled={applying}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors"
          >
            {applying ? "Applying…" : "Apply"}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-emerald-700 hover:text-emerald-900 font-medium ml-auto"
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
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
                  <th className="text-left px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Membership Class</th>
                  <th className="text-left px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Discipleship Class</th>
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
                    <td className="px-4 py-3">{renderCell(row, "membership")}</td>
                    <td className="px-4 py-3">{renderCell(row, "discipleship")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
