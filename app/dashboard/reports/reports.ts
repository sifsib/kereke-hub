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
  // Whether this report may be scheduled and emailed. Left off the sensitive
  // reports (giving-by-member, pastoral care) on purpose, so they are never
  // auto-emailed on a cadence.
  schedulable?: boolean;
  run: (ctx: ReportContext) => Promise<ReportResult>;
}

// The reports a church may schedule for email, kept in sync with the server-side
// generators in functions/src/reportGen.ts.
export function schedulableReports(): ReportDef[] {
  return REPORTS.filter((r) => r.schedulable);
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

// Members for the caller's scope, including suspended ones. Cell leaders are
// always pinned to their own region; branch admins to their branch; otherwise
// the chosen scope (or all).
async function loadMembersRaw(ctx: ReportContext) {
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
  return snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
}

// The same, with suspended members dropped (the default for most reports).
async function loadMembers(ctx: ReportContext) {
  const all = await loadMembersRaw(ctx);
  return all.filter((m) => m.data.status !== "suspended");
}

function inRange(dateStr: string, from: string, to: string): boolean {
  if (!dateStr) return false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

// A Firestore Timestamp (or a date string) reduced to YYYY-MM-DD.
function tsToDate(v: unknown): string {
  const t = v as { toDate?: () => Date } | undefined;
  if (t && typeof t.toDate === "function") {
    try {
      return t.toDate().toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }
  return typeof v === "string" ? v.slice(0, 10) : "";
}

// ── report definitions ──────────────────────────────────────────────────────

export const REPORTS: ReportDef[] = [
  {
    id: "membership_directory",
    schedulable: true,
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
    schedulable: true,
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
    schedulable: true,
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
    schedulable: true,
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
    schedulable: true,
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
  {
    id: "growth",
    schedulable: true,
    title: "Growth",
    description: "New members joined and members suspended, by month over a period.",
    group: "People",
    roles: ["owner", "admin", "member_manager", "member_viewer", "branch_admin", "cell_leader"],
    dateRange: true,
    scope: "cellRegion",
    run: async (ctx) => {
      const members = await loadMembersRaw(ctx);
      const byMonth: Record<string, { joined: number; suspended: number }> = {};
      const bump = (month: string, key: "joined" | "suspended") => {
        if (!month) return;
        (byMonth[month] ||= { joined: 0, suspended: 0 })[key] += 1;
      };
      let joinedTotal = 0;
      let suspendedTotal = 0;
      members.forEach((m) => {
        const created = tsToDate(m.data.createdAt);
        if (inRange(created, ctx.from, ctx.to)) {
          bump(created.slice(0, 7), "joined");
          joinedTotal += 1;
        }
        if (m.data.status === "suspended") {
          const susp = tsToDate(m.data.suspendedAt);
          if (inRange(susp, ctx.from, ctx.to)) {
            bump(susp.slice(0, 7), "suspended");
            suspendedTotal += 1;
          }
        }
      });
      const rows: ReportRow[] = Object.entries(byMonth)
        .map(([month, v]) => ({ month, joined: v.joined, suspended: v.suspended, net: v.joined - v.suspended }))
        .sort((a, b) => String(a.month).localeCompare(String(b.month)));
      return {
        columns: [
          { key: "month", label: "Month" },
          { key: "joined", label: "Joined" },
          { key: "suspended", label: "Suspended" },
          { key: "net", label: "Net" },
        ],
        rows,
        summary: [
          { label: "Joined", value: String(joinedTotal) },
          { label: "Suspended", value: String(suspendedTotal) },
          { label: "Net", value: String(joinedTotal - suspendedTotal) },
        ],
      };
    },
  },

  {
    id: "visitor_pipeline",
    schedulable: true,
    title: "Visitor Follow-up Pipeline",
    description: "First-time guests over a period and whether they were followed up.",
    group: "People",
    roles: ["owner", "admin", "member_manager", "follow_up"],
    dateRange: true,
    scope: "none",
    run: async (ctx) => {
      const snap = await getDocs(query(collection(db, "visitors"), where("tenantId", "==", ctx.tenantId)));
      const all = snap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .filter((v) => inRange((v.serviceDate as string) || "", ctx.from, ctx.to));
      const rows: ReportRow[] = all
        .map((v) => ({
          name:
            (v.fullName as string) ||
            `${(v.firstName as string) || ""} ${(v.lastName as string) || ""}`.trim() ||
            "(no name)",
          serviceDate: (v.serviceDate as string) || "",
          reason: (v.reason as string) || "",
          followUp:
            v.followUpStatus === "done" ? "Followed up" : v.followUpStatus === "none" ? "One-time" : "Pending",
          followedUpBy: (v.followedUpBy as string) || "",
        }))
        .sort((a, b) => String(b.serviceDate).localeCompare(String(a.serviceDate)));
      const done = all.filter((v) => v.followUpStatus === "done").length;
      const pending = all.filter((v) => v.followUpStatus === "pending").length;
      const needing = all.filter((v) => v.followUpStatus !== "none").length;
      const rate = needing > 0 ? Math.round((done / needing) * 100) : 0;
      return {
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
    },
  },

  {
    id: "attendance_trend",
    schedulable: true,
    title: "Attendance Trend",
    description: "Attendance rate per service date over a period, for your scope.",
    group: "Attendance",
    roles: ["owner", "admin", "member_manager", "member_viewer", "branch_admin", "cell_leader"],
    dateRange: true,
    scope: "cellRegion",
    run: async (ctx) => {
      const members = await loadMembers(ctx);
      const idSet = new Set(members.map((m) => m.id));
      const snap = await getDocs(query(collection(db, "attendance"), where("tenantId", "==", ctx.tenantId)));
      const byDate: Record<string, { present: number; marked: number }> = {};
      snap.docs.forEach((d) => {
        const a = d.data() as Record<string, unknown>;
        const date = (a.serviceDate as string) || "";
        if (!inRange(date, ctx.from, ctx.to)) return;
        if (!idSet.has(a.personId as string)) return; // keep it within the caller's scope
        const b = (byDate[date] ||= { present: 0, marked: 0 });
        b.marked += 1;
        if (a.status === "present") b.present += 1;
      });
      const rows: ReportRow[] = Object.entries(byDate)
        .map(([date, v]) => ({
          date,
          present: v.present,
          marked: v.marked,
          rate: v.marked > 0 ? `${Math.round((v.present / v.marked) * 100)}%` : "0%",
        }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const totalPresent = Object.values(byDate).reduce((s, v) => s + v.present, 0);
      const totalMarked = Object.values(byDate).reduce((s, v) => s + v.marked, 0);
      const avg = totalMarked > 0 ? Math.round((totalPresent / totalMarked) * 100) : 0;
      return {
        columns: [
          { key: "date", label: "Service Date" },
          { key: "present", label: "Present" },
          { key: "marked", label: "Marked" },
          { key: "rate", label: "Attendance %" },
        ],
        rows,
        summary: [
          { label: "Services", value: String(rows.length) },
          { label: "Average attendance", value: `${avg}%` },
        ],
      };
    },
  },

  {
    id: "cell_group_scorecard",
    schedulable: true,
    title: "Cell Group Scorecard",
    description: "Per group: members, attendance rate, class completions, and (for finance roles) approved offerings.",
    group: "Cell Groups",
    roles: ["owner", "admin", "member_manager", "branch_admin", "cell_leader"],
    dateRange: true,
    scope: "cellRegion",
    run: async (ctx) => {
      const canOfferings = ["owner", "admin", "finance", "finance_viewer"].includes(ctx.role) || ctx.role === "cell_leader";
      const [tenant, members] = await Promise.all([loadTenant(ctx.tenantId), loadMembers(ctx)]);
      const types = classesOf(tenant);

      // Per-group members + class completions, and a member -> group map for attendance.
      const groups: Record<string, { members: number; completed: Record<string, number>; present: number; marked: number; offerings: number }> = {};
      const groupOf: Record<string, string> = {};
      const ensure = (g: string) => (groups[g] ||= { members: 0, completed: {}, present: 0, marked: 0, offerings: 0 });
      members.forEach((m) => {
        const g = ((m.data.cellRegion as string) || "").trim() || "Unassigned";
        groupOf[m.id] = g;
        const row = ensure(g);
        row.members += 1;
        types.forEach((t) => {
          if (classStateOf(m.data, t.id).status === "completed") row.completed[t.id] = (row.completed[t.id] || 0) + 1;
        });
      });

      // Attendance within range, tallied to each member's group.
      const attSnap = await getDocs(query(collection(db, "attendance"), where("tenantId", "==", ctx.tenantId)));
      attSnap.docs.forEach((d) => {
        const a = d.data() as Record<string, unknown>;
        const g = groupOf[a.personId as string];
        if (!g) return;
        if (!inRange((a.serviceDate as string) || "", ctx.from, ctx.to)) return;
        groups[g].marked += 1;
        if (a.status === "present") groups[g].present += 1;
      });

      // Approved offerings within range, per group, only where the caller may read them.
      if (canOfferings) {
        const offFilters = [where("tenantId", "==", ctx.tenantId)];
        if (ctx.role === "cell_leader" && ctx.region) offFilters.push(where("cellRegion", "==", ctx.region));
        else if (ctx.scope) offFilters.push(where("cellRegion", "==", ctx.scope));
        const offSnap = await getDocs(query(collection(db, "cell_offerings"), ...offFilters));
        offSnap.docs.forEach((d) => {
          const o = d.data() as Record<string, unknown>;
          if (o.status !== "approved") return;
          if (!inRange((o.date as string) || "", ctx.from, ctx.to)) return;
          const g = ((o.cellRegion as string) || "").trim() || "Unassigned";
          ensure(g).offerings += (o.amount as number) || 0;
        });
      }

      const columns: ReportColumn[] = [
        { key: "group", label: "Cell Group" },
        { key: "members", label: "Members" },
        { key: "attendance", label: "Attendance %" },
      ];
      types.forEach((t) => columns.push({ key: t.id, label: `${t.name} done` }));
      if (canOfferings) columns.push({ key: "offerings", label: "Approved Offerings (R)" });

      const rows: ReportRow[] = Object.entries(groups)
        .map(([group, v]) => {
          const row: ReportRow = {
            group,
            members: v.members,
            attendance: v.marked > 0 ? `${Math.round((v.present / v.marked) * 100)}%` : "—",
          };
          types.forEach((t) => (row[t.id] = v.completed[t.id] || 0));
          if (canOfferings) row.offerings = Number(v.offerings.toFixed(2));
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
    id: "giving_by_member",
    title: "Giving by Member",
    description: "Income attributed to each member over a period. Sensitive donor data.",
    group: "Finance",
    roles: ["owner", "admin", "finance"],
    dateRange: true,
    scope: "none",
    run: async (ctx) => {
      const snap = await getDocs(query(collection(db, "transactions"), where("tenantId", "==", ctx.tenantId)));
      const income = snap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .filter((t) => (t.type as string) !== "expense" && inRange((t.date as string) || "", ctx.from, ctx.to));
      const byMember: Record<string, { name: string; total: number; count: number }> = {};
      let unattributed = 0;
      income.forEach((t) => {
        const id = t.memberId as string;
        if (!id) {
          unattributed += (t.amount as number) || 0;
          return;
        }
        const b = (byMember[id] ||= { name: (t.memberName as string) || "(member)", total: 0, count: 0 });
        b.total += (t.amount as number) || 0;
        b.count += 1;
      });
      const rows: ReportRow[] = Object.values(byMember)
        .map((v) => ({ name: v.name, total: Number(v.total.toFixed(2)), gifts: v.count }))
        .sort((a, b) => Number(b.total) - Number(a.total));
      const attributed = rows.reduce((s, r) => s + Number(r.total), 0);
      return {
        columns: [
          { key: "name", label: "Member" },
          { key: "total", label: "Total Given (R)" },
          { key: "gifts", label: "Gifts" },
        ],
        rows,
        summary: [
          { label: "Givers", value: String(rows.length) },
          { label: "Attributed", value: money(attributed) },
          { label: "Unattributed", value: money(unattributed) },
        ],
      };
    },
  },
];

export function reportsForRole(role: string): ReportDef[] {
  if (role === "super_admin") return REPORTS;
  return REPORTS.filter((r) => r.roles.includes(role));
}
