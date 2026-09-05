// Server-side report generation for scheduled emailed reports.
//
// These mirror the client-side reports in app/dashboard/reports/reports.ts, but
// run under the Admin SDK (no per-user scoping) and only for the reports flagged
// schedulable there. Keep the two in step when adding a report.

import type { Firestore } from "firebase-admin/firestore";

type Row = Record<string, string | number>;
export interface GeneratedReport {
  title: string;
  meta: string; // e.g. "October 2025" or "1 Oct 2025 to 31 Oct 2025"
  columns: { key: string; label: string }[];
  rows: Row[];
  summary: { label: string; value: string }[];
}

type ClassType = { id: string; name: string };
const DEFAULT_CLASS_TYPES: ClassType[] = [
  { id: "membership", name: "Membership Class" },
  { id: "discipleship", name: "Discipleship Class" },
];
const STATUS_LABEL: Record<string, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  completed: "Completed",
};
const money = (n: number) =>
  `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function classStatus(v: unknown): "not_started" | "in_progress" | "completed" {
  return v === "in_progress" || v === "completed" ? v : "not_started";
}
function memberName(d: Record<string, any>): string {
  return d.fullName || `${d.firstName || ""} ${d.lastName || ""}`.trim() || "(no name)";
}
function classesOf(t: Record<string, any>): ClassType[] {
  const c = t.classTypes;
  return Array.isArray(c) && c.length > 0 ? c.filter((x: any) => x && x.id && x.name) : DEFAULT_CLASS_TYPES;
}
function classStateOf(d: Record<string, any>, typeId: string): { status: string; date: string } {
  const map = d.classes || {};
  if (map[typeId]) return { status: classStatus(map[typeId].status), date: map[typeId].date || "" };
  if (typeId === "membership") return { status: classStatus(d.membershipClassStatus), date: d.membershipClassDate || "" };
  if (typeId === "discipleship") return { status: classStatus(d.discipleshipClassStatus), date: d.discipleshipClassDate || "" };
  return { status: "not_started", date: "" };
}
function tsToDate(v: any): string {
  if (v && typeof v.toDate === "function") {
    try {
      return v.toDate().toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }
  return typeof v === "string" ? v.slice(0, 10) : "";
}
function inRange(d: string, from: string, to: string): boolean {
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// The period a scheduled report covers, based on its cadence, in SAST.
export function periodFor(cadence: string): { from: string; to: string; label: string } {
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000); // SAST (UTC+2, no DST)
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (cadence === "weekly") {
    const to = new Date(now);
    to.setUTCDate(to.getUTCDate() - 1); // yesterday
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 6); // 7-day window
    return { from: iso(from), to: iso(to), label: `${iso(from)} to ${iso(to)}` };
  }
  // monthly: the previous calendar month
  const firstThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastPrev = new Date(firstThis);
  lastPrev.setUTCDate(0); // last day of previous month
  const firstPrev = new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1));
  const label = firstPrev.toLocaleDateString("en-ZA", { month: "long", year: "numeric" });
  return { from: iso(firstPrev), to: iso(lastPrev), label };
}

async function getAll(db: Firestore, coll: string, tenantId: string) {
  const snap = await db.collection(coll).where("tenantId", "==", tenantId).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, any> }));
}

export async function generateReport(
  db: Firestore,
  tenantId: string,
  reportId: string,
  cadence: string
): Promise<GeneratedReport | null> {
  const { from, to, label } = periodFor(cadence);
  const tenantSnap = await db.doc(`tenants/${tenantId}`).get();
  const tenant = tenantSnap.data() || {};

  const activeMembers = async () =>
    (await getAll(db, "members", tenantId)).filter((m) => m.data.status !== "suspended");

  switch (reportId) {
    case "membership_directory": {
      const members = await activeMembers();
      const rows: Row[] = members
        .map((m) => ({
          name: memberName(m.data),
          cellRegion: m.data.cellRegion || "",
          branch: m.data.branch || "",
          membershipType: m.data.membershipType || "",
          role: m.data.role || "",
          email: m.data.email || "",
          phone: m.data.phone || m.data.cellphone || "",
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return {
        title: "Membership Directory",
        meta: "Current members",
        columns: [
          { key: "name", label: "Name" },
          { key: "cellRegion", label: "Cell Group" },
          { key: "branch", label: "Branch" },
          { key: "membershipType", label: "Membership Type" },
          { key: "role", label: "Role" },
          { key: "email", label: "Email" },
          { key: "phone", label: "Phone" },
        ],
        rows,
        summary: [{ label: "Members", value: String(rows.length) }],
      };
    }

    case "growth": {
      const members = await getAll(db, "members", tenantId);
      const byMonth: Record<string, { joined: number; suspended: number }> = {};
      let jT = 0;
      let sT = 0;
      members.forEach((m) => {
        const c = tsToDate(m.data.createdAt);
        if (inRange(c, from, to)) {
          (byMonth[c.slice(0, 7)] ||= { joined: 0, suspended: 0 }).joined += 1;
          jT += 1;
        }
        if (m.data.status === "suspended") {
          const s = tsToDate(m.data.suspendedAt);
          if (inRange(s, from, to)) {
            (byMonth[s.slice(0, 7)] ||= { joined: 0, suspended: 0 }).suspended += 1;
            sT += 1;
          }
        }
      });
      const rows: Row[] = Object.entries(byMonth)
        .map(([month, v]) => ({ month, joined: v.joined, suspended: v.suspended, net: v.joined - v.suspended }))
        .sort((a, b) => String(a.month).localeCompare(String(b.month)));
      return {
        title: "Growth",
        meta: label,
        columns: [
          { key: "month", label: "Month" },
          { key: "joined", label: "Joined" },
          { key: "suspended", label: "Suspended" },
          { key: "net", label: "Net" },
        ],
        rows,
        summary: [
          { label: "Joined", value: String(jT) },
          { label: "Suspended", value: String(sT) },
          { label: "Net", value: String(jT - sT) },
        ],
      };
    }

    case "class_progress": {
      const [members, types] = [await activeMembers(), classesOf(tenant)];
      const columns = [
        { key: "name", label: "Name" },
        { key: "cellRegion", label: "Cell Group" },
      ];
      types.forEach((t) => {
        columns.push({ key: `${t.id}__status`, label: `${t.name} — Status` });
        columns.push({ key: `${t.id}__date`, label: `${t.name} — Completed` });
      });
      const rows: Row[] = members
        .map((m) => {
          const row: Row = { name: memberName(m.data), cellRegion: m.data.cellRegion || "" };
          types.forEach((t) => {
            const s = classStateOf(m.data, t.id);
            row[`${t.id}__status`] = STATUS_LABEL[s.status];
            row[`${t.id}__date`] = s.status === "completed" ? s.date : "";
          });
          return row;
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return {
        title: "Class Progress",
        meta: "Current members",
        columns,
        rows,
        summary: types.map((t) => ({
          label: `${t.name} completed`,
          value: String(members.filter((m) => classStateOf(m.data, t.id).status === "completed").length),
        })),
      };
    }

    case "cell_group_summary": {
      const [members, types] = [await activeMembers(), classesOf(tenant)];
      const byGroup: Record<string, { count: number; completed: Record<string, number> }> = {};
      members.forEach((m) => {
        const g = (m.data.cellRegion || "").trim() || "Unassigned";
        const row = (byGroup[g] ||= { count: 0, completed: {} });
        row.count += 1;
        types.forEach((t) => {
          if (classStateOf(m.data, t.id).status === "completed") row.completed[t.id] = (row.completed[t.id] || 0) + 1;
        });
      });
      const columns = [
        { key: "group", label: "Cell Group" },
        { key: "members", label: "Members" },
      ];
      types.forEach((t) => columns.push({ key: t.id, label: `${t.name} done` }));
      const rows: Row[] = Object.entries(byGroup)
        .map(([group, v]) => {
          const row: Row = { group, members: v.count };
          types.forEach((t) => (row[t.id] = v.completed[t.id] || 0));
          return row;
        })
        .sort((a, b) => String(a.group).localeCompare(String(b.group)));
      return {
        title: "Cell Group Summary",
        meta: "Current members",
        columns,
        rows,
        summary: [
          { label: "Cell groups", value: String(rows.length) },
          { label: "Members", value: String(members.length) },
        ],
      };
    }

    case "cell_offerings": {
      const all = (await getAll(db, "cell_offerings", tenantId)).filter((o) => inRange(o.data.date || "", from, to));
      const rows: Row[] = all
        .map((o) => ({
          date: o.data.date || "",
          cellRegion: o.data.cellRegion || "",
          amount: o.data.amount || 0,
          status: o.data.status || "",
          submittedBy: o.data.submittedByName || "",
        }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const approved = all.filter((o) => o.data.status === "approved").reduce((s, o) => s + (o.data.amount || 0), 0);
      const pending = all.filter((o) => o.data.status === "pending").reduce((s, o) => s + (o.data.amount || 0), 0);
      return {
        title: "Cell Group Offerings",
        meta: label,
        columns: [
          { key: "date", label: "Date" },
          { key: "cellRegion", label: "Cell Group" },
          { key: "amount", label: "Amount (R)" },
          { key: "status", label: "Status" },
          { key: "submittedBy", label: "Submitted By" },
        ],
        rows,
        summary: [
          { label: "Approved", value: money(approved) },
          { label: "Pending", value: money(pending) },
          { label: "Submissions", value: String(all.length) },
        ],
      };
    }

    case "finance_summary": {
      const all = (await getAll(db, "transactions", tenantId)).filter((t) => inRange(t.data.date || "", from, to));
      const buckets: Record<string, { type: string; total: number; count: number }> = {};
      all.forEach((t) => {
        const type = t.data.type === "expense" ? "Expense" : "Income";
        const cat = t.data.category || "Uncategorised";
        const key = `${type}::${cat}`;
        const b = (buckets[key] ||= { type, total: 0, count: 0 });
        b.total += t.data.amount || 0;
        b.count += 1;
      });
      const rows: Row[] = Object.entries(buckets)
        .map(([key, v]) => ({ type: v.type, category: key.split("::")[1], total: Number(v.total.toFixed(2)), count: v.count }))
        .sort((a, b) => String(a.type).localeCompare(String(b.type)) || Number(b.total) - Number(a.total));
      const income = all.filter((t) => t.data.type !== "expense").reduce((s, t) => s + (t.data.amount || 0), 0);
      const expense = all.filter((t) => t.data.type === "expense").reduce((s, t) => s + (t.data.amount || 0), 0);
      return {
        title: "Income & Expense Summary",
        meta: label,
        columns: [
          { key: "type", label: "Type" },
          { key: "category", label: "Category" },
          { key: "total", label: "Total (R)" },
          { key: "count", label: "Entries" },
        ],
        rows,
        summary: [
          { label: "Income", value: money(income) },
          { label: "Expenses", value: money(expense) },
          { label: "Net", value: money(income - expense) },
        ],
      };
    }

    case "visitor_pipeline": {
      const all = (await getAll(db, "visitors", tenantId)).filter((v) => inRange(v.data.serviceDate || "", from, to));
      const rows: Row[] = all
        .map((v) => ({
          name: v.data.fullName || `${v.data.firstName || ""} ${v.data.lastName || ""}`.trim() || "(no name)",
          serviceDate: v.data.serviceDate || "",
          reason: v.data.reason || "",
          followUp: v.data.followUpStatus === "done" ? "Followed up" : v.data.followUpStatus === "none" ? "One-time" : "Pending",
          followedUpBy: v.data.followedUpBy || "",
        }))
        .sort((a, b) => String(b.serviceDate).localeCompare(String(a.serviceDate)));
      const done = all.filter((v) => v.data.followUpStatus === "done").length;
      const pending = all.filter((v) => v.data.followUpStatus === "pending").length;
      const needing = all.filter((v) => v.data.followUpStatus !== "none").length;
      const rate = needing > 0 ? Math.round((done / needing) * 100) : 0;
      return {
        title: "Visitor Follow-up Pipeline",
        meta: label,
        columns: [
          { key: "name", label: "Guest" },
          { key: "serviceDate", label: "Visited" },
          { key: "reason", label: "Reason" },
          { key: "followUp", label: "Follow-up" },
          { key: "followedUpBy", label: "Followed up by" },
        ],
        rows,
        summary: [
          { label: "Guests", value: String(all.length) },
          { label: "Followed up", value: String(done) },
          { label: "Pending", value: String(pending) },
          { label: "Follow-up rate", value: `${rate}%` },
        ],
      };
    }

    case "attendance_trend": {
      const members = await activeMembers();
      const idSet = new Set(members.map((m) => m.id));
      const att = await getAll(db, "attendance", tenantId);
      const byDate: Record<string, { present: number; marked: number }> = {};
      att.forEach((a) => {
        const date = a.data.serviceDate || "";
        if (!inRange(date, from, to)) return;
        if (!idSet.has(a.data.personId)) return;
        const b = (byDate[date] ||= { present: 0, marked: 0 });
        b.marked += 1;
        if (a.data.status === "present") b.present += 1;
      });
      const rows: Row[] = Object.entries(byDate)
        .map(([date, v]) => ({ date, present: v.present, marked: v.marked, rate: v.marked > 0 ? `${Math.round((v.present / v.marked) * 100)}%` : "0%" }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const tp = Object.values(byDate).reduce((s, v) => s + v.present, 0);
      const tm = Object.values(byDate).reduce((s, v) => s + v.marked, 0);
      return {
        title: "Attendance Trend",
        meta: label,
        columns: [
          { key: "date", label: "Service Date" },
          { key: "present", label: "Present" },
          { key: "marked", label: "Marked" },
          { key: "rate", label: "Attendance %" },
        ],
        rows,
        summary: [
          { label: "Services", value: String(rows.length) },
          { label: "Average attendance", value: `${tm > 0 ? Math.round((tp / tm) * 100) : 0}%` },
        ],
      };
    }

    case "cell_group_scorecard": {
      const [members, types] = [await activeMembers(), classesOf(tenant)];
      const groups: Record<string, { members: number; completed: Record<string, number>; present: number; marked: number; offerings: number }> = {};
      const groupOf: Record<string, string> = {};
      const ensure = (g: string) => (groups[g] ||= { members: 0, completed: {}, present: 0, marked: 0, offerings: 0 });
      members.forEach((m) => {
        const g = (m.data.cellRegion || "").trim() || "Unassigned";
        groupOf[m.id] = g;
        const row = ensure(g);
        row.members += 1;
        types.forEach((t) => {
          if (classStateOf(m.data, t.id).status === "completed") row.completed[t.id] = (row.completed[t.id] || 0) + 1;
        });
      });
      (await getAll(db, "attendance", tenantId)).forEach((a) => {
        const g = groupOf[a.data.personId];
        if (!g || !inRange(a.data.serviceDate || "", from, to)) return;
        groups[g].marked += 1;
        if (a.data.status === "present") groups[g].present += 1;
      });
      (await getAll(db, "cell_offerings", tenantId)).forEach((o) => {
        if (o.data.status !== "approved" || !inRange(o.data.date || "", from, to)) return;
        ensure((o.data.cellRegion || "").trim() || "Unassigned").offerings += o.data.amount || 0;
      });
      const columns = [
        { key: "group", label: "Cell Group" },
        { key: "members", label: "Members" },
        { key: "attendance", label: "Attendance %" },
      ];
      types.forEach((t) => columns.push({ key: t.id, label: `${t.name} done` }));
      columns.push({ key: "offerings", label: "Approved Offerings (R)" });
      const rows: Row[] = Object.entries(groups)
        .map(([group, v]) => {
          const row: Row = { group, members: v.members, attendance: v.marked > 0 ? `${Math.round((v.present / v.marked) * 100)}%` : "—" };
          types.forEach((t) => (row[t.id] = v.completed[t.id] || 0));
          row.offerings = Number(v.offerings.toFixed(2));
          return row;
        })
        .sort((a, b) => String(a.group).localeCompare(String(b.group)));
      return {
        title: "Cell Group Scorecard",
        meta: label,
        columns,
        rows,
        summary: [
          { label: "Cell groups", value: String(rows.length) },
          { label: "Members", value: String(members.length) },
        ],
      };
    }

    default:
      return null;
  }
}

// CSV for the attachment.
export function reportToCsv(columns: { key: string; label: string }[], rows: Row[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "").replace(/"/g, '""');
    return /[",\r\n]/.test(s) ? `"${s}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(",")).join("\r\n");
  return "﻿" + [head, body].join("\r\n");
}

// A simple HTML email body: church name, title, period, summary, first rows.
export function reportEmailHtml(churchName: string, report: GeneratedReport): string {
  const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const chips = report.summary
    .map((s) => `<span style="display:inline-block;border:1px solid #ddd;border-radius:999px;padding:3px 10px;margin:0 6px 6px 0;font-size:12px"><b>${esc(s.value)}</b> ${esc(s.label)}</span>`)
    .join("");
  const head = report.columns.map((c) => `<th style="text-align:left;background:#f3f4f6;padding:6px 8px;font-size:11px;text-transform:uppercase;color:#444">${esc(c.label)}</th>`).join("");
  const body = report.rows
    .slice(0, 30)
    .map((r) => `<tr>${report.columns.map((c) => `<td style="border-bottom:1px solid #eee;padding:5px 8px;font-size:12px">${esc(r[c.key])}</td>`).join("")}</tr>`)
    .join("");
  const more = report.rows.length > 30 ? `<p style="color:#888;font-size:12px">Showing the first 30 of ${report.rows.length} rows. The full report is attached as a CSV.</p>` : "";
  return `<div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;color:#111">
    <p style="font-size:13px;font-weight:bold;color:#059669;margin:0 0 4px">${esc(churchName || "Kereke Hub")}</p>
    <h2 style="margin:0 0 2px">${esc(report.title)}</h2>
    <p style="color:#555;font-size:12px;margin:0 0 10px">${esc(report.meta)} · ${report.rows.length} row${report.rows.length === 1 ? "" : "s"}</p>
    <div style="margin:10px 0">${chips}</div>
    <table style="width:100%;border-collapse:collapse"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    ${more}
    <p style="color:#999;font-size:11px;margin-top:16px">Sent automatically by Kereke Hub.</p>
  </div>`;
}
