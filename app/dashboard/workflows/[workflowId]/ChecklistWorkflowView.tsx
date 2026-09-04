"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { db } from "../../../../lib/firebase";
import { useAppUser } from "../../../../lib/useAppUser";
import {
  doc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
  Timestamp,
} from "firebase/firestore";

// ────────────────────────────────────────────────────────────────────────────
// SOP CHECKLIST VIEW
//
// The dateless, recurring cousin of the automated Sequence workflow. A checklist
// is a fixed list of steps a cell group runs again and again. Each execution is
// a "run" (stored in checklist_runs) with the steps snapshotted onto it, so a
// past run keeps the exact steps it was ticked off against even if the template
// changes later. Managers design the steps; cell leaders (and managers) start a
// run for a group, tick items off, and close it out. Closed runs stay as history.
// ────────────────────────────────────────────────────────────────────────────

interface ChecklistWorkflow {
  tenantId: string;
  name: string;
  description: string;
  active: boolean;
  cellRegion: string; // "" ⇒ available to every group
  stepCount: number;
}

interface TemplateStep {
  id: string;
  order: number;
  title: string;
  message: string;
}

interface RunItem {
  stepId: string;
  order: number;
  title: string;
  message: string;
  done: boolean;
  doneBy?: string;
  doneAt?: Timestamp | null;
}

interface ChecklistRun {
  id: string;
  tenantId: string;
  workflowId: string;
  workflowName: string;
  cellRegion: string;
  weekOf: string;
  status: "active" | "closed";
  startedByUid: string;
  startedByName: string;
  startedAt: Timestamp | null;
  closedAt?: Timestamp | null;
  items: RunItem[];
  totalItems: number;
  completedItems: number;
}

type Tab = "runs" | "steps";

function generateId() {
  return Math.random().toString(36).slice(2, 11);
}

// Monday of the current week, as YYYY-MM-DD. Gives every run a stable "week of"
// label so a group can tell one week's run from the next.
function startOfWeek(): string {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift back to Monday
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}

function formatDate(value?: string) {
  if (!value) return "";
  const d = new Date(value + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function ChecklistWorkflowView({ workflowId }: { workflowId: string }) {
  const { tenantId, appUser } = useAppUser();
  const router = useRouter();

  const role = appUser?.role || "";
  const isManager = ["owner", "admin", "member_manager"].includes(role);
  const isCellLeader = role === "cell_leader";
  const myRegion = appUser?.assignedCellRegion || "";
  const authorName = appUser?.displayName || appUser?.email || "Cell Leader";

  const [workflow, setWorkflow] = useState<ChecklistWorkflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("runs");

  // Template steps (the SOP definition)
  const [steps, setSteps] = useState<TemplateStep[]>([]);
  const [savingSteps, setSavingSteps] = useState(false);
  const [stepsSaved, setStepsSaved] = useState(false);

  // Runs (executions)
  const [runs, setRuns] = useState<ChecklistRun[]>([]);
  const [starting, setStarting] = useState(false);
  // Managers starting an "all groups" checklist must pick which group the run is for.
  const [cellRegions, setCellRegions] = useState<string[]>([]);
  const [startRegion, setStartRegion] = useState("");

  useEffect(() => {
    if (!workflowId) return;
    getDoc(doc(db, "workflows", workflowId)).then((snap) => {
      if (snap.exists()) setWorkflow(snap.data() as ChecklistWorkflow);
      setLoading(false);
    });
  }, [workflowId]);

  // Live template steps — no orderBy to avoid a composite index; sorted client-side.
  useEffect(() => {
    if (!workflowId || !tenantId) return;
    const q = query(
      collection(db, "workflow_steps"),
      where("tenantId", "==", tenantId),
      where("workflowId", "==", workflowId)
    );
    return onSnapshot(q, (snap) => {
      const sorted = snap.docs
        .map((d) => {
          const data = d.data() as any;
          return { id: d.id, order: data.order ?? 0, title: data.title || "", message: data.message || "" };
        })
        .sort((a, b) => a.order - b.order);
      setSteps(sorted);
    });
  }, [workflowId, tenantId]);

  // Live runs — no orderBy to avoid a composite index; sorted client-side.
  // A cell leader may only read runs for their own group, so the query MUST be
  // constrained to their region (an unconstrained query would try to return
  // other groups' runs and be rejected wholesale). Managers read every group's.
  useEffect(() => {
    if (!workflowId || !tenantId) return;
    if (isCellLeader && !myRegion) {
      setRuns([]);
      return;
    }
    const base = [
      collection(db, "checklist_runs"),
      where("tenantId", "==", tenantId),
      where("workflowId", "==", workflowId),
    ] as const;
    const q = isCellLeader
      ? query(base[0], base[1], base[2], where("cellRegion", "==", myRegion))
      : query(base[0], base[1], base[2]);
    return onSnapshot(q, (snap) => {
      const sorted = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<ChecklistRun, "id">) }))
        .sort((a, b) => (b.startedAt?.toMillis?.() ?? 0) - (a.startedAt?.toMillis?.() ?? 0));
      setRuns(sorted);
    });
  }, [workflowId, tenantId, isCellLeader, myRegion]);

  // Managers may run an "all groups" checklist for any group, so load the list.
  useEffect(() => {
    if (!tenantId || !isManager) return;
    getDoc(doc(db, "tenants", tenantId))
      .then((snap) => setCellRegions((snap.data()?.cellRegions as string[]) || []))
      .catch(() => setCellRegions([]));
  }, [tenantId, isManager]);

  // ── Steps editing (managers only) ─────────────────────────────────────────

  function addStep() {
    const lastOrder = steps.length > 0 ? Math.max(...steps.map((s) => s.order)) : 0;
    setSteps([...steps, { id: `new_${generateId()}`, order: lastOrder + 1, title: "", message: "" }]);
  }

  function updateStep(id: string, changes: Partial<TemplateStep>) {
    setSteps(steps.map((s) => (s.id === id ? { ...s, ...changes } : s)));
  }

  function removeStep(id: string) {
    setSteps(steps.filter((s) => s.id !== id));
  }

  function moveStep(id: string, dir: "up" | "down") {
    const idx = steps.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const swap = dir === "up" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= steps.length) return;
    const next = [...steps];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    next.forEach((s, i) => (s.order = i + 1));
    setSteps([...next]);
  }

  async function saveSteps() {
    if (!workflowId || !tenantId) return;
    setSavingSteps(true);
    try {
      // Replace the whole set: delete existing, recreate in order. Checklist
      // steps have no delays or dependencies, so they stay deliberately simple.
      const existing = await getDocs(
        query(
          collection(db, "workflow_steps"),
          where("tenantId", "==", tenantId),
          where("workflowId", "==", workflowId)
        )
      );
      const batch = writeBatch(db);
      existing.docs.forEach((d) => batch.delete(d.ref));

      const ordered = steps
        .map((s) => ({ ...s, title: s.title.trim() }))
        .filter((s) => s.title.length > 0)
        .map((s, i) => ({ ...s, order: i + 1 }));

      ordered.forEach((step) => {
        const ref = doc(collection(db, "workflow_steps"));
        batch.set(ref, {
          workflowId,
          tenantId,
          order: step.order,
          delayDays: 0,
          actionType: "task",
          title: step.title,
          message: step.message,
          dependsOnStepIds: [],
        });
      });
      await batch.commit();
      await updateDoc(doc(db, "workflows", workflowId), {
        stepCount: ordered.length,
        updatedAt: serverTimestamp(),
      });
      setStepsSaved(true);
      setTimeout(() => setStepsSaved(false), 2000);
    } finally {
      setSavingSteps(false);
    }
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  // The group this user would start a run for. A scoped checklist always uses
  // its own region; on an "all groups" checklist a cell leader uses their own
  // region and a manager picks one.
  const runRegion = workflow?.cellRegion || (isCellLeader ? myRegion : startRegion);
  const activeRun = runs.find((r) => r.status === "active" && r.cellRegion === runRegion);
  const canStart =
    !!workflow &&
    steps.length > 0 &&
    !!runRegion &&
    !activeRun &&
    (isManager || (isCellLeader && (!workflow.cellRegion || workflow.cellRegion === myRegion)));

  async function startRun() {
    if (!workflowId || !tenantId || !workflow || !runRegion || steps.length === 0) return;
    setStarting(true);
    try {
      const items: RunItem[] = steps.map((s) => ({
        stepId: s.id,
        order: s.order,
        title: s.title,
        message: s.message || "",
        done: false,
        doneAt: null,
      }));
      await addDoc(collection(db, "checklist_runs"), {
        tenantId,
        workflowId,
        workflowName: workflow.name,
        cellRegion: runRegion,
        weekOf: startOfWeek(),
        status: "active",
        startedByUid: appUser?.uid || "",
        startedByName: authorName,
        startedAt: serverTimestamp(),
        closedAt: null,
        items,
        totalItems: items.length,
        completedItems: 0,
      });
    } finally {
      setStarting(false);
    }
  }

  async function toggleItem(run: ChecklistRun, index: number) {
    if (run.status !== "active") return;
    const items = run.items.map((it, i) =>
      i === index
        ? { ...it, done: !it.done, doneBy: !it.done ? authorName : "", doneAt: !it.done ? Timestamp.now() : null }
        : it
    );
    const completedItems = items.filter((it) => it.done).length;
    // Optimistic local update; onSnapshot will reconcile.
    setRuns((prev) => prev.map((r) => (r.id === run.id ? { ...r, items, completedItems } : r)));
    await updateDoc(doc(db, "checklist_runs", run.id), { items, completedItems });
  }

  async function closeRun(run: ChecklistRun) {
    await updateDoc(doc(db, "checklist_runs", run.id), { status: "closed", closedAt: serverTimestamp() });
  }

  async function reopenRun(run: ChecklistRun) {
    await updateDoc(doc(db, "checklist_runs", run.id), { status: "active", closedAt: null });
  }

  async function deleteRun(run: ChecklistRun) {
    if (!isManager) return;
    if (!confirm("Delete this run and its history? This cannot be undone.")) return;
    await deleteDoc(doc(db, "checklist_runs", run.id));
  }

  const activeRuns = runs.filter((r) => r.status === "active");
  const closedRuns = runs.filter((r) => r.status === "closed");

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!workflow) return <p className="text-gray-500">Checklist not found.</p>;

  const tabs: Tab[] = isManager ? ["runs", "steps"] : ["runs"];

  const renderRunCard = (run: ChecklistRun) => {
    const isDone = run.status === "closed";
    const pct = run.totalItems > 0 ? Math.round((run.completedItems / run.totalItems) * 100) : 0;
    const canWork =
      run.status === "active" &&
      (isManager || (isCellLeader && run.cellRegion === myRegion));

    return (
      <div key={run.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-800">
                Week of {formatDate(run.weekOf)}
                {!workflow.cellRegion && run.cellRegion && (
                  <span className="ml-2 text-xs font-medium text-gray-400">· {run.cellRegion}</span>
                )}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">Started by {run.startedByName || "—"}</p>
            </div>
            <span
              className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${
                isDone
                  ? "bg-gray-100 text-gray-500 border border-gray-200"
                  : "bg-emerald-50 text-emerald-700 border border-emerald-200"
              }`}
            >
              {isDone ? "Closed" : "In progress"}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-gray-400">{run.completedItems}/{run.totalItems} done</span>
          </div>
        </div>

        <div className="px-4 py-3 space-y-2">
          {run.items.map((it, i) => (
            <div key={it.stepId || i} className="flex items-start gap-3">
              <button
                onClick={() => toggleItem(run, i)}
                disabled={!canWork}
                className={`mt-0.5 w-4 h-4 shrink-0 rounded border-2 flex items-center justify-center transition-colors ${
                  it.done
                    ? "bg-emerald-500 border-emerald-500"
                    : canWork
                    ? "border-gray-300 hover:border-emerald-400"
                    : "border-gray-200 bg-gray-100 cursor-not-allowed"
                }`}
              >
                {it.done && <span className="text-white text-xs">✓</span>}
              </button>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${it.done ? "line-through text-gray-400" : "text-gray-800"}`}>
                  {it.title}
                </p>
                {it.message && <p className="text-xs text-gray-400 mt-0.5">{it.message}</p>}
              </div>
            </div>
          ))}

          <div className="pt-3 border-t border-gray-100 flex items-center gap-4">
            {canWork ? (
              <button onClick={() => closeRun(run)} className="text-xs font-semibold text-emerald-700 hover:text-emerald-900">
                Close out this run
              </button>
            ) : isDone && (isManager || (isCellLeader && run.cellRegion === myRegion)) ? (
              <button onClick={() => reopenRun(run)} className="text-xs text-gray-500 hover:text-gray-800 font-medium">
                Reopen
              </button>
            ) : null}
            {isManager && (
              <button onClick={() => deleteRun(run)} className="text-xs text-red-400 hover:text-red-600 ml-auto">
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex gap-3 mb-1">
          <button onClick={() => router.push("/dashboard")} className="text-sm text-gray-500 hover:text-gray-800">
            ← Dashboard
          </button>
          <span className="text-gray-300">/</span>
          <button onClick={() => router.push("/dashboard/workflows")} className="text-sm text-gray-500 hover:text-gray-800">
            Workflows
          </button>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <span>✅</span> {workflow.name}
        </h1>
        <div className="flex items-center gap-2 mt-1 text-sm text-gray-500 flex-wrap">
          <span className="bg-teal-100 text-teal-700 text-xs font-semibold px-2 py-0.5 rounded-full">Checklist</span>
          <span className="bg-gray-100 text-xs px-2 py-0.5 rounded-full">
            {workflow.cellRegion ? workflow.cellRegion : "All groups"}
          </span>
          <span>· {steps.length} step{steps.length !== 1 ? "s" : ""} · recurring</span>
        </div>
        {workflow.description && <p className="text-sm text-gray-500 mt-2">{workflow.description}</p>}
      </div>

      {/* Tabs */}
      {tabs.length > 1 && (
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t ? "border-emerald-500 text-emerald-600" : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {t === "steps" ? "Steps" : "Runs"}
            </button>
          ))}
        </div>
      )}

      {/* RUNS TAB */}
      {(tab === "runs" || tabs.length === 1) && (
        <div>
          {/* Start a run */}
          <div className="bg-white border border-gray-200 rounded-xl p-4 mb-5">
            {steps.length === 0 ? (
              <p className="text-sm text-gray-400">
                {isManager
                  ? "Add some steps first, then you can start a run."
                  : "This checklist has no steps yet. Ask your church to set it up."}
              </p>
            ) : (
              <div className="flex items-center gap-3 flex-wrap">
                {/* Manager on an all-groups checklist picks the group */}
                {isManager && !workflow.cellRegion && (
                  <select
                    value={startRegion}
                    onChange={(e) => setStartRegion(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="">Choose a group…</option>
                    {cellRegions.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={startRun}
                  disabled={!canStart || starting}
                  className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  {starting ? "Starting…" : "Start This Week's Run"}
                </button>
                {activeRun && (
                  <span className="text-xs text-amber-600">
                    A run is already in progress for {activeRun.cellRegion || "this group"}. Close it before starting a new one.
                  </span>
                )}
                {isCellLeader && !myRegion && (
                  <span className="text-xs text-red-500">You are not assigned to a cell group yet.</span>
                )}
              </div>
            )}
          </div>

          {runs.length === 0 && (
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-12 text-center text-sm text-gray-400">
              No runs yet. Start this week's run to begin ticking off steps.
            </div>
          )}

          {activeRuns.length > 0 && (
            <div className="space-y-3 mb-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">In progress</p>
              {activeRuns.map(renderRunCard)}
            </div>
          )}

          {closedRuns.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Past runs</p>
              {closedRuns.map(renderRunCard)}
            </div>
          )}
        </div>
      )}

      {/* STEPS TAB (managers only) */}
      {tab === "steps" && isManager && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">
              The steps a group ticks off each run. No dates or delays, just the list.
            </p>
            <button
              onClick={saveSteps}
              disabled={savingSteps}
              className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors"
            >
              {savingSteps ? "Saving…" : stepsSaved ? "Saved!" : "Save Steps"}
            </button>
          </div>

          {steps.length === 0 && (
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center text-sm text-gray-400 mb-4">
              No steps yet. Add your first step below.
            </div>
          )}

          <div className="space-y-2 mb-4">
            {steps.map((step, idx) => (
              <div key={step.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-xs font-bold flex items-center justify-center shrink-0">
                    {idx + 1}
                  </span>
                  <input
                    type="text"
                    value={step.title}
                    onChange={(e) => updateStep(step.id, { title: e.target.value })}
                    placeholder="Step title, e.g. Set out chairs"
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => moveStep(step.id, "up")} disabled={idx === 0} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30">↑</button>
                    <button onClick={() => moveStep(step.id, "down")} disabled={idx === steps.length - 1} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30">↓</button>
                    <button onClick={() => removeStep(step.id)} className="p-1 text-red-400 hover:text-red-600 ml-1">✕</button>
                  </div>
                </div>
                <input
                  type="text"
                  value={step.message}
                  onChange={(e) => updateStep(step.id, { message: e.target.value })}
                  placeholder="Optional note or instructions"
                  className="w-full mt-2 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            ))}
          </div>

          <button
            onClick={addStep}
            className="w-full border-2 border-dashed border-gray-200 hover:border-emerald-400 text-gray-400 hover:text-emerald-600 rounded-xl py-3 text-sm font-medium transition-colors"
          >
            + Add Step
          </button>
        </div>
      )}
    </div>
  );
}
