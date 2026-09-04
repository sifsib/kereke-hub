"use client";

// ────────────────────────────────────────────────────────────────────────────
// REPORTS REGISTRY
//
// One place that defines every pull-able report: who may run it, whether it
// takes a date range and/or a group/branch scope, and the query that builds its
// rows. The Reports page renders whatever the current user is allowed to see and
// runs the chosen report's `run()`.
//
// Each report reads through the caller's own Firestore permissions, so the role
// gate here and the security rules agree: a report is only listed for roles that
// can actually read its data.
// ────────────────────────────────────────────────────────────────────────────

import { db } from "../../../lib/firebase";
import { collection, query, where, getDoc, getDocs, doc } from "firebase/firestore";

export type ReportColumn = { key: string; label: string };
export type ReportRow = Record<string, string | number>;
export interface ReportResult {
  columns: ReportColumn[];
  rows: ReportRow[];
  summary?: { label: string; value: string }[];
}

export interface ReportContext {
  tenantId: string;
  role: string;
  region: string; // the caller's own assignedCellRegion (cell leaders)
  branch: string; // the caller's own assignedBranch (branch admins)
  from: string;   // YYYY-MM-DD
  to: string;     // YYYY-MM-DD
  scope: string;  // selected cell group / branch, "" = all
}

export interface ReportDef {
  id: string;
  title: string;
  description: string;
  group: string;
  roles: string[];
  dateRange?: boolean;
  scope?: "none" | "cellRegion" | "branch";
  run: (ctx: ReportContext) => Promise<ReportResult>;
}

// ── shared helpers ──────────────────────────────────────────────────────────

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
const CARE_TYPE_LABEL: Record<string, string> = {
  hospital_visit: "Hospital Visit",
  home_visit: "Home Visit",
  phone_call: "Phone Call",
  counseling: "Counseling",
  prayer: "Prayer",
  bereavement: "Bereavement",
  other: "Other",
};

const money = (n: number) =>
  `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function classStatus(v: unknown): "not_started" | "in_progress" | "completed" {
  return v === "in_progress" || v === "completed" ? v : "not_started";
}

function memberName(d: Record<string, unknown>): string {
  return (
    (d.fullName as string) ||
    `${(d.firstName as string) || ""} ${(d.lastName as string) || ""}`.trim() ||
    "(no name)"
  );
}

async function loadTenant(tenantId: string): Promise<Record<string, unknown>> {
  const snap = await getDoc(doc(db, "tenants", tenantId));
  return (snap.data() as Record<string, unknown>) || {};
}

function classesOf(tenant: Record<string, unknown>): ClassType[] {
  const t = tenant.classTypes;
  return Array.isArray(t) && t.length > 0 ? (t as ClassType[]).filter((x) => x && x.id && x.name) : DEFAULT_CLASS_TYPES;
}

// Effective per-member class state, with fallback to the legacy flat fields.
function classStateOf(d: Record<string, unknown>, typeId: string): { status: string; date: string } {
  const map = (d.classes as Record<string, { status?: unknown; date?: unknown }>) || {};
  if (map[typeId]) return { status: classStatus(map[typeId].status), date: (map[typeId].date as string) || "" };
  if (typeId === "membership") return { status: classStatus(d.membershipClassStatus), date: (d.membershipClassDate as string) || "" };
  if (typeId === "discipleship") return { status: classStatus(d.discipleshipClassStatus), date: (d.discipleshipClassDate as string) || "" };
  return { status: "not_started", date: "" };
}

// Members for the caller's scope. Cell leaders are always pinned to their own
// region; branch admins to their branch; otherwise the chosen scope (or all).
async function loadMembers(ctx: ReportContext) {
  const filters = [where("tenantId", "==", ctx.tenantId)];
  if (ctx.role === "cell_leader" && ctx.region) {
    // A cell leader only ever sees their own group.
    filters.push(where("cellRegion", "==", ctx.region));
  } else {
    // A branch admin is confined to their branch, and any chosen group narrows
    // within it. Everyone else just filters by the chosen group, if any.
    if (ctx.role === "branch_admin" && ctx.branch) filters.push(where("branch", "==", ctx.branch));
    if (ctx.scope) filters.push(where("cellRegion", "==", ctx.scope));
  }
  const snap = await getDocs(query(collection(db, "members"), ...filters));
  return snap.docs
    .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    .filter((m) => m.data.status !== "suspended");
}

function inRange(dateStr: string, from: string, to: string): boolean {
  if (!dateStr) return false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

// ── report definitions ──────────────────────────────────────────────────────

export const REPORTS: ReportDef[] = [
  {
    id: "membership_directory",
    title: "Membership Directory",
    description: "Every active member with their group, branch, membership type and contact details.",
    group: "People",
    roles: ["owner", "admin", "member_manager", "member_viewer", "branch_admin", "cell_leader"],
    scope: "cellRegion",
    run: async (ctx) => {
      const members = await loadMembers(ctx);
      const rows: ReportRow[] = members
        .map((m) => ({
          name: memberName(m.data),
          cellRegion: (m.data.cellRegion as string) || "",
          branch: (m.data.branch as string) || "",
          membershipType: (m.data.membershipType as string) || "",
          role: (m.data.role as string) || "",
          email: (m.data.email as string) || "",
          phone: (m.data.phone as string) || (m.data.cellphone as string) || "",
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return {
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
    },
  },

  {
    id: "class_progress",
    title: "Class Progress",
    description: "Each member's status in every class the church runs, with completion dates.",
    group: "Discipleship",
    roles: ["owner", "admin", "member_manager", "member_viewer", "branch_admin", "cell_leader"],
    scope: "cellRegion",
    run: async (ctx) => {
      const [tenant, members] = await Promise.all([loadTenant(ctx.tenantId), loadMembers(ctx)]);
      const types = classesOf(tenant);
      const columns: ReportColumn[] = [
        { key: "name", label: "Name" },
        { key: "cellRegion", label: "Cell Group" },
      ];
      types.forEach((t) => {
        columns.push({ key: `${t.id}__status`, label: `${t.name} — Status` });
        columns.push({ key: `${t.id}__date`, label: `${t.name} — Completed` });
      });
      const rows: ReportRow[] = members
        .map((m) => {
          const row: ReportRow = { name: memberName(m.data), cellRegion: (m.data.cellRegion as string) || "" };
          types.forEach((t) => {
            const s = classStateOf(m.data, t.id);
            row[`${t.id}__status`] = STATUS_LABEL[s.status];
            row[`${t.id}__date`] = s.status === "completed" ? s.date : "";
          });
          return row;
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const summary = types.map((t) => ({
        label: `${t.name} completed`,
        value: String(members.filter((m) => classStateOf(m.data, t.id).status === "completed").length),
      }));
      return { columns, rows, summary };
    },
  },

  {
    id: "cell_group_summary",
    title: "Cell Group Summary",
    description: "One row per cell group: how many members, and how many have completed each class.",
    group: "Cell Groups",
    roles: ["owner", "admin", "member_manager", "branch_admin", "cell_leader"],
    scope: "cellRegion",
    run: async (ctx) => {
      const [tenant, members] = await Promise.all([loadTenant(ctx.tenantId), loadMembers(ctx)]);
      const types = classesOf(tenant);
      const byGroup: Record<string, { count: number; completed: Record<string, number> }> = {};
      members.forEach((m) => {
        const g = ((m.data.cellRegion as string) || "").trim() || "Unassigned";
        if (!byGroup[g]) byGroup[g] = { count: 0, completed: {} };
        byGroup[g].count += 1;
        types.forEach((t) => {
          if (classStateOf(m.data, t.id).status === "completed")
            byGroup[g].completed[t.id] = (byGroup[g].completed[t.id] || 0) + 1;
        });
      });
      const columns: ReportColumn[] = [
        { key: "group", label: "Cell Group" },
        { key: "members", label: "Members" },
      ];
      types.forEach((t) => columns.push({ key: t.id, label: `${t.name} done` }));
      const rows: ReportRow[] = Object.entries(byGroup)
        .map(([group, v]) => {
          const row: ReportRow = { group, members: v.count };
          types.forEach((t) => (row[t.id] = v.completed[t.id] || 0));
          return row;
        })
        .sort((a, b) => String(a.group).localeCompare(String(b.group)));
      return {
        columns,
        rows,
        summary: [
          { label: "Cell groups", value: String(rows.length) },
          { label: "Members", value: String(members.length) },
        ],
      };
    },
  },

  {
    id: "cell_offerings",
    title: "Cell Group Offerings",
    description: "Offerings submitted by cell groups over a period, with their review status.",
    group: "Finance",
    roles: ["owner", "admin", "finance", "finance_viewer", "cell_leader"],
    dateRange: true,
    scope: "cellRegion",
    run: async (ctx) => {
      const filters = [where("tenantId", "==", ctx.tenantId)];
      // Cell leaders may only read their own region's offerings.
      if (ctx.role === "cell_leader" && ctx.region) filters.push(where("cellRegion", "==", ctx.region));
      else if (ctx.scope) filters.push(where("cellRegion", "==", ctx.scope));
      const snap = await getDocs(query(collection(db, "cell_offerings"), ...filters));
      const all = snap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .filter((o) => inRange((o.date as string) || "", ctx.from, ctx.to));
      const rows: ReportRow[] = all
        .map((o) => ({
          date: (o.date as string) || "",
          cellRegion: (o.cellRegion as string) || "",
          amount: (o.amount as number) || 0,
          status: (o.status as string) || "",
          submittedBy: (o.submittedByName as string) || "",
        }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const approved = all.filter((o) => o.status === "approved").reduce((s, o) => s + ((o.amount as number) || 0), 0);
      const pending = all.filter((o) => o.status === "pending").reduce((s, o) => s + ((o.amount as number) || 0), 0);
      return {
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
    },
  },

  {
    id: "finance_summary",
    title: "Income & Expense Summary",
    description: "Totals by category for income and expenses over a period, with the net.",
    group: "Finance",
    roles: ["owner", "admin", "finance", "finance_viewer"],
    dateRange: true,
    scope: "none",
    run: async (ctx) => {
      const snap = await getDocs(query(collection(db, "transactions"), where("tenantId", "==", ctx.tenantId)));
      const all = snap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .filter((t) => inRange((t.date as string) || "", ctx.from, ctx.to));
      const buckets: Record<string, { type: string; total: number; count: number }> = {};
      all.forEach((t) => {
        const type = (t.type as string) === "expense" ? "Expense" : "Income";
        const cat = (t.category as string) || "Uncategorised";
        const key = `${type}::${cat}`;
        if (!buckets[key]) buckets[key] = { type, total: 0, count: 0 };
        buckets[key].total += (t.amount as number) || 0;
        buckets[key].count += 1;
      });
      const rows: ReportRow[] = Object.entries(buckets)
        .map(([key, v]) => ({ category: key.split("::")[1], type: v.type, total: v.total, count: v.count }))
        .sort((a, b) => String(a.type).localeCompare(String(b.type)) || Number(b.total) - Number(a.total));
      const income = all.filter((t) => (t.type as string) !== "expense").reduce((s, t) => s + ((t.amount as number) || 0), 0);
      const expense = all.filter((t) => (t.type as string) === "expense").reduce((s, t) => s + ((t.amount as number) || 0), 0);
      return {
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
    },
  },

  {
    id: "pastoral_summary",
    title: "Pastoral Care Summary",
    description: "Care activity over a period by type and status. Counts only, not the note contents.",
    group: "Pastoral Care",
    roles: ["owner", "admin"],
    dateRange: true,
    scope: "none",
    run: async (ctx) => {
      const snap = await getDocs(query(collection(db, "care_logs"), where("tenantId", "==", ctx.tenantId)));
      const all = snap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .filter((c) => inRange((c.date as string) || "", ctx.from, ctx.to));
      const byType: Record<string, { total: number; open: number; resolved: number }> = {};
      all.forEach((c) => {
        const t = (c.type as string) || "other";
        if (!byType[t]) byType[t] = { total: 0, open: 0, resolved: 0 };
        byType[t].total += 1;
        if ((c.status as string) === "closed") byType[t].resolved += 1;
        else byType[t].open += 1;
      });
      const rows: ReportRow[] = Object.entries(byType)
        .map(([t, v]) => ({ type: CARE_TYPE_LABEL[t] || t, total: v.total, open: v.open, resolved: v.resolved }))
        .sort((a, b) => Number(b.total) - Number(a.total));
      const open = all.filter((c) => (c.status as string) !== "closed").length;
      const fromCells = all.filter((c) => (c.source as string) === "cell_group").length;
      const assigned = all.filter((c) => !!(c.careAssigneeUid as string)).length;
      return {
        columns: [
          { key: "type", label: "Care Type" },
          { key: "total", label: "Total" },
          { key: "open", label: "Open" },
          { key: "resolved", label: "Resolved" },
        ],
        rows,
        summary: [
          { label: "Total logged", value: String(all.length) },
          { label: "Still open", value: String(open) },
          { label: "From cell groups", value: String(fromCells) },
          { label: "Allocated", value: String(assigned) },
        ],
      };
    },
  },
];

export function reportsForRole(role: string): ReportDef[] {
  if (role === "super_admin") return REPORTS;
  return REPORTS.filter((r) => r.roles.includes(role));
}
