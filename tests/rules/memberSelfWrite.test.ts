// Member self-writes and tenant settings documents.
//
// A congregation member may update a short list of their own contact
// details from the member portal, and nothing else. The base rule let them
// change any field on their own record, including status, branch and church
// role. The negative tests here name those paths.

import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { createEnv, dbAs, seed, TENANT_A } from "./setup";

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

describe("members writing their own member record", () => {
  it("allows the contact fields the member portal saves", async () => {
    await assertSucceeds(
      updateDoc(doc(dbAs(env, "memberA"), "members", "memberOfA"), {
        phone: "27830000000",
        address: "1 Test Street",
        dateOfBirth: "1990-01-01",
        gender: "Female",
      })
    );
  });

  for (const [field, value] of Object.entries({
    status: "inactive",
    branch: "North",
    cellRegion: "Cell 1",
    churchRole: "Elder",
    membershipType: "Full Active",
    role: "Pastor",
    fullName: "Someone Else",
    portalStatus: "active",
  })) {
    it(`denies a member changing their own ${field}`, async () => {
      await assertFails(updateDoc(doc(dbAs(env, "memberA"), "members", "memberOfA"), { [field]: value }));
    });
  }

  it("denies a member detaching their record from their login", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "memberA"), "members", "memberOfA"), { authUid: "someoneElse" }));
  });

  it("denies a member moving their record to another tenant", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "memberA"), "members", "memberOfA"), { tenantId: "tenantB" }));
  });

  it("denies a member writing someone else's record", async () => {
    await assertFails(updateDoc(doc(dbAs(env, "memberA"), "members", "otherMemberOfA"), { phone: "27830000000" }));
  });

  it("still lets an owner edit any member field", async () => {
    await assertSucceeds(updateDoc(doc(dbAs(env, "ownerA"), "members", "memberOfA"), { status: "inactive", branch: "North" }));
  });
});

describe("tenant settings documents", () => {
  it("lets an admin save the member form configuration", async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(env, "adminA"), "tenants", TENANT_A, "settings", "formConfig"), { member: { fields: {} } }, { merge: true })
    );
  });

  it("lets team members of the same tenant read it (roster, visitors)", async () => {
    await assertSucceeds(getDoc(doc(dbAs(env, "cellLeaderA"), "tenants", TENANT_A, "settings", "formConfig")));
  });

  it("denies a member or cell leader changing it", async () => {
    await assertFails(setDoc(doc(dbAs(env, "memberA"), "tenants", TENANT_A, "settings", "formConfig"), { member: {} }));
    await assertFails(setDoc(doc(dbAs(env, "cellLeaderA"), "tenants", TENANT_A, "settings", "formConfig"), { member: {} }));
  });

  it("denies another tenant reading or writing it", async () => {
    await assertFails(getDoc(doc(dbAs(env, "ownerB"), "tenants", TENANT_A, "settings", "formConfig")));
    await assertFails(setDoc(doc(dbAs(env, "ownerB"), "tenants", TENANT_A, "settings", "formConfig"), { member: {} }));
  });

  it("denies writing a settings document that is not on the list", async () => {
    await assertFails(setDoc(doc(dbAs(env, "ownerA"), "tenants", TENANT_A, "settings", "whatsapp"), { bannerUrl: "x" }));
  });
});
