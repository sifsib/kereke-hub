"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { db } from "../../../../lib/firebase";
import { useAppUser } from "../../../../lib/useAppUser";
import { useTeamMembers } from "../../../../lib/useTeamMembers";
import { notifyAssignee } from "../../../../lib/visitorMinistry";
import NotesPanel from "../../../components/NotesPanel";
import ChecklistWorkflowView from "./ChecklistWorkflowView";
import {
  doc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
  Timestamp,
} from "firebase/firestore";

type TriggerType = "visitor_added" | "member_added" | "care_tier" | "birthday" | "manual";
type ActionType = "task" | "whatsapp" | "email" | "note";
type InstanceStatus = "active" | "completed" | "paused";
type StepStatus = "pending" | "done" | "skipped";
type Tab = "steps" | "active" | "settings";

interface Workflow {
  tenantId: string;
  name: string;
  description: string;
  trigger: TriggerType;
  active: boolean;
  stepCount: number;
  instanceCount: number;
  mode?: "sequence" | "checklist";
}

interface WorkflowStep {
  id: string;
  order: number;
  delayDays: number;
  actionType: ActionType;
  title: string;
  message: string;
  dependsOnStepIds: string[];
}

interface WorkflowInstance {
  id: string;
  workflowId: string;
  tenantId: string;
  subjectId: string;
  subjectName: string;
  subjectPhone?: string;
  subjectType: "visitor" | "member";
  careTier?: number;        // set when started from Care Tier Alerts
  status: InstanceStatus;
  startedAt: Timestamp | null;
  completedSteps: number;
  totalSteps: number;
  assignedToUid?: string;   // DRI: team member accountable for this instance
  assignedToName?: string;
}

interface InstanceStep {
  id: string;
  instanceId: string;
  stepId: string;
  stepOrder: number;
  actionType: ActionType;
  title: string;
  message: string;
  dependsOnStepIds: string[];
  dueDate: string;
  status: StepStatus;
  completedAt?: Timestamp | null;
}

interface RosterPerson {
  id: string;
  firstName: string;
  lastName: string;
  cellphone?: string;
  phone?: string;
  type: "visitor" | "member";
}

const ACTION_TYPES: { value: ActionType; label: string; icon: string; color: string }[] = [
  { value: "task", label: "Task / Call", icon: "☑️", color: "bg-blue-100 text-blue-700" },
  { value: "whatsapp", label: "WhatsApp", icon: "💬", color: "bg-emerald-100 text-emerald-700" },
  { value: "email", label: "Email", icon: "📧", color: "bg-purple-100 text-purple-700" },
  { value: "note", label: "Note", icon: "📝", color: "bg-gray-100 text-gray-600" },
];

const TRIGGER_LABELS: Record<TriggerType, string> = {
  visitor_added: "New Visitor",
  member_added: "New Member",
  care_tier: "Care Follow-Up",
  birthday: "Birthday",
  manual: "Manual",
};

function actionStyle(t: ActionType) {
  return ACTION_TYPES.find((a) => a.value === t)?.color || "bg-gray-100 text-gray-600";
}
function actionIcon(t: ActionType) {
  return ACTION_TYPES.find((a) => a.value === t)?.icon || "📝";
}
function actionLabel(t: ActionType) {
  return ACTION_TYPES.find((a) => a.value === t)?.label || t;
}

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function SequenceWorkflowBuilder() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const { tenantId, appUser } = useAppUser();
  const { team } = useTeamMembers(tenantId);
  // Only owner/admin/managers may assign a DRI.
  const canAssign = ["owner", "admin", "member_manager"].includes(appUser?.role || "");
  // Any team member can be made responsible for a running workflow. The
  // Follow-Up Team flag only labels people, it does not filter the list.
  const assignableTeam = team;
  const router = useRouter();

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [tab, setTab] = useState<Tab>("steps");
  const [loading, setLoading] = useState(true);

  // Steps
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [editingStep, setEditingStep] = useState<string | null>(null);
  const [savingSteps, setSavingSteps] = useState(false);
  const [stepsSaved, setStepsSaved] = useState(false);

  // Active instances
  const [instances, setInstances] = useState<WorkflowInstance[]>([]);
  const [expandedInstance, setExpandedInstance] = useState<string | null>(null);
  const [instanceSteps, setInstanceSteps] = useState<Record<string, InstanceStep[]>>({});

  // When opened from the Visitors page ("Open Workflow"), jump straight to the
  // Active tab and expand that visitor's instance.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    const inst = params.get("instance");
    if (t === "active" || t === "steps" || t === "settings") setTab(t);
    if (inst) setExpandedInstance(inst);
  }, []);
  const [showStartModal, setShowStartModal] = useState(false);
  const [personSearch, setPersonSearch] = useState("");
  const [rosterPeople, setRosterPeople] = useState<RosterPerson[]>([]);
  const [startingId, setStartingId] = useState<string | null>(null);

  // Settings
  const [settings, setSettings] = useState<Partial<Workflow>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  useEffect(() => {
    if (!workflowId) return;
    getDoc(doc(db, "workflows", workflowId)).then((snap) => {
      if (snap.exists()) {
        const data = snap.data() as Workflow;
        setWorkflow(data);
        setSettings(data);
      }
      setLoading(false);
    });
  }, [workflowId]);

  // Live steps — no orderBy to avoid composite index; sort by .order client-side
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
          const data = d.data() as Omit<WorkflowStep, "id">;
          return { id: d.id, ...data, dependsOnStepIds: asStringArray(data.dependsOnStepIds) };
        })
        .sort((a, b) => a.order - b.order);
      setSteps(sorted);
    });
  }, [workflowId, tenantId]);

  // Live instances — no orderBy to avoid composite index; sort by startedAt client-side
  useEffect(() => {
    if (!workflowId || !tenantId) return;
    const q = query(
      collection(db, "workflow_instances"),
      where("tenantId", "==", tenantId),
      where("workflowId", "==", workflowId)
    );
    return onSnapshot(q, (snap) => {
      const sorted = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<WorkflowInstance, "id">) }))
        .sort((a, b) => {
          const ta = a.startedAt?.toMillis?.() ?? 0;
          const tb = b.startedAt?.toMillis?.() ?? 0;
          return tb - ta;
        });
      setInstances(sorted);
    });
  }, [workflowId, tenantId]);

  // Load roster for manual start
  useEffect(() => {
    if (!tenantId || !showStartModal) return;
    Promise.all([
      getDocs(query(collection(db, "visitors"), where("tenantId", "==", tenantId), orderBy("firstName"))),
      getDocs(query(collection(db, "members"), where("tenantId", "==", tenantId), orderBy("firstName"))),
    ]).then(([vSnap, mSnap]) => {
      const visitors: RosterPerson[] = vSnap.docs.map((d) => {
        const data = d.data();
        return { id: d.id, firstName: data.firstName || data.name?.split(" ")[0] || "", lastName: data.lastName || data.name?.split(" ").slice(1).join(" ") || "", cellphone: data.cellphone || data.phone, type: "visitor" as const };
      });
      const members: RosterPerson[] = mSnap.docs.map((d) => {
        const data = d.data();
        return { id: d.id, firstName: data.firstName, lastName: data.lastName, cellphone: data.cellphone || data.phone, type: "member" as const };
      });
      setRosterPeople([...visitors, ...members]);
    });
  }, [tenantId, showStartModal]);

  // Load instance steps when expanded
  useEffect(() => {
    if (!expandedInstance || instanceSteps[expandedInstance] || !tenantId) return;
    getDocs(
      query(
        collection(db, "workflow_instance_steps"),
        where("tenantId", "==", tenantId),
        where("instanceId", "==", expandedInstance),
        orderBy("stepOrder", "asc")
      )
    ).then((snap) => {
      setInstanceSteps((prev) => ({
        ...prev,
        [expandedInstance]: snap.docs.map((d) => {
          const data = d.data() as Omit<InstanceStep, "id">;
          return { id: d.id, ...data, dependsOnStepIds: asStringArray(data.dependsOnStepIds) };
        }),
      }));
    });
  }, [expandedInstance, instanceSteps, tenantId]);

  function addStep() {
    const lastOrder = steps.length > 0 ? Math.max(...steps.map((s) => s.order)) : 0;
    const tempId = `new_${generateId()}`;
    const newStep: WorkflowStep = {
      id: tempId,
      order: lastOrder + 1,
      delayDays: steps.length === 0 ? 0 : 3,
      actionType: "task",
      title: "Follow up",
      message: "",
      dependsOnStepIds: [],
    };
    setSteps([...steps, newStep]);
    setEditingStep(tempId);
  }

  function updateStep(id: string, changes: Partial<WorkflowStep>) {
    setSteps(steps.map((s) => (s.id === id ? { ...s, ...changes } : s)));
  }

  function removeStep(id: string) {
    setSteps(steps
      .filter((s) => s.id !== id)
      .map((s) => ({
        ...s,
        dependsOnStepIds: s.dependsOnStepIds.filter((stepId) => stepId !== id),
      })));
    if (editingStep === id) setEditingStep(null);
  }

  function moveStep(id: string, dir: "up" | "down") {
    const idx = steps.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const next = [...steps];
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    next.forEach((s, i) => (s.order = i + 1));
    setSteps([...next]);
  }

  async function saveSteps() {
    if (!workflowId || !tenantId) return;
    setSavingSteps(true);
    try {
      // Delete existing steps then recreate
      const existing = await getDocs(query(
        collection(db, "workflow_steps"),
        where("tenantId", "==", tenantId),
        where("workflowId", "==", workflowId)
      ));
      const batch = writeBatch(db);
      existing.docs.forEach((d) => batch.delete(d.ref));

      const orderedSteps = steps.map((step, i) => ({ ...step, order: i + 1 }));
      const stepRefs = orderedSteps.map(() => doc(collection(db, "workflow_steps")));
      const savedIdByLocalId = new Map(orderedSteps.map((step, i) => [step.id, stepRefs[i].id]));

      orderedSteps.forEach((step, i) => {
        const priorStepIds = new Set(orderedSteps.slice(0, i).map((s) => s.id));
        const dependsOnStepIds = step.dependsOnStepIds
          .filter((stepId) => priorStepIds.has(stepId))
          .map((stepId) => savedIdByLocalId.get(stepId))
          .filter((stepId): stepId is string => Boolean(stepId));

        const ref = stepRefs[i];
        batch.set(ref, {
          workflowId,
          tenantId,
          order: step.order,
          delayDays: step.delayDays,
          actionType: step.actionType,
          title: step.title,
          message: step.message,
          dependsOnStepIds,
        });
      });
      await batch.commit();
      await updateDoc(doc(db, "workflows", workflowId), {
        stepCount: steps.length,
        updatedAt: serverTimestamp(),
      });
      setStepsSaved(true);
      setTimeout(() => setStepsSaved(false), 2000);
    } finally {
      setSavingSteps(false);
    }
  }

  async function startWorkflow(person: RosterPerson) {
    if (!workflowId || !tenantId || steps.length === 0) return;
    setStartingId(person.id);
    try {
      const instanceRef = await addDoc(collection(db, "workflow_instances"), {
        workflowId,
        workflowName: workflow?.name || "",
        tenantId,
        subjectId: person.id,
        subjectName: `${person.firstName} ${person.lastName}`,
        subjectPhone: person.cellphone || "",
        subjectType: person.type,
        status: "active" as InstanceStatus,
        completedSteps: 0,
        totalSteps: steps.length,
        nextDueDate: addDays(steps[0]?.delayDays || 0),
        overdueCount: 0,
        dueTodayCount: 0,
        startedAt: serverTimestamp(),
      });

      const batch = writeBatch(db);
      const instanceStepRefs = steps.map(() => doc(collection(db, "workflow_instance_steps")));
      const instanceStepIdByTemplateId = new Map(steps.map((step, i) => [step.id, instanceStepRefs[i].id]));

      steps.forEach((step, i) => {
        const stepRef = instanceStepRefs[i];
        const dependsOnStepIds = step.dependsOnStepIds
          .map((stepId) => instanceStepIdByTemplateId.get(stepId))
          .filter((stepId): stepId is string => Boolean(stepId));

        batch.set(stepRef, {
          instanceId: instanceRef.id,
          workflowId,
          tenantId,
          stepId: step.id,
          stepOrder: step.order,
          actionType: step.actionType,
          title: step.title,
          message: step.message,
          dependsOnStepIds,
          dueDate: addDays(step.delayDays),
          status: "pending" as StepStatus,
        });
      });
      await batch.commit();

      await updateDoc(doc(db, "workflows", workflowId), {
        instanceCount: (workflow?.instanceCount || 0) + 1,
      });

      setShowStartModal(false);
      setPersonSearch("");
      setTab("active");
    } finally {
      setStartingId(null);
    }
  }

  // Keep the visitor's follow-up status in step with their workflow. When the
  // workflow for a visitor finishes, mark that guest as followed up so they drop
  // off the "Follow-Up Required" list and the dashboard pending widget. If the
  // workflow is reopened, put them back on the pending list.
  // Keep the person's own record in step with their workflow.
  //
  // Guests move in and out of "Follow-Up Required". Members on a care follow-up
  // stay on the Care Tier Alerts list while the workflow is running, and only
  // move to "Followed up" once it is completed. Marking them present clears the
  // tier on its own, since tiers are calculated from attendance.
  async function syncSubjectFollowUp(instanceId: string, completed: boolean) {
    const inst = instances.find((i) => i.id === instanceId);
    if (!inst || !inst.subjectId) return;

    if (inst.subjectType === "visitor") {
      try {
        await updateDoc(doc(db, "visitors", inst.subjectId), {
          followUpStatus: completed ? "done" : "pending",
          followedUpBy: appUser?.email || "Workflow",
          followedUpAt: completed ? serverTimestamp() : null,
        });
      } catch (err) {
        console.error("Could not sync visitor follow-up status:", err);
      }
      return;
    }

    if (inst.subjectType === "member" && inst.careTier !== undefined) {
      try {
        await updateDoc(doc(db, "members", inst.subjectId), {
          "careFollowUp.status": completed ? "completed" : "active",
          "careFollowUp.completedAt": completed ? serverTimestamp() : null,
        });
      } catch (err) {
        console.error("Could not sync care follow-up status:", err);
      }
    }
  }

  async function markStepDone(instanceId: string, instanceStepId: string, currentStatus: StepStatus) {
    const newStatus: StepStatus = currentStatus === "done" ? "pending" : "done";
    await updateDoc(doc(db, "workflow_instance_steps", instanceStepId), {
      status: newStatus,
      completedAt: newStatus === "done" ? serverTimestamp() : null,
    });
    // Refresh instance steps
    setInstanceSteps((prev) => ({
      ...prev,
      [instanceId]: (prev[instanceId] || []).map((s) =>
        s.id === instanceStepId ? { ...s, status: newStatus } : s
      ),
    }));
    // Update completed count
    const updated = (instanceSteps[instanceId] || []).map((s) =>
      s.id === instanceStepId ? { ...s, status: newStatus } : s
    );
    const completedCount = updated.filter((s) => s.status === "done" || s.status === "skipped").length;
    const allDone = completedCount === updated.length;
    await updateDoc(doc(db, "workflow_instances", instanceId), {
      completedSteps: completedCount,
      status: allDone ? "completed" : "active",
    });
    await syncSubjectFollowUp(instanceId, allDone);
  }

  async function completeInstance(instanceId: string) {
    await updateDoc(doc(db, "workflow_instances", instanceId), { status: "completed" });
    await syncSubjectFollowUp(instanceId, true);
  }

  // Reopen a completed workflow: put it back to active and return the guest to
  // the pending follow-up list.
  async function reopenInstance(instanceId: string) {
    await updateDoc(doc(db, "workflow_instances", instanceId), { status: "active" });
    await syncSubjectFollowUp(instanceId, false);
  }

  // Assign (or change) the DRI for a running workflow. onSnapshot refreshes the list.
  async function assignInstance(instanceId: string, uid: string) {
    const assignedToName = team.find((t) => t.uid === uid)?.name || "";
    await updateDoc(doc(db, "workflow_instances", instanceId), {
      assignedToUid: uid,
      assignedToName,
    });
    // Email the person now responsible for this workflow.
    if (uid) {
      const inst = instances.find((i) => i.id === instanceId);
      notifyAssignee({
        assigneeUid: uid,
        subjectName: inst?.subjectName || "",
        subjectPhone: inst?.subjectPhone,
        kind: "workflow",
      });
    }
  }

  async function saveSettings() {
    if (!workflowId) return;
    setSavingSettings(true);
    try {
      await updateDoc(doc(db, "workflows", workflowId), { ...settings, updatedAt: serverTimestamp() });
      setWorkflow({ ...workflow!, ...settings });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } finally {
      setSavingSettings(false);
    }
  }

  async function deleteWorkflow() {
    // Standard workflows are part of the system. They can be switched off but
    // never deleted, otherwise visitors, care alerts and new members would have
    // nothing to attach to.
    if ((workflow as any)?.isSystem) {
      alert("This is a standard Kereke Hub workflow, so it cannot be deleted. Untick \"Workflow is active\" if you do not want it running.");
      return;
    }
    if (!confirm(`Delete "${workflow?.name}"? This cannot be undone.`)) return;
    await deleteDoc(doc(db, "workflows", workflowId));
    router.push("/dashboard/workflows");
  }

  const today = new Date().toISOString().split("T")[0];
  const activeInstances = instances.filter((i) => i.status === "active");
  const completedInstances = instances.filter((i) => i.status === "completed");
  const filteredPeople = rosterPeople.filter((p) =>
    `${p.firstName} ${p.lastName}`.toLowerCase().includes(personSearch.toLowerCase())
  );
  const alreadyStarted = new Set(instances.map((i) => i.subjectId));

  // One card renderer used for BOTH active and completed instances, so a closed
  // workflow can be reopened to read its steps and notes. Completed cards show a
  // "Completed" badge and a "Reopen" action instead of "Mark Complete".
  const renderInstanceCard = (inst: WorkflowInstance) => {
    const isExpanded = expandedInstance === inst.id;
    const iSteps = instanceSteps[inst.id] || [];
    const pct = inst.totalSteps > 0 ? Math.round((inst.completedSteps / inst.totalSteps) * 100) : 0;
    const isDone = inst.status === "completed";

    return (
      <div key={inst.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div
          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50"
          onClick={() => setExpandedInstance(isExpanded ? null : inst.id)}
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-800">{inst.subjectName}</p>
            <div className="flex items-center gap-3 mt-1">
              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden max-w-[120px]">
                <div className={`h-full rounded-full ${isDone ? "bg-emerald-400" : "bg-emerald-500"}`} style={{ width: `${isDone ? 100 : pct}%` }} />
              </div>
              <span className="text-xs text-gray-400">{inst.completedSteps}/{inst.totalSteps} done</span>
            </div>
          </div>
          {isDone ? (
            <span className="shrink-0 text-xs px-2 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">Completed</span>
          ) : (
            <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${inst.assignedToName ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
              {inst.assignedToName ? inst.assignedToName : "No DRI"}
            </span>
          )}
          <span className="text-gray-400 text-xs">{isExpanded ? "▲" : "▼"}</span>
        </div>

        {isExpanded && (
          <div className="border-t border-gray-100 px-4 py-3 space-y-2 bg-gray-50/50">
            {/* DRI: who is accountable for this workflow */}
            <div className="flex items-center gap-2 pb-2 mb-1 border-b border-gray-100">
              <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">Responsible (DRI)</span>
              {canAssign ? (
                <select
                  value={inst.assignedToUid || ""}
                  onChange={(e) => assignInstance(inst.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="">Unassigned</option>
                  {assignableTeam.map((t) => (
                    <option key={t.uid} value={t.uid}>
                      {t.name}{t.isSelf ? " (You)" : ""}{t.visitorMinistry ? " (Follow-Up Team)" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={`text-xs font-medium ${inst.assignedToName ? "text-gray-700" : "text-red-500"}`}>
                  {inst.assignedToName || "Unassigned"}
                </span>
              )}
            </div>
            {iSteps.length === 0 && (
              <p className="text-xs text-gray-400">Loading steps...</p>
            )}
            {iSteps.map((s) => {
              const blockedBy = s.dependsOnStepIds
                .map((stepId) => iSteps.find((step) => step.id === stepId))
                .filter((step): step is InstanceStep => step !== undefined && step.status !== "done" && step.status !== "skipped");
              const isBlocked = s.status === "pending" && blockedBy.length > 0;

              return (
                <div key={s.id} className="flex items-start gap-3">
                  <button
                    onClick={() => markStepDone(inst.id, s.id, s.status)}
                    disabled={isBlocked}
                    title={isBlocked ? `Waiting for ${blockedBy.map((step) => step.title).join(", ")}` : undefined}
                    className={`mt-0.5 w-4 h-4 shrink-0 rounded border-2 flex items-center justify-center transition-colors ${
                      s.status === "done"
                        ? "bg-emerald-500 border-emerald-500"
                        : isBlocked
                        ? "border-gray-200 bg-gray-100 cursor-not-allowed"
                        : "border-gray-300 hover:border-emerald-400"
                    }`}
                  >
                    {s.status === "done" && <span className="text-white text-xs">✓</span>}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${s.status === "done" ? "line-through text-gray-400" : "text-gray-800"}`}>
                      {s.title}
                    </p>
                    <p className="text-xs text-gray-400">
                      {s.actionType === "whatsapp" && inst.subjectPhone ? (
                        <a
                          href={`https://wa.me/${(inst.subjectPhone || "").replace(/\D/g, "")}?text=${encodeURIComponent(s.message)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-emerald-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Open WhatsApp
                        </a>
                      ) : (
                        s.message
                      )}
                    </p>
                    {isBlocked && (
                      <p className="text-xs text-amber-600 mt-0.5">
                        Waiting for {blockedBy.map((step) => step.title).join(", ")}
                      </p>
                    )}
                    <p className={`text-xs mt-0.5 ${s.dueDate < today && s.status === "pending" ? "text-red-500 font-medium" : "text-gray-300"}`}>
                      Due {s.dueDate < today && s.status === "pending" ? "overdue · " : ""}{s.dueDate}
                    </p>
                  </div>
                  <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded-full ${actionStyle(s.actionType)}`}>
                    {actionIcon(s.actionType)}
                  </span>
                </div>
              );
            })}
            <div className="pt-3 border-t border-gray-100">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Notes</p>
              <NotesPanel
                parentPath={`workflow_instances/${inst.id}`}
                authorName={appUser?.displayName || appUser?.email || "Admin"}
                authorEmail={appUser?.email || ""}
                tenantId={tenantId || ""}
              />
              {isDone ? (
                <button
                  onClick={() => reopenInstance(inst.id)}
                  className="text-xs text-gray-500 hover:text-gray-800 font-medium mt-3"
                >
                  Reopen
                </button>
              ) : (
                <button
                  onClick={() => completeInstance(inst.id)}
                  className="text-xs text-gray-500 hover:text-gray-800 font-medium mt-3"
                >
                  Mark Complete
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!workflow) return <p className="text-gray-500">Workflow not found.</p>;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex gap-3 mb-1">
            <button onClick={() => router.push("/dashboard")} className="text-sm text-gray-500 hover:text-gray-800 block">
              ← Dashboard
            </button>
            <span className="text-gray-300">/</span>
            <button onClick={() => router.push("/dashboard/workflows")} className="text-sm text-gray-500 hover:text-gray-800 block">
              Workflows
            </button>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{workflow.name}</h1>
          <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
            <span>Trigger: {TRIGGER_LABELS[workflow.trigger]}</span>
            <span>· {steps.length} steps</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              workflow.active ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
            }`}>
              {workflow.active ? "Active" : "Inactive"}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {(["steps", "active", "settings"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === t ? "border-emerald-500 text-emerald-600" : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {t}
            {t === "active" && (
              <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">
                {activeInstances.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* STEPS TAB */}
      {tab === "steps" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">
              Define the sequence of actions. Each step has a delay from the workflow start date.
            </p>
            <button
              onClick={saveSteps}
              disabled={savingSteps}
              className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors"
            >
              {savingSteps ? "Saving..." : stepsSaved ? "Saved!" : "Save Steps"}
            </button>
          </div>

          {steps.length === 0 && (
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center text-sm text-gray-400 mb-4">
              No steps yet. Add your first step below.
            </div>
          )}

          <div className="space-y-2 mb-4">
            {steps.map((step, idx) => (
              <div
                key={step.id}
                className={`bg-white border rounded-xl overflow-hidden transition-all ${
                  editingStep === step.id ? "border-emerald-400 shadow-sm" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                {/* Step header */}
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                  onClick={() => setEditingStep(editingStep === step.id ? null : step.id)}
                >
                  <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-xs font-bold flex items-center justify-center shrink-0">
                    {idx + 1}
                  </span>
                  <span className="text-sm">{actionIcon(step.actionType)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{step.title}</p>
                    <p className="text-xs text-gray-400">
                      {step.delayDays === 0 ? "Same day" : `Day ${step.delayDays}`}
                      <span className={`ml-2 px-1.5 py-0.5 rounded-full text-xs font-medium ${actionStyle(step.actionType)}`}>
                        {actionLabel(step.actionType)}
                      </span>
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); moveStep(step.id, "up"); }} disabled={idx === 0} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30">↑</button>
                    <button onClick={(e) => { e.stopPropagation(); moveStep(step.id, "down"); }} disabled={idx === steps.length - 1} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30">↓</button>
                    <button onClick={(e) => { e.stopPropagation(); removeStep(step.id); }} className="p-1 text-red-400 hover:text-red-600 ml-1">✕</button>
                  </div>
                </div>

                {/* Step editor */}
                {editingStep === step.id && (
                  <div className="border-t border-gray-100 px-4 py-4 space-y-3 bg-gray-50/50">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Step Title</label>
                        <input
                          type="text"
                          value={step.title}
                          onChange={(e) => updateStep(step.id, { title: e.target.value })}
                          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Delay (days from start)
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={step.delayDays}
                          onChange={(e) => updateStep(step.id, { delayDays: Number(e.target.value) })}
                          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-2">Action Type</label>
                      <div className="flex gap-2 flex-wrap">
                        {ACTION_TYPES.map((a) => (
                          <button
                            key={a.value}
                            onClick={() => updateStep(step.id, { actionType: a.value })}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                              step.actionType === a.value
                                ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                : "border-gray-200 text-gray-600 hover:border-gray-300"
                            }`}
                          >
                            <span>{a.icon}</span> {a.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Message / Instructions
                        {step.actionType === "whatsapp" && (
                          <span className="text-gray-400 font-normal ml-1">(will be pre-filled in WhatsApp)</span>
                        )}
                      </label>
                      <textarea
                        value={step.message}
                        onChange={(e) => updateStep(step.id, { message: e.target.value })}
                        rows={3}
                        placeholder={
                          step.actionType === "task"
                            ? "What should the team member do?"
                            : step.actionType === "whatsapp"
                            ? "Hi [Name], we'd love to have you back this Sunday..."
                            : step.actionType === "email"
                            ? "Email message content..."
                            : "Internal note..."
                        }
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
                      />
                    </div>
                    {idx > 0 && (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-2">Depends on</label>
                        <div className="flex flex-wrap gap-2">
                          {steps.slice(0, idx).map((candidate, candidateIdx) => {
                            const checked = step.dependsOnStepIds.includes(candidate.id);
                            return (
                              <label
                                key={candidate.id}
                                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                                  checked
                                    ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    const nextIds = e.target.checked
                                      ? [...step.dependsOnStepIds, candidate.id]
                                      : step.dependsOnStepIds.filter((stepId) => stepId !== candidate.id);
                                    updateStep(step.id, { dependsOnStepIds: nextIds });
                                  }}
                                  className="w-3.5 h-3.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                />
                                <span>{candidateIdx + 1}. {candidate.title || "Untitled step"}</span>
                              </label>
                            );
                          })}
                        </div>
                        <p className="text-xs text-gray-400 mt-1.5">Leave blank to let this step become available by date.</p>
                      </div>
                    )}
                  </div>
                )}
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

      {/* ACTIVE TAB */}
      {tab === "active" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">
              {activeInstances.length} active · {completedInstances.length} completed
            </p>
            <button
              onClick={() => setShowStartModal(true)}
              disabled={steps.length === 0}
              title={steps.length === 0 ? "Add steps first" : undefined}
              className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              + Start for Someone
            </button>
          </div>

          {instances.length === 0 && (
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-12 text-center text-sm text-gray-400">
              No active workflows yet. Start one for a visitor or member.
            </div>
          )}

          {/* Active instances */}
          {activeInstances.length > 0 && (
            <div className="space-y-2 mb-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">Active</p>
              {activeInstances.map((inst) => renderInstanceCard(inst))}
            </div>
          )}

          {/* Completed instances — expandable so admins can reopen and read the
              steps and notes after a workflow is closed. */}
          {completedInstances.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">Completed</p>
              {completedInstances.map((inst) => renderInstanceCard(inst))}
            </div>
          )}

          {/* Start for someone modal */}
          {showStartModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 flex flex-col max-h-[80vh]">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">Start Workflow For...</h2>
                  <button onClick={() => { setShowStartModal(false); setPersonSearch(""); }} className="text-gray-400 hover:text-gray-700">✕</button>
                </div>
                <input
                  type="text"
                  value={personSearch}
                  onChange={(e) => setPersonSearch(e.target.value)}
                  placeholder="Search visitors or members..."
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-3"
                  autoFocus
                />
                <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
                  {filteredPeople.length === 0 && (
                    <p className="text-sm text-gray-400 py-4 text-center">No people found.</p>
                  )}
                  {filteredPeople.map((p) => {
                    const started = alreadyStarted.has(p.id);
                    return (
                      <div key={p.id} className="flex items-center justify-between py-2.5">
                        <div>
                          <p className="text-sm font-medium text-gray-800">{p.firstName} {p.lastName}</p>
                          <p className="text-xs text-gray-400 capitalize">{p.type}</p>
                        </div>
                        {started ? (
                          <span className="text-xs text-gray-400">Already running</span>
                        ) : (
                          <button
                            onClick={() => startWorkflow(p)}
                            disabled={startingId === p.id}
                            className="text-xs font-semibold bg-emerald-50 hover:bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {startingId === p.id ? "Starting..." : "Start"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={() => { setShowStartModal(false); setPersonSearch(""); }}
                  className="mt-4 w-full border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SETTINGS TAB */}
      {tab === "settings" && (
        <div className="max-w-xl">
          <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Workflow Name</label>
              <input
                type="text"
                value={settings.name || ""}
                onChange={(e) => setSettings({ ...settings, name: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={settings.description || ""}
                onChange={(e) => setSettings({ ...settings, description: e.target.value })}
                rows={2}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Trigger</label>
              <select
                value={settings.trigger || "manual"}
                onChange={(e) => setSettings({ ...settings, trigger: e.target.value as TriggerType })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {Object.entries(TRIGGER_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.active ?? true}
                onChange={(e) => setSettings({ ...settings, active: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-sm text-gray-700">Workflow is active</span>
            </label>
            <div className="flex gap-3 pt-2 border-t border-gray-100">
              <button
                onClick={saveSettings}
                disabled={savingSettings}
                className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors"
              >
                {savingSettings ? "Saving..." : settingsSaved ? "Saved!" : "Save Changes"}
              </button>
              {(workflow as any)?.isSystem ? (
                <span className="text-xs text-gray-400 ml-auto self-center">
                  Standard workflow. It can be switched off but not deleted.
                </span>
              ) : (
                <button
                  onClick={deleteWorkflow}
                  className="text-sm text-red-500 hover:text-red-700 font-medium ml-auto"
                >
                  Delete Workflow
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Route to the right view by mode. Checklist workflows (dateless, recurring SOPs)
// have a completely different lifecycle from automated sequences, so they render
// their own component. Reading the mode first also keeps a cell leader off the
// sequence code path, which subscribes to instances they cannot read.
export default function WorkflowDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [mode, setMode] = useState<"sequence" | "checklist" | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!workflowId) return;
    getDoc(doc(db, "workflows", workflowId))
      .then((snap) => setMode((snap.data()?.mode as "checklist" | "sequence") || "sequence"))
      .catch(() => setMode("sequence"))
      .finally(() => setReady(true));
  }, [workflowId]);

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (mode === "checklist") return <ChecklistWorkflowView workflowId={workflowId} />;
  return <SequenceWorkflowBuilder />;
}
