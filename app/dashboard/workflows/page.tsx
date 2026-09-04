"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { db } from "../../../lib/firebase";
import { useAppUser } from "../../../lib/useAppUser";
import { useTenantTier } from "../../../lib/useTenantTier";
import { isPaidTier } from "../../../lib/tier";
import PaidFeatureLock from "../../components/PaidFeatureLock";
import { ensureStandardWorkflows } from "../../../lib/standardWorkflows";
import InfoTooltip from "../../components/InfoTooltip";
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  serverTimestamp,
  orderBy,
  doc,
  getDoc,
} from "firebase/firestore";

type TriggerType = "visitor_added" | "member_added" | "care_tier" | "birthday" | "manual";
type WorkflowMode = "sequence" | "checklist";

interface Workflow {
  id: string;
  name: string;
  description: string;
  trigger: TriggerType;
  active: boolean;
  stepCount: number;
  instanceCount: number;
  isSystem?: boolean;
  systemKey?: string;
  mode?: WorkflowMode;      // absent ⇒ "sequence" (the original automated follow-up)
  cellRegion?: string;      // checklist mode only; "" ⇒ available to every cell group
  createdAt: any;
}

interface WorkflowInstance {
  id: string;
  workflowId: string;
  workflowName: string;
  subjectName: string;
  status: "active" | "completed" | "paused";
  overdueCount: number;
  dueTodayCount: number;
  nextDueDate: string;
}

const TRIGGERS: { value: TriggerType; label: string; icon: string; description: string }[] = [
  { value: "visitor_added", label: "New Visitor", icon: "👋", description: "Starts when a first-time guest is added" },
  { value: "member_added", label: "New Member", icon: "🎉", description: "Starts when a new membership form is approved" },
  { value: "care_tier", label: "Care Follow-Up", icon: "❤️", description: "Started from Care Tier Alerts for absent members" },
  { value: "birthday", label: "Birthday", icon: "🎂", description: "Starts on a member's birthday" },
  { value: "manual", label: "Manual", icon: "▶️", description: "Started manually for any person" },
];

function triggerInfo(t: TriggerType) {
  return TRIGGERS.find((x) => x.value === t) || TRIGGERS[TRIGGERS.length - 1];
}

export default function WorkflowsPage() {
  const { tenantId, appUser, loading: userLoading } = useAppUser();
  const { tier, loading: tierLoading } = useTenantTier();
  const router = useRouter();

  const role = appUser?.role || "";
  // Managers design and run automated workflows; cell leaders only run SOP
  // checklists scoped to their own group.
  const isManager = ["owner", "admin", "member_manager"].includes(role);
  const isCellLeader = role === "cell_leader";

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [instances, setInstances] = useState<WorkflowInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    trigger: "visitor_added" as TriggerType,
    mode: "sequence" as WorkflowMode,
    cellRegion: "",
  });
  const [cellRegions, setCellRegions] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const resetForm = () =>
    setForm({ name: "", description: "", trigger: "visitor_added", mode: "sequence", cellRegion: "" });

  // Every church gets the three standard workflows (Visitor Follow-Up, Care
  // Follow-Up, New Member Onboarding) created empty for them to design. Cheap
  // and idempotent, so it is safe to run on every visit. Only managers may
  // create workflows, so we never attempt the seed for a cell leader.
  useEffect(() => {
    if (!tenantId || !isPaidTier(tier) || !isManager) return;
    ensureStandardWorkflows(tenantId).catch((e) => console.warn("Standard workflow seed skipped:", e));
  }, [tenantId, tier, isManager]);

  // Managers pick a cell group when scoping a checklist. Regions are stored on
  // the tenant doc, same source the Team page uses.
  useEffect(() => {
    if (!tenantId || !isManager) return;
    getDoc(doc(db, "tenants", tenantId))
      .then((snap) => setCellRegions((snap.data()?.cellRegions as string[]) || []))
      .catch(() => setCellRegions([]));
  }, [tenantId, isManager]);

  useEffect(() => {
    if (!tenantId) return;

    const wq = query(collection(db, "workflows"), where("tenantId", "==", tenantId), orderBy("createdAt", "desc"));
    const wUnsub = onSnapshot(wq, (snap) => {
      setWorkflows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Workflow, "id">) })));
      setLoading(false);
    });

    // Cell leaders cannot read person-based workflow instances, so only managers
    // subscribe to them (they power the overdue / due-today banners).
    if (!isManager) return () => { wUnsub(); };

    const iq = query(
      collection(db, "workflow_instances"),
      where("tenantId", "==", tenantId),
      where("status", "==", "active"),
      orderBy("nextDueDate", "asc")
    );
    const iUnsub = onSnapshot(iq, (snap) => {
      setInstances(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WorkflowInstance, "id">) })));
    });

    return () => { wUnsub(); iUnsub(); };
  }, [tenantId, isManager]);

  async function createWorkflow() {
    if (!form.name.trim() || !tenantId) return;
    const isChecklist = form.mode === "checklist";
    setCreating(true);
    try {
      const ref = await addDoc(collection(db, "workflows"), {
        tenantId,
        name: form.name.trim(),
        description: form.description.trim(),
        // Checklists are dateless and started by hand, so they carry the manual
        // trigger. Sequence workflows keep the chosen automation trigger.
        trigger: isChecklist ? "manual" : form.trigger,
        mode: form.mode,
        cellRegion: isChecklist ? form.cellRegion.trim() : "",
        active: true,
        stepCount: 0,
        instanceCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShowModal(false);
      resetForm();
      router.push(`/dashboard/workflows/${ref.id}`);
    } finally {
      setCreating(false);
    }
  }

  const overdue = instances.filter((i) => i.overdueCount > 0);
  const dueToday = instances.filter((i) => i.dueTodayCount > 0 && i.overdueCount === 0);

  // What a cell leader is allowed to see: checklist workflows that are either
  // open to every group or scoped to their own region.
  const myRegion = appUser?.assignedCellRegion || "";
  const visibleWorkflows = isCellLeader
    ? workflows.filter(
        (w) => w.mode === "checklist" && (!w.cellRegion || w.cellRegion === myRegion)
      )
    : workflows;

  if (userLoading || loading || tierLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isPaidTier(tier)) {
    return <PaidFeatureLock feature="Automation workflows" />;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Workflows</h1>
          <p className="text-sm text-gray-500 mt-1">
            {isCellLeader
              ? "Recurring SOP checklists for your cell group. Start this week's run and tick off each step."
              : "Automated follow-up sequences and recurring SOP checklists for your team."}
          </p>
        </div>
        {!isCellLeader && (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            <span className="text-lg leading-none">+</span> New Workflow
          </button>
        )}
      </div>

      {/* Attention banners */}
      {overdue.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 flex items-start gap-3">
          <span className="text-xl">⚠️</span>
          <div>
            <p className="text-sm font-semibold text-red-700">
              {overdue.reduce((a, i) => a + i.overdueCount, 0)} overdue task{overdue.reduce((a, i) => a + i.overdueCount, 0) !== 1 ? "s" : ""} across {overdue.length} workflow{overdue.length !== 1 ? "s" : ""}
            </p>
            <p className="text-xs text-red-500 mt-0.5">
              {overdue.map((i) => i.subjectName).slice(0, 3).join(", ")}
              {overdue.length > 3 ? ` and ${overdue.length - 3} more` : ""}
            </p>
          </div>
        </div>
      )}
      {dueToday.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 flex items-start gap-3">
          <span className="text-xl">📋</span>
          <div>
            <p className="text-sm font-semibold text-amber-700">
              {dueToday.reduce((a, i) => a + i.dueTodayCount, 0)} task{dueToday.reduce((a, i) => a + i.dueTodayCount, 0) !== 1 ? "s" : ""} due today
            </p>
            <p className="text-xs text-amber-600 mt-0.5">
              {dueToday.map((i) => i.subjectName).slice(0, 3).join(", ")}
            </p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {visibleWorkflows.length === 0 && (
        <div className="border-2 border-dashed border-gray-200 rounded-xl p-16 text-center">
          <div className="text-5xl mb-4">{isCellLeader ? "✅" : "⚡"}</div>
          <h3 className="text-lg font-semibold text-gray-700 mb-1">
            {isCellLeader ? "No checklists for your group yet" : "No workflows yet"}
          </h3>
          <p className="text-sm text-gray-400 mb-6 max-w-sm mx-auto">
            {isCellLeader
              ? "Your church has not set up any SOP checklists for your cell group yet. Once they do, you can start this week's run here."
              : "Build follow-up sequences that guide your team through caring for visitors and welcoming new members, or recurring SOP checklists for your cell groups."}
          </p>
          {!isCellLeader && (
            <button
              onClick={() => setShowModal(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors"
            >
              Create a Workflow
            </button>
          )}
        </div>
      )}

      {/* Workflows grid */}
      {visibleWorkflows.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleWorkflows.map((wf) => {
            const info = triggerInfo(wf.trigger);
            const isChecklist = wf.mode === "checklist";
            const activeInstances = instances.filter((i) => i.workflowId === wf.id);
            const wfOverdue = activeInstances.reduce((a, i) => a + (i.overdueCount || 0), 0);

            return (
              <div
                key={wf.id}
                onClick={() => router.push(`/dashboard/workflows/${wf.id}`)}
                className="bg-white border border-gray-200 rounded-xl p-5 cursor-pointer hover:shadow-sm hover:border-gray-300 transition-all flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xl shrink-0">{isChecklist ? "✅" : info.icon}</span>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-gray-900 truncate">{wf.name}</h3>
                      {wf.description && (
                        <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{wf.description}</p>
                      )}
                    </div>
                  </div>
                  <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${
                    wf.active ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
                  }`}>
                    {wf.active ? "Active" : "Off"}
                  </span>
                </div>

                <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                  {isChecklist ? (
                    <>
                      <span className="bg-teal-100 text-teal-700 font-semibold px-2 py-0.5 rounded-full">Checklist</span>
                      <span className="bg-gray-100 px-2 py-0.5 rounded-full">
                        {wf.cellRegion ? wf.cellRegion : "All groups"}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="bg-gray-100 px-2 py-0.5 rounded-full">{info.label}</span>
                      {wf.isSystem && (
                        <span className="bg-slate-100 text-slate-600 font-semibold px-2 py-0.5 rounded-full">Standard</span>
                      )}
                    </>
                  )}
                  <span>·</span>
                  <span>{wf.stepCount || 0} step{wf.stepCount !== 1 ? "s" : ""}</span>
                </div>

                {/* A standard workflow with no steps does nothing yet. Nudge them. */}
                {wf.isSystem && !wf.stepCount && (
                  <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                    Design your steps to switch this on
                  </p>
                )}

                {isChecklist ? (
                  <div className="flex items-center justify-between pt-2 border-t border-gray-100 text-xs">
                    <span className="text-gray-500">Recurring · no deadlines</span>
                    {!wf.stepCount && <span className="text-amber-600 font-medium">Add steps</span>}
                  </div>
                ) : (
                  <div className="flex items-center justify-between pt-2 border-t border-gray-100 text-xs">
                    <span className="text-gray-500">{activeInstances.length} active</span>
                    {wfOverdue > 0 && (
                      <span className="font-semibold text-red-500">{wfOverdue} overdue</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* New Workflow Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 max-h-[85vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-gray-900 mb-5">New Workflow</h2>
            <div className="space-y-4">
              {/* Type: automated sequence vs recurring SOP checklist */}
              <div>
                <label className="flex items-center gap-1 text-sm font-medium text-gray-700 mb-2">
                  Type
                  <InfoTooltip text="A Sequence runs automatically with dated steps. A Checklist is a dateless, repeatable SOP a cell group runs each week." why="The two work very differently: sequences chase individual people over time, while checklists are the same list of tasks a group ticks off again and again." />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { value: "sequence" as WorkflowMode, icon: "⚡", label: "Sequence", desc: "Automated, dated follow-up for one person" },
                    { value: "checklist" as WorkflowMode, icon: "✅", label: "Checklist", desc: "Recurring SOP a cell group runs each week" },
                  ]).map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setForm({ ...form, mode: m.value })}
                      className={`flex items-start gap-2 p-3 rounded-xl border text-left transition-all ${
                        form.mode === m.value ? "border-emerald-500 bg-emerald-50" : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <span className="text-lg shrink-0">{m.icon}</span>
                      <div>
                        <p className="text-xs font-semibold text-gray-800">{m.label}</p>
                        <p className="text-xs text-gray-400 mt-0.5 leading-tight">{m.desc}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="flex items-center gap-1 text-sm font-medium text-gray-700 mb-1">
                  Workflow Name <span className="text-red-500">*</span>
                  <InfoTooltip text="A short name for this workflow, for example First-Time Visitor Care or Weekly Cell Group Setup." why="This is only for your team to recognise it in lists. Name it after what it does so you can tell your workflows apart later." />
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={form.mode === "checklist" ? "e.g. Weekly Cell Group Setup" : "e.g. New Visitor Follow-Up"}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  autoFocus
                />
              </div>

              {form.mode === "checklist" ? (
                <div>
                  <label className="flex items-center gap-1 text-sm font-medium text-gray-700 mb-1">
                    Cell Group
                    <InfoTooltip text="Which cell group runs this checklist. Choose All groups to make it available to every cell leader." why="Cell leaders only see and run checklists scoped to their own group, so this decides who this SOP belongs to." />
                  </label>
                  <select
                    value={form.cellRegion}
                    onChange={(e) => setForm({ ...form, cellRegion: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                  >
                    <option value="">All groups</option>
                    {cellRegions.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="flex items-center gap-1 text-sm font-medium text-gray-700 mb-2">
                    Trigger
                    <InfoTooltip text="The event that automatically starts this workflow, for example a new visitor being captured." why="The trigger is the whole point of automation. It decides when people get dropped onto this follow-up path without anyone having to do it by hand." />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {TRIGGERS.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => setForm({ ...form, trigger: t.value })}
                        className={`flex items-start gap-2 p-3 rounded-xl border text-left transition-all ${
                          form.trigger === t.value
                            ? "border-emerald-500 bg-emerald-50"
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <span className="text-lg shrink-0">{t.icon}</span>
                        <div>
                          <p className="text-xs font-semibold text-gray-800">{t.label}</p>
                          <p className="text-xs text-gray-400 mt-0.5 leading-tight">{t.description}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description <span className="text-gray-400 font-normal">(optional)</span></label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  placeholder="What does this workflow do?"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowModal(false); resetForm(); }}
                className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createWorkflow}
                disabled={!form.name.trim() || creating}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
              >
                {creating ? "Creating..." : "Create and Edit"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
