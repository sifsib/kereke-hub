"use client";

import { useEffect, useState } from "react";
import { db } from "../../../lib/firebase";
import { useAppUser } from "../../../lib/useAppUser";
import { getCareInfo, type CareType } from "../../../lib/careTypes";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";

// ────────────────────────────────────────────────────────────────────────────
// MY CARE FOLLOW-UPS
//
// A team member's own list of pastoral care items assigned to them. They can
// read and work ONLY their own assigned items (never the wider care queue):
// mark one resolved / reopen it, and leave a follow-up note on what they did.
// The Firestore rules enforce this — the query is scoped to careAssigneeUid.
// ────────────────────────────────────────────────────────────────────────────

interface CareItem {
  id: string;
  memberName: string;
  type: CareType;
  date: string;
  notes: string;
  assignedTo: string;
  status: "open" | "closed";
  source?: string;
  assigneeNote?: string;
}

export default function MyCarePage() {
  const { appUser, tenantId, loading: userLoading } = useAppUser();
  const uid = appUser?.uid || "";

  const [items, setItems] = useState<CareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    if (!tenantId || !uid) return;
    setLoading(true);
    setError("");
    try {
      // Two equality filters, no orderBy, so no composite index is needed.
      const snap = await getDocs(
        query(
          collection(db, "care_logs"),
          where("tenantId", "==", tenantId),
          where("careAssigneeUid", "==", uid)
        )
      );
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<CareItem, "id">) }))
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      setItems(list);
    } catch (err) {
      console.error("Failed to load my care follow-ups:", err);
      setError("Could not load your follow-ups right now. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tenantId && uid) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, uid]);

  async function toggleStatus(item: CareItem) {
    const newStatus: "open" | "closed" = item.status === "closed" ? "open" : "closed";
    setBusyId(item.id);
    try {
      await updateDoc(doc(db, "care_logs", item.id), {
        status: newStatus,
        resolvedAt: newStatus === "closed" ? serverTimestamp() : null,
      });
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: newStatus } : i)));
    } catch (err) {
      console.error(err);
      alert("Could not update this item. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function saveNote(item: CareItem) {
    const text = (noteDrafts[item.id] ?? "").trim();
    if (!text) return;
    setBusyId(item.id);
    try {
      await updateDoc(doc(db, "care_logs", item.id), {
        assigneeNote: text,
        assigneeNoteAt: serverTimestamp(),
      });
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, assigneeNote: text } : i)));
      setNoteDrafts((prev) => ({ ...prev, [item.id]: "" }));
    } catch (err) {
      console.error(err);
      alert("Could not save your note. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (userLoading || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const open = items.filter((i) => i.status !== "closed");
  const done = items.filter((i) => i.status === "closed");

  const card = (item: CareItem) => {
    const info = getCareInfo(item.type);
    const isDone = item.status === "closed";
    return (
      <div key={item.id} className={`bg-white border rounded-xl p-5 ${isDone ? "border-gray-100 opacity-80" : "border-gray-200"}`}>
        <div className="flex items-start gap-4">
          <span className="text-2xl mt-0.5 shrink-0">{info.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="font-bold text-gray-900">{item.memberName}</span>
              <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{info.label}</span>
              {item.source === "cell_group" && (
                <span className="text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-200 px-2 py-0.5 rounded-full">Cell group</span>
              )}
              {isDone && (
                <span className="text-xs font-bold bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Resolved</span>
              )}
            </div>
            <p className="text-xs text-gray-400 mb-2">
              {item.date}
              {item.assignedTo ? ` · from ${item.assignedTo}` : ""}
            </p>
            <p className="text-sm text-gray-700 leading-relaxed">{item.notes}</p>

            {item.assigneeNote && (
              <p className="text-sm text-gray-600 mt-2 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                <span className="font-semibold">Your note:</span> {item.assigneeNote}
              </p>
            )}

            {!isDone && (
              <div className="mt-3 flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={noteDrafts[item.id] ?? ""}
                  onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  placeholder="Add a follow-up note (what you did)…"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <button
                  onClick={() => saveNote(item)}
                  disabled={busyId === item.id || !(noteDrafts[item.id] ?? "").trim()}
                  className="text-xs font-semibold text-emerald-700 border border-emerald-200 hover:bg-emerald-50 px-3 py-1.5 rounded-lg transition disabled:opacity-50"
                >
                  Save note
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => toggleStatus(item)}
            disabled={busyId === item.id}
            className="shrink-0 text-xs font-semibold text-gray-500 hover:text-emerald-700 border border-gray-200 hover:border-emerald-300 px-3 py-1.5 rounded-lg transition disabled:opacity-50"
          >
            {isDone ? "Reopen" : "Mark Resolved"}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">My Care Follow-ups</h1>
        <p className="text-sm text-gray-500 mt-1">
          Pastoral care items assigned to you. Reach out, then mark them resolved and note what you did.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4">{error}</p>
      )}

      {items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-14 text-center">
          <p className="text-4xl mb-3">✅</p>
          <p className="text-sm font-semibold text-gray-700">Nothing assigned to you</p>
          <p className="text-xs text-gray-400 mt-1">When a pastoral care item is allocated to you, it will show up here.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {open.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Open ({open.length})</p>
              {open.map(card)}
            </div>
          )}
          {done.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Resolved</p>
              {done.map(card)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
