"use client";

import { useEffect, useState } from "react";
import { db } from "../../../lib/firebase";
import { useAppUser } from "../../../lib/useAppUser";
import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";

// ────────────────────────────────────────────────────────────────────────────
// CELL GROUP OFFERINGS — submit form (cell leaders)
//
// A cell leader records one total offering for their group with a date. It goes
// into a pending queue that the finance team reviews and approves from the
// Financials page. Approving there creates the real ledger entry, so finance
// never has to re-type it. No per-member breakdown is captured here.
// ────────────────────────────────────────────────────────────────────────────

interface OfferingRow {
  id: string;
  amount: number;
  date: string;
  note?: string;
  status: "pending" | "approved" | "rejected";
  submittedAt?: Timestamp | null;
  reviewedByName?: string;
}

const fmt = (n: number) =>
  `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const todayStr = () => new Date().toISOString().split("T")[0];

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending: "bg-amber-50 text-amber-700 border-amber-200",
    approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-red-50 text-red-700 border-red-200",
  };
  const label: Record<string, string> = {
    pending: "Awaiting finance",
    approved: "Approved",
    rejected: "Not approved",
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${map[status] ?? "bg-gray-100 text-gray-600 border-gray-200"}`}>
      {label[status] ?? status}
    </span>
  );
}

export default function CellOfferingPage() {
  const { appUser, tenantId, loading: userLoading } = useAppUser();
  const role = appUser?.role || "";
  const isCellLeader = role === "cell_leader";
  const region = appUser?.assignedCellRegion || "";
  const submitterName = appUser?.displayName || appUser?.email || "Cell Leader";

  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [rows, setRows] = useState<OfferingRow[]>([]);

  // A cell leader may only read their own region's offerings, so the query must
  // be constrained to that region.
  useEffect(() => {
    if (!tenantId || !isCellLeader || !region) return;
    const q = query(
      collection(db, "cell_offerings"),
      where("tenantId", "==", tenantId),
      where("cellRegion", "==", region)
    );
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<OfferingRow, "id">) }))
          .sort((a, b) => (b.submittedAt?.toMillis?.() ?? 0) - (a.submittedAt?.toMillis?.() ?? 0));
        setRows(list);
      },
      (err) => console.error("Failed to load cell offerings:", err)
    );
  }, [tenantId, isCellLeader, region]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    if (!tenantId || !region) return;
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setError("Enter a valid offering amount.");
      return;
    }
    if (!date) {
      setError("Choose the date the offering was collected.");
      return;
    }
    setSaving(true);
    try {
      await addDoc(collection(db, "cell_offerings"), {
        tenantId,
        cellRegion: region,
        amount: parsed,
        date,
        note: note.trim(),
        status: "pending",
        submittedByUid: appUser?.uid || "",
        submittedByName: submitterName,
        submittedAt: serverTimestamp(),
      });
      setAmount("");
      setNote("");
      setDate(todayStr());
      setSuccess("Offering submitted. Finance will review and record it.");
      setTimeout(() => setSuccess(""), 4000);
    } catch (err) {
      console.error(err);
      setError("Could not submit. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (userLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isCellLeader) {
    return (
      <div className="max-w-xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Cell Group Offering</h1>
        <p className="text-sm text-gray-500">
          This page is for cell leaders to submit their group's offering. Finance staff record offerings directly on the Financials page.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold text-gray-900">Cell Group Offering</h1>
      <p className="text-sm text-gray-500 mt-1">
        Record the total offering collected in your cell group. Finance reviews and approves it, and the approved amount is added to the church ledger.
      </p>

      {region ? (
        <p className="text-xs text-gray-400 mt-1">
          Submitting for <span className="font-semibold text-gray-600">{region}</span>
        </p>
      ) : (
        <p className="text-sm text-red-500 mt-3">
          You are not assigned to a cell group yet, so you cannot submit an offering. Ask your church admin to assign your group.
        </p>
      )}

      <form onSubmit={submit} className="bg-white border border-gray-200 rounded-xl p-5 mt-4 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Total amount (R)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            disabled={!region}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-gray-50"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Date collected</label>
          <input
            type="date"
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value)}
            disabled={!region}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-gray-50"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Note <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Anything finance should know about this offering"
            disabled={!region}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none disabled:bg-gray-50"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {success && <p className="text-sm text-emerald-600">{success}</p>}

        <button
          type="submit"
          disabled={saving || !region}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors"
        >
          {saving ? "Submitting…" : "Submit Offering"}
        </button>
      </form>

      {/* Recent submissions */}
      <div className="mt-8">
        <h2 className="text-sm font-bold text-gray-900 mb-3">Your recent submissions</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-gray-400">No offerings submitted yet.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{fmt(r.amount)}</p>
                  <p className="text-xs text-gray-400">
                    {r.date}
                    {r.note ? ` · ${r.note}` : ""}
                    {r.status === "approved" && r.reviewedByName ? ` · approved by ${r.reviewedByName}` : ""}
                  </p>
                </div>
                {statusBadge(r.status)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
