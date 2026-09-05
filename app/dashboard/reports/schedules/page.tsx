"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { db } from "../../../../lib/firebase";
import { useAppUser } from "../../../../lib/useAppUser";
import { schedulableReports } from "../reports";
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";

// ────────────────────────────────────────────────────────────────────────────
// SCHEDULED REPORTS (owner/admin)
//
// Set up a report to be generated and emailed on a cadence. A daily Cloud
// Function (scheduledReports) picks up the due ones, builds the report
// server-side, and emails it to the recipients via the church's Brevo account.
// Only non-sensitive reports can be scheduled; the sensitive ones (giving by
// member, pastoral care) are never auto-emailed.
// ────────────────────────────────────────────────────────────────────────────

interface Schedule {
  id: string;
  reportId: string;
  reportTitle: string;
  cadence: "weekly" | "monthly";
  recipients: string[];
  active: boolean;
  lastRunAt?: Timestamp | null;
  lastRunStatus?: string;
}

const REPORTS = schedulableReports();

function parseEmails(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,\n;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@") && e.includes("."))
    )
  );
}

export default function ReportSchedulesPage() {
  const { appUser, tenantId, loading: userLoading } = useAppUser();
  const router = useRouter();
  const canManage = ["owner", "admin"].includes(appUser?.role || "");

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [reportId, setReportId] = useState(REPORTS[0]?.id || "");
  const [cadence, setCadence] = useState<"weekly" | "monthly">("monthly");
  const [recipients, setRecipients] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!tenantId || !canManage) return;
    const q = query(collection(db, "report_schedules"), where("tenantId", "==", tenantId));
    return onSnapshot(q, (snap) => {
      setSchedules(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Schedule, "id">) }))
          .sort((a, b) => a.reportTitle.localeCompare(b.reportTitle))
      );
    });
  }, [tenantId, canManage]);

  async function createSchedule() {
    setError("");
    const report = REPORTS.find((r) => r.id === reportId);
    if (!report || !tenantId) return;
    const emails = parseEmails(recipients);
    if (emails.length === 0) {
      setError("Add at least one valid recipient email.");
      return;
    }
    setSaving(true);
    try {
      await addDoc(collection(db, "report_schedules"), {
        tenantId,
        reportId: report.id,
        reportTitle: report.title,
        cadence,
        recipients: emails,
        active: true,
        createdByName: appUser?.displayName || appUser?.email || "Admin",
        createdAt: serverTimestamp(),
        lastRunAt: null,
        lastRunStatus: "",
      });
      setRecipients("");
    } catch (err) {
      console.error(err);
      setError("Could not save this schedule. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(s: Schedule) {
    await updateDoc(doc(db, "report_schedules", s.id), { active: !s.active });
  }

  async function remove(s: Schedule) {
    if (!confirm(`Stop emailing "${s.reportTitle}"?`)) return;
    await deleteDoc(doc(db, "report_schedules", s.id));
  }

  if (userLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="max-w-xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Scheduled Reports</h1>
        <p className="text-sm text-gray-500">Only owners and admins can set up scheduled reports.</p>
      </div>
    );
  }

  const selected = REPORTS.find((r) => r.id === reportId);

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <button onClick={() => router.push("/dashboard/reports")} className="text-sm text-gray-500 hover:text-gray-800 mb-1">
          ← Reports
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Scheduled Reports</h1>
        <p className="text-sm text-gray-500 mt-1">
          Have a report generated and emailed automatically. Monthly reports cover the previous month and go out on the 1st; weekly reports cover the previous 7 days and go out on Mondays.
        </p>
      </div>

      {/* Create */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6 space-y-4">
        <h2 className="text-sm font-bold text-gray-900">New schedule</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Report</label>
            <select
              value={reportId}
              onChange={(e) => setReportId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              {REPORTS.map((r) => (
                <option key={r.id} value={r.id}>{r.title}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Cadence</label>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as "weekly" | "monthly")}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="monthly">Monthly (1st of the month)</option>
              <option value="weekly">Weekly (Mondays)</option>
            </select>
          </div>
        </div>
        {selected && <p className="text-xs text-gray-400">{selected.description}</p>}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Recipients</label>
          <textarea
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            rows={2}
            placeholder="Email addresses, separated by commas"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
          />
          <p className="text-xs text-gray-400 mt-1">The report is generated for the whole church and sent as a CSV attachment.</p>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          onClick={createSchedule}
          disabled={saving}
          className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors"
        >
          {saving ? "Saving…" : "Add schedule"}
        </button>
      </div>

      {/* Existing */}
      <h2 className="text-sm font-bold text-gray-900 mb-3">Active schedules</h2>
      {schedules.length === 0 ? (
        <p className="text-sm text-gray-400">No scheduled reports yet.</p>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">
                  {s.reportTitle}
                  <span className="ml-2 text-xs font-medium text-gray-400 capitalize">· {s.cadence}</span>
                  {!s.active && <span className="ml-2 text-xs font-semibold text-amber-600">Paused</span>}
                </p>
                <p className="text-xs text-gray-400 truncate">
                  {s.recipients.join(", ")}
                  {s.lastRunAt ? ` · last sent ${s.lastRunAt.toDate().toLocaleDateString("en-ZA")}` : " · not sent yet"}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button onClick={() => toggleActive(s)} className="text-xs font-semibold text-gray-500 hover:text-gray-800">
                  {s.active ? "Pause" : "Resume"}
                </button>
                <button onClick={() => remove(s)} className="text-xs font-semibold text-red-400 hover:text-red-600">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
