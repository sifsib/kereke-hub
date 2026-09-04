"use client";

// Helpers for working out who can carry a follow-up.
//
// ANYONE on the team can be assigned a follow-up. Use getAssignableUsers() to
// populate assignee dropdowns.
//
// The "Follow-Up Team" toggle (visitorMinistry === true on the user doc, set on
// the Team page) no longer restricts who you may pick. It now only decides who
// the system auto-assigns to when nobody was chosen by hand, via
// getVisitorMinistryUsers() + pickLeastLoadedAssignee(). If no one is flagged,
// auto-assign falls back to the whole team.

import { auth, db } from "./firebase";
import { collection, getDocs, query, where } from "firebase/firestore";

export interface MinistryUser {
  uid: string;
  name: string;
  email: string;
  onFollowUpTeam?: boolean;
  isSelf?: boolean;
}

// Every active team member, so any of them can be put on a follow-up. The
// Follow-Up Team flag comes back with each person purely so the UI can label
// them, not to filter anyone out.
export async function getAssignableUsers(tenantId: string): Promise<MinistryUser[]> {
  const me = auth.currentUser;
  const snap = await getDocs(query(collection(db, "users"), where("tenantId", "==", tenantId)));

  const list = snap.docs
    .filter((d) => (d.data().status || "active") !== "inactive")
    // Congregants with a login are not staff, so they are not assignable. The
    // owner and every other team role IS, including yourself.
    .filter((d) => d.data().role !== "congregation_member")
    .map((d) => {
      const x = d.data();
      return {
        uid: d.id,
        // Owners often have no displayName on their user doc, which used to make
        // them show up as a bare email address and look "missing" in the list.
        name: x.displayName || x.name || x.email || "Unnamed",
        email: x.email || "",
        onFollowUpTeam: x.visitorMinistry === true || x.role === "follow_up",
        isSelf: !!me && d.id === me.uid,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Belt and braces: you must always be able to put a job on yourself, even if
  // your own user doc is missing or shaped oddly.
  if (me && !list.some((u) => u.uid === me.uid)) {
    list.unshift({
      uid: me.uid,
      name: me.displayName || me.email || "Me",
      email: me.email || "",
      onFollowUpTeam: false,
      isSelf: true,
    });
  }

  return list;
}

// The Follow-Up Team: anyone switched on with the toggle (visitorMinistry ===
// true) PLUS anyone whose main role is the dedicated follow_up role. Two queries
// merged by uid, since Firestore can't OR across two different fields in one
// query.
//
// Only used to decide who AUTO-assignment rotates through. It does not limit
// who an admin can pick by hand, that is getAssignableUsers().
export async function getVisitorMinistryUsers(tenantId: string): Promise<MinistryUser[]> {
  const [flaggedSnap, roleSnap] = await Promise.all([
    getDocs(
      query(
        collection(db, "users"),
        where("tenantId", "==", tenantId),
        where("visitorMinistry", "==", true)
      )
    ),
    getDocs(
      query(
        collection(db, "users"),
        where("tenantId", "==", tenantId),
        where("role", "==", "follow_up")
      )
    ),
  ]);

  const byUid: Record<string, MinistryUser> = {};
  [...flaggedSnap.docs, ...roleSnap.docs].forEach((d) => {
    if ((d.data().status || "active") === "inactive") return;
    if (byUid[d.id]) return;
    const x = d.data();
    byUid[d.id] = { uid: d.id, name: x.displayName || x.email || "Unnamed", email: x.email || "" };
  });
  return Object.values(byUid);
}

// Pick the ministry member currently carrying the fewest active workflow
// instances, so auto-assignment rotates fairly. Returns null if nobody is in
// the ministry yet (caller should then leave the item unassigned).
export async function pickLeastLoadedAssignee(
  tenantId: string,
  users: MinistryUser[]
): Promise<MinistryUser | null> {
  if (users.length === 0) return null;
  if (users.length === 1) return users[0];

  const snap = await getDocs(
    query(
      collection(db, "workflow_instances"),
      where("tenantId", "==", tenantId),
      where("status", "==", "active")
    )
  );

  const load: Record<string, number> = {};
  users.forEach((u) => (load[u.uid] = 0));
  snap.docs.forEach((d) => {
    const uid = d.data().assignedToUid;
    if (uid && uid in load) load[uid] += 1;
  });

  return users.reduce((best, u) => (load[u.uid] < load[best.uid] ? u : best), users[0]);
}

// Who should the system hand this to when nobody was picked by hand?
// The Follow-Up Team gets first refusal. If that team is empty, the whole team
// is fair game, so auto-assign never silently leaves a follow-up ownerless.
export async function pickAutoAssignee(tenantId: string): Promise<MinistryUser | null> {
  let pool = await getVisitorMinistryUsers(tenantId);
  if (pool.length === 0) pool = await getAssignableUsers(tenantId);
  return pickLeastLoadedAssignee(tenantId, pool);
}

// Fire-and-forget email to the assignee. Never throws; assignment must succeed
// even if the email can't be sent (e.g. Brevo not connected).
export async function notifyAssignee(payload: {
  assigneeUid: string;
  subjectName: string;
  subjectPhone?: string;
  kind?: "visitor" | "member" | "workflow" | "care";
  reason?: string;
  note?: string;
}): Promise<void> {
  try {
    await fetch("/api/notify-assignee", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // swallow — notification is best-effort
  }
}
