// Tenant document and cross-tenant isolation rules.
//
// The negative tests are the point of this file. Each one names a real attack
// path, and must fail with permission denied. Do not delete or weaken one to
// make a rules change pass: fix the rule instead.

import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { createEnv, dbAs, seed, TENANT_A, TENANT_B, TENANT_DOC } from "./setup";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createEnv();
});

beforeEach(async () => {
  await seed(env);
});

afterAll(async () => {
  await env.cleanup();
});

describe("tenant creation", () => {
  // The privilege escalation inherited from Kereke Hub: a self-registered user
  // writes tenants/{theirUid} with accountType "internal", and the /api/admin
  // routes then treat them as a platform admin.
  it("denies a signed-in stranger creating their own tenant as internal", async () => {
    await assertFails(
      setDoc(doc(dbAs(env, "stranger"), "tenants", "stranger"), {
        ...TENANT_DOC,
        accountType: "internal",
      })
    );
  });

  it("denies a signed-in stranger creating any tenant at all", async () => {
    await assertFails(setDoc(doc(dbAs(env, "stranger"), "tenants", "stranger"), TENANT_DOC));
  });

  it("denies an existing owner creating a second tenant", async () => {
    await assertFails(setDoc(doc(dbAs(env, "ownerA"), "tenants", "newTenant"), TENANT_DOC));
  });

  it("denies an unauthenticated caller creating a tenant", async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(anon, "tenants", "anon"), TENANT_DOC));
  });
});

describe("tenant billing and status fields are server-only", () => {
  // Each of these is written only by the Admin SDK (signup, PayFast ITN,
  // dunning, super-admin routes). An owner or admin setting them directly
  // could unlock paid features, skip billing, lift a suspension, or mark
  // their church as an internal account.
  //
  // Every value must DIFFER from TENANT_DOC in setup.ts. The rule checks
  // changed keys, so writing a field's current value is allowed by design and
  // a test using it would prove nothing.
  const protectedChanges: Record<string, unknown> = {
    accountType: "internal",
    tier: "paid",
    memberLimit: null,
    activeMemberCount: 0,
    billingPhase: "active",
    currentRate: 999,
    status: "trial",
    suspendedReason: null,
    pastDueSince: null,
    billingHold: true,
    grandfathered: true,
    trialEndsAt: "2099-01-01T00:00:00.000Z",
    fullRateStartsAt: "2099-01-01T00:00:00.000Z",
    plan: "enterprise",
    slug: "taken-by-someone-else",
    orgId: "someOrg",
    orgRole: "hq",
  };

  for (const [field, value] of Object.entries(protectedChanges)) {
    it(`denies an owner changing ${field}`, async () => {
      await assertFails(updateDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_A), { [field]: value }));
    });

    it(`denies an admin changing ${field}`, async () => {
      await assertFails(updateDoc(doc(dbAs(env, "adminA"), "tenants", TENANT_A), { [field]: value }));
    });
  }

  it("denies sneaking a protected field in alongside an allowed one", async () => {
    await assertFails(
      updateDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_A), {
        name: "Renamed",
        tier: "paid",
      })
    );
  });

  it("denies an owner lifting their own suspension", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "tenants", TENANT_A), {
        status: "suspended",
        suspendedReason: "billing_auto",
      });
    });
    await assertFails(
      updateDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_A), { status: "active", suspendedReason: null })
    );
  });

  it("allows writing a protected field with its unchanged value", async () => {
    // Documents the deliberate diff() behaviour so nobody "fixes" it by accident.
    await assertSucceeds(
      updateDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_A), { name: "Renamed", tier: "free" })
    );
  });

  it("allows a super admin to change billing fields", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(env, "superAdmin"), "tenants", TENANT_A), { tier: "paid", memberLimit: null })
    );
  });
});

describe("tenant profile edits still work", () => {
  // Guards against the lockdown breaking existing screens: Branding, Church
  // Profile and Roster > Configure Lists all write these fields directly.
  it("allows an owner to update branding", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_A), {
        name: "Region A Renamed",
        primaryColor: "#123456",
        logoUrl: "https://example.test/logo.png",
      })
    );
  });

  it("allows an admin to update configurable lists", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(env, "adminA"), "tenants", TENANT_A), {
        branches: ["North", "South"],
        cellRegions: ["Cell 1"],
        ministries: ["Ushering"],
      })
    );
  });

  it("allows an owner to update service sessions and tracking start date", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_A), {
        serviceSessions: [{ id: "sun", day: "Sunday", name: "Main Service" }],
        trackingStartDate: "2026-01-01",
      })
    );
  });

  it("allows an owner to save banking details, whose nested accountType is a bank account type", async () => {
    // Branding writes bankingDetails.accountType ("Cheque/Current"). The rule
    // only inspects top-level keys, so this must not trip the accountType guard.
    await assertSucceeds(
      updateDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_A), {
        bankingDetails: { bankName: "Test Bank", accountType: "Cheque/Current" },
      })
    );
  });

  it("allows an admin to update class types", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(env, "adminA"), "tenants", TENANT_A), {
        classTypes: [{ id: "membership", name: "Membership" }],
      })
    );
  });

  it("denies a congregation member editing the tenant profile", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "memberA"), "tenants", TENANT_A), { name: "Hijacked" }));
  });
});

describe("cross-tenant isolation", () => {
  it("denies an owner reading another tenant's document", async () => {
    await assertFails(getDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_B)));
  });

  it("denies an owner updating another tenant's document", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_B), { name: "Hijacked" }));
  });

  it("denies an owner reading a member in another tenant", async () => {
    await assertFails(getDoc(doc(dbAs(env, "ownerA"), "members", "memberOfB")));
  });

  it("denies a stranger reading any tenant", async () => {
    await assertFails(getDoc(doc(dbAs(env, "stranger"), "tenants", TENANT_A)));
  });

  it("denies a stranger reading any member", async () => {
    await assertFails(getDoc(doc(dbAs(env, "stranger"), "members", "memberOfA")));
  });

  it("allows an owner to read their own tenant and members", async () => {
    await assertSucceeds(getDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_A)));
    await assertSucceeds(getDoc(doc(dbAs(env, "ownerA"), "members", "memberOfA")));
  });
});

describe("user documents cannot be used to escalate", () => {
  it("denies a user creating their own users doc as super admin", async () => {
    await assertFails(
      setDoc(doc(dbAs(env, "stranger"), "users", "stranger"), { role: "super_admin", status: "active" })
    );
  });

  it("denies a user changing their own role", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "memberA"), "users", "memberA"), { role: "owner" }));
  });

  it("denies a user moving themselves into another tenant", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "ownerA"), "users", "ownerA"), { tenantId: TENANT_B }));
  });

  // The owner "manage team" path in the base rules placed no limit on the new
  // document, so an owner could promote themselves to platform super admin or
  // move any account into another church's tenant.
  it("denies an owner promoting themselves to super admin", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "ownerA"), "users", "ownerA"), { role: "super_admin" }));
  });

  it("denies an owner adding super_admin to their roles array", async () => {
    await assertFails(
      updateDoc(doc(dbAs(env, "ownerA"), "users", "ownerA"), { roles: ["owner", "super_admin"] })
    );
  });

  it("denies an owner promoting a team member to super admin", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "ownerA"), "users", "adminA"), { role: "super_admin" }));
  });

  it("denies an owner moving a team member into another tenant", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "ownerA"), "users", "adminA"), { tenantId: TENANT_B }));
  });

  it("allows an owner to change a team member's role within their tenant", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(env, "ownerA"), "users", "adminA"), {
        role: "branch_admin",
        assignedBranch: "North",
      })
    );
  });
});
