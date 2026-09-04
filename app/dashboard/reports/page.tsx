"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { db } from "../../../lib/firebase";
import { useAppUser } from "../../../lib/useAppUser";
import ExportMemberButton from "../../components/ExportMemberButton";
import { doc, getDoc } from "firebase/firestore";
import { reportsForRole, type ReportDef, type ReportResult } from "./reports";

const firstOfMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};
const todayStr = () => new Date().toISOString().split("T")[0];

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function ReportsPage() {
  const { appUser, tenantId, churchName, loading: userLoading } = useAppUser();
  const role = appUser?.role || "";
  const region = appUser?.assignedCellRegion || "";
  const branch = appUser?.assignedBranch || "";

  const available = useMemo(() => reportsForRole(role), [role]);
  const grouped = useMemo(() => {
    const g: Record<string, ReportDef[]> = {};
    available.forEach((r) => {
      (g[r.group] ||= []).push(r);
    });
    return g;
  }, [available]);

  const [selectedId, setSelectedId] = useState<string>("");
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayStr());
  const [scope, setScope] = useState("");
  const [cellRegions, setCellRegions] = useState<string[]>([]);
  const [branches, setBranches] = useState<string[]>([]);

  const [result, setResult] = useState<ReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const selected = available.find((r) => r.id === selectedId) || null;

  useEffect(() => {
    if (!tenantId) return;
    getDoc(doc(db, "tenants", tenantId))
      .then((snap) => {
        const t = snap.data() || {};
        setCellRegions((t.cellRegions as string[]) || []);
        setBranches((t.branches as string[]) || []);
      })
      .catch(() => {});
  }, [tenantId]);

  // Reset output when the chosen report changes.
  useEffect(() => {
    setResult(null);
    setError("");
    setScope("");
  }, [selectedId]);

  async function runReport() {
    if (!selected || !tenantId) return;
    setRunning(true);
    setError("");
    try {
      const res = await selected.run({ tenantId, role, region, branch, from, to, scope });
      setResult(res);
    } catch (err) {
      console.error("Report failed:", err);
      const code = (err as { code?: string })?.code;
      setError(
        code === "permission-denied"
          ? "You don't have access to the data behind this report."
          : "Could not build this report right now. Please try again."
      );
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  // Open a clean, print-friendly version and hand it to the browser's print
  // dialog, where the user can Save as PDF. Matches how payslips/invoices print
  // (window.print), so no PDF library is pulled in.
  function printReport() {
    if (!selected || !result) return;
    const scopeLabel =
      selected.scope && selected.scope !== "none"
        ? scopePinned
          ? pinnedLabel || "Your group"
          : scope || (selected.scope === "branch" ? "All branches" : "All groups")
        : "";
    const meta: string[] = [];
    if (selected.dateRange) meta.push(`${from} to ${to}`);
    if (scopeLabel) meta.push(scopeLabel);
    const generated = new Date().toLocaleString("en-ZA");

    const summaryHtml = (result.summary || [])
      .map((s) => `<span class="chip"><b>${esc(s.value)}</b> ${esc(s.label)}</span>`)
      .join("");
    const head = result.columns.map((c) => `<th>${esc(c.label)}</th>`).join("");
    const body = result.rows
      .map((r) => `<tr>${result.columns.map((c) => `<td>${esc(r[c.key])}</td>`).join("")}</tr>`)
      .join("");

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(selected.title)}</title>
      <style>
        *{font-family:Arial,Helvetica,sans-serif;box-sizing:border-box}
        body{margin:24px;color:#111}
        h1{font-size:20px;margin:0 0 2px}
        .sub{color:#555;font-size:12px;margin:0 0 2px}
        .church{font-size:13px;font-weight:bold;color:#059669;margin:0 0 10px}
        .chips{margin:12px 0}
        .chip{display:inline-block;border:1px solid #ddd;border-radius:999px;padding:3px 10px;margin:0 6px 6px 0;font-size:12px}
        table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
        th{text-align:left;background:#f3f4f6;border-bottom:2px solid #e5e7eb;padding:6px 8px;text-transform:uppercase;font-size:10px;color:#444}
        td{border-bottom:1px solid #eee;padding:5px 8px}
        .foot{margin-top:16px;color:#888;font-size:10px}
        @media print{body{margin:12mm}}
      </style></head><body>
      <p class="church">${esc(churchName || "Kereke Hub")}</p>
      <h1>${esc(selected.title)}</h1>
      ${meta.length ? `<p class="sub">${esc(meta.join(" · "))}</p>` : ""}
      <p class="sub">${esc(result.rows.length)} row${result.rows.length === 1 ? "" : "s"} · generated ${esc(generated)}</p>
      <div class="chips">${summaryHtml}</div>
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      <p class="foot">Generated by Kereke Hub</p>
      </body></html>`;

    const w = window.open("", "_blank");
    if (!w) {
      alert("Please allow pop-ups for this site to print or save the report as PDF.");
      return;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    // Give the new window a tick to render before printing.
    setTimeout(() => w.print(), 300);
  }

  if (userLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (available.length === 0) {
    return (
      <div className="max-w-xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Reports</h1>
        <p className="text-sm text-gray-500">There are no reports available for your role yet.</p>
      </div>
    );
  }

  // A cell leader is pinned to their own group; a branch admin to their branch.
  const scopePinned =
    (selected?.scope === "cellRegion" && role === "cell_leader") ||
    (selected?.scope === "branch" && role === "branch_admin");
  const pinnedLabel = selected?.scope === "cellRegion" ? region : branch;

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-500 mt-1">
            Pull and export the reports you have access to. Pick one, set the range, and download to Excel or CSV.
          </p>
        </div>
        {["owner", "admin"].includes(role) && (
          <Link
            href="/dashboard/reports/schedules"
            className="shrink-0 text-sm font-semibold text-gray-600 hover:text-gray-900 bg-white border border-gray-200 hover:border-gray-300 px-3 py-2 rounded-lg transition-colors"
          >
            ⏰ Scheduled reports
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        {/* Report list */}
        <div className="space-y-4">
          {Object.entries(grouped).map(([groupName, list]) => (
            <div key={groupName}>
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">{groupName}</p>
              <div className="space-y-1">
                {list.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors border ${
                      selectedId === r.id
                        ? "border-emerald-400 bg-emerald-50 text-emerald-800 font-semibold"
                        : "border-transparent hover:bg-gray-50 text-gray-700"
                    }`}
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Report panel */}
        <div>
          {!selected ? (
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-16 text-center text-sm text-gray-400">
              Choose a report on the left to get started.
            </div>
          ) : (
            <div>
              <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
                <h2 className="text-lg font-bold text-gray-900">{selected.title}</h2>
                <p className="text-sm text-gray-500 mt-1">{selected.description}</p>

                <div className="flex flex-wrap items-end gap-3 mt-4">
                  {selected.dateRange && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
                        <input
                          type="date"
                          value={from}
                          max={to}
                          onChange={(e) => setFrom(e.target.value)}
                          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
                        <input
                          type="date"
                          value={to}
                          max={todayStr()}
                          onChange={(e) => setTo(e.target.value)}
                          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                    </>
                  )}

                  {selected.scope && selected.scope !== "none" && (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">
                        {selected.scope === "branch" ? "Branch" : "Cell Group"}
                      </label>
                      {scopePinned ? (
                        <div className="border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-600">
                          {pinnedLabel || "Your group"}
                        </div>
                      ) : (
                        <select
                          value={scope}
                          onChange={(e) => setScope(e.target.value)}
                          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        >
                          <option value="">{selected.scope === "branch" ? "All branches" : "All groups"}</option>
                          {(selected.scope === "branch" ? branches : cellRegions).map((v) => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  <button
                    onClick={runReport}
                    disabled={running}
                    className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors"
                  >
                    {running ? "Running…" : "Run report"}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4">{error}</p>
              )}

              {result && (
                <div>
                  {/* Summary + export */}
                  <div className="flex flex-wrap items-center gap-3 mb-4">
                    {(result.summary || []).map((s) => (
                      <div key={s.label} className="bg-white border border-gray-200 rounded-xl px-4 py-2.5">
                        <p className="text-xs text-gray-500">{s.label}</p>
                        <p className="text-lg font-bold text-gray-900">{s.value}</p>
                      </div>
                    ))}
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        onClick={printReport}
                        disabled={result.rows.length === 0}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition disabled:opacity-40 shadow-sm"
                        title="Open a printable version to save as PDF"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z" />
                        </svg>
                        Print / PDF
                      </button>
                      <ExportMemberButton data={result.rows} filename={selected.id} columns={result.columns} />
                    </div>
                  </div>

                  {/* Preview table */}
                  <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                    {result.rows.length === 0 ? (
                      <div className="p-12 text-center text-sm text-gray-400">No data for this selection.</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-gray-50 border-b border-gray-200">
                              {result.columns.map((c) => (
                                <th key={c.key} className="text-left px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                                  {c.label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {result.rows.slice(0, 100).map((row, i) => (
                              <tr key={i} className="hover:bg-gray-50">
                                {result.columns.map((c) => (
                                  <td key={c.key} className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                                    {String(row[c.key] ?? "")}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {result.rows.length > 100 && (
                          <p className="text-xs text-gray-400 px-4 py-3 border-t border-gray-100">
                            Showing the first 100 rows. Export to get all {result.rows.length}.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
