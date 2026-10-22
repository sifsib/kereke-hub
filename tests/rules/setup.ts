// Shared harness for the Firestore rules tests.
//
// Loads the real firestore.rules from the repo root and seeds a small world of
// two tenants (A and B) plus users in different roles. The `demo-` project id
// means the emulator never talks to a real Firebase project.

import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";

export const PROJECT_ID = "demo-kereke-rules";

export const TENANT_A = "tenantA";
export const TENANT_B = "tenantB";

// uid -> users/{uid} document
export const USERS = {
  ownerA: { role: "owner", tenantId: TENANT_A, status: "active" },
  adminA: { role: "admin", tenantId: TENANT_A, status: "active" },
  memberA: { role: "congregation_member", tenantId: TENANT_A, status: "active" },
  ownerB: { role: "owner", tenantId: TENANT_B, status: "active" },
  // Created by /api/login for anyone who signs in without an invite.
  // Has no tenant of their own.
  stranger: { role: "user", status: "active" },
  superAdmin: { role: "super_admin", status: "active" },
} as const;

export type SeededUid = keyof typeof USERS;

export const TENANT_DOC = {
  name: "Test Region",
  accountType: "standard",
  status: "active",
  tier: "free",
  memberLimit: 50,
  activeMemberCount: 10,
  billingPhase: "free",
  currentRate: 0,
};

export async function createEnv(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
    },
  });
}

export async function seed(env: RulesTestEnvironment): Promise<void> {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [uid, data] of Object.entries(USERS)) {
      await setDoc(doc(db, "users", uid), data);
    }
    await setDoc(doc(db, "tenants", TENANT_A), { ...TENANT_DOC, name: "Region A" });
    await setDoc(doc(db, "tenants", TENANT_B), { ...TENANT_DOC, name: "Region B" });
    await setDoc(doc(db, "members", "memberOfA"), {
      tenantId: TENANT_A,
      fullName: "Test Person A",
      status: "active",
    });
    await setDoc(doc(db, "members", "memberOfB"), {
      tenantId: TENANT_B,
      fullName: "Test Person B",
      status: "active",
    });
  });
}

export function dbAs(env: RulesTestEnvironment, uid: SeededUid) {
  return env.authenticatedContext(uid).firestore();
}
