import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as nodemailer from "nodemailer";
import * as crypto from "crypto";

// ─────────────────────────────────────────────────────────────
// SYSTEM-LEVEL GMAIL SECRETS
// Set via: firebase functions:secrets:set SYSTEM_GMAIL_USER
//          firebase functions:secrets:set SYSTEM_GMAIL_APP_PASSWORD
// These are Kereke Hub's own support email credentials, separate
// from any individual church's SMTP config.
// ─────────────────────────────────────────────────────────────
const SYSTEM_GMAIL_USER = defineSecret("SYSTEM_GMAIL_USER");
const SYSTEM_GMAIL_APP_PASSWORD = defineSecret("SYSTEM_GMAIL_APP_PASSWORD");

initializeApp();
const db = getFirestore();

// ─────────────────────────────────────────────────────────────
// HELPER: Build a Nodemailer transporter from a tenant's SMTP
// credentials stored in Firestore under tenants/{tenantId}.smtpConfig
// ─────────────────────────────────────────────────────────────
async function getTransporter(tenantId: string) {
  const tenantSnap = await db.doc(`tenants/${tenantId}`).get();
  const smtpConfig = tenantSnap.data()?.smtpConfig;

  if (!smtpConfig?.gmailUser || !smtpConfig?.gmailAppPassword) {
    throw new Error(
      `Tenant ${tenantId} has no SMTP config. ` +
        "Add smtpConfig.gmailUser and smtpConfig.gmailAppPassword to the tenant document."
    );
  }

  return {
    transporter: nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: smtpConfig.gmailUser,
        pass: smtpConfig.gmailAppPassword,
      },
    }),
    tenantData: tenantSnap.data()!,
  };
}

// ─────────────────────────────────────────────────────────────
// TRIGGER 1: MEMBER WELCOME EMAIL + BREVO CONTACT SYNC
//
// Fires when a new document is created in /members/{memberId}.
//
// Behaviour:
//   a) If the tenant has Brevo configured (brevoApiKey):
//        - Adds the new member as a Brevo contact
//        - If brevoMailingListId is set, adds them to that list
//        - If brevoWelcomeTemplateId is set, sends the Brevo template
//   b) Falls back to Gmail SMTP welcome email if Brevo is not configured.
// ─────────────────────────────────────────────────────────────

// Helper: add a contact to Brevo + optionally send welcome template
async function brevoOnboardMember(
  apiKey: string,
  email: string,
  firstName: string,
  lastName: string,
  listId: number | null,
  welcomeTemplateId: string | null
) {
  // Create / update contact
  const contactBody: Record<string, any> = {
    email,
    attributes: { FIRSTNAME: firstName, LASTNAME: lastName },
    updateEnabled: true,
  };
  if (listId) contactBody.listIds = [listId];

  await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(contactBody),
  });

  // Send welcome template if configured
  if (welcomeTemplateId) {
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        to: [{ email, name: `${firstName} ${lastName}`.trim() }],
        templateId: Number(welcomeTemplateId),
        params: { FIRSTNAME: firstName, LASTNAME: lastName },
      }),
    });
  }
}

export const onMemberCreated = onDocumentCreated(
  "members/{memberId}",
  async (event) => {
    const member = event.data?.data();
    if (!member) return;

    const { tenantId, firstName, lastName, email } = member;

    if (!email || !tenantId) {
      console.log(`Member ${event.params.memberId} skipped — no email or tenantId.`);
      return;
    }

    try {
      const tenantSnap = await db.doc(`tenants/${tenantId}`).get();
      const tenantData = tenantSnap.data()!;
      const churchName = tenantData.name || "Our Church";

      const brevoApiKey: string | undefined = tenantData.brevoApiKey;
      const brevoListId: number | null = tenantData.brevoMailingListId ?? null;
      const brevoWelcomeTemplateId: string | null = tenantData.brevoWelcomeTemplateId || null;

      if (brevoApiKey) {
        // ── Brevo path: add to list + send template ────────────
        await brevoOnboardMember(
          brevoApiKey,
          email,
          firstName || member.fullName?.split(" ")[0] || "",
          lastName || member.fullName?.split(" ").slice(1).join(" ") || "",
          brevoListId,
          brevoWelcomeTemplateId
        );
        console.log(`[onMemberCreated] Brevo onboarding done for ${email}`);
      } else {
        // ── Fallback: Gmail SMTP welcome email ─────────────────
        const { transporter } = await getTransporter(tenantId);
        const fromAddress = tenantData.smtpConfig?.gmailUser;
        if (!fromAddress) return;

        await transporter.sendMail({
          from: `"${churchName}" <${fromAddress}>`,
          to: email,
          subject: `Welcome to ${churchName}, ${firstName}!`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 32px; border-radius: 8px;">
              <h2 style="color: #3B9A5F; margin-top: 0;">Welcome, ${firstName} ${lastName}!</h2>
              <p style="color: #F8FAFC;">You have been added to the <strong>${churchName}</strong> member directory on Kereke Hub.</p>
              <hr style="border-color: #3B9A5F; margin: 24px 0;" />
              <p style="color: #94A3B8; font-size: 12px; margin-bottom: 0;">This message was sent via Kereke Hub on behalf of ${churchName}.</p>
            </div>
          `,
        });
        console.log(`[onMemberCreated] SMTP welcome email sent to ${email}`);
      }
    } catch (err) {
      console.error(`[onMemberCreated] Error:`, err);
    }

    // ── Auto-provision member portal account ─────────────────
    // If the member has an email, create a Firebase Auth account and
    // send a portal invite so they can access their profile immediately.
    try {
      const memberId = event.params.memberId;
      const memberEmail = email.trim().toLowerCase();
      const auth = getAuth();
      const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
      const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://hub.kerekehub.co.za";
      const BREVO_API_KEY = process.env.BREVO_API_KEY || "";

      let authUid: string;
      let authAccountAlreadyExisted = false;
      try {
        const newUser = await auth.createUser({
          email: memberEmail,
          displayName: member.fullName || memberEmail,
          emailVerified: false,
          password: crypto.randomBytes(12).toString("base64") + "Kh1!",
        });
        authUid = newUser.uid;
      } catch (authErr: any) {
        if (authErr.code === "auth/email-already-exists") {
          const existingUser = await auth.getUserByEmail(memberEmail);
          authUid = existingUser.uid;
          authAccountAlreadyExisted = true;
        } else {
          throw authErr;
        }
      }

      // GUARD: never overwrite an account that already exists.
      // An owner or admin who adds their own name to the member roster shares
      // an email with their staff login, so this trigger lands on their
      // existing users doc. Writing role: "congregation_member" here used to
      // demote them out of the whole dashboard. If the profile is already
      // there, we only link the member record and stop.
      const existingUserRef = db.collection("users").doc(authUid);
      const existingUserSnap = await existingUserRef.get();

      if (existingUserSnap.exists) {
        const existingProfile = existingUserSnap.data() || {};
        const existingRole = existingProfile.role;
        if (!existingProfile.memberId) {
          await existingUserRef.update({ memberId });
        }
        // Staff logins are live accounts. A congregation account that is still
        // sitting on an unused invite stays marked as invited.
        const portalStatus =
          existingRole === "congregation_member" && existingProfile.status === "invited"
            ? "invited"
            : "active";
        await db.collection("members").doc(memberId).update({
          authUid,
          portalStatus,
          portalLinkedAt: new Date().toISOString(),
        });
        console.log(
          `[onMemberCreated] ${memberEmail} already has a Kereke Hub account (role: ${existingRole}). ` +
          `Linked the member profile, left the role untouched, no invite sent.`
        );
        return;
      }

      if (authAccountAlreadyExisted) {
        // Auth user exists with no users doc. Rare, but treat it as a fresh
        // portal account rather than assuming anything about the old account.
        console.log(`[onMemberCreated] Auth account existed for ${memberEmail} with no profile doc. Creating one.`);
      }

      // Write users doc for the congregation member
      await db.collection("users").doc(authUid).set({
        email: memberEmail,
        displayName: member.fullName || memberEmail,
        role: "congregation_member",
        tenantId,
        memberId,
        status: "invited",
        createdAt: new Date().toISOString(),
        invitedBy: "system",
      }, { merge: true });

      // Link auth account back to member doc
      await db.collection("members").doc(memberId).update({
        authUid,
        portalStatus: "invited",
        portalInvitedAt: new Date().toISOString(),
      });

      // Create invite token
      const inviteToken = crypto.randomUUID();
      await db.collection("invites").doc(inviteToken).set({
        uid: authUid,
        email: memberEmail,
        tenantId,
        memberId,
        type: "member",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + INVITE_EXPIRY_MS).toISOString(),
        used: false,
      });

      // Send invite email via Brevo if key is available
      if (BREVO_API_KEY) {
        const inviteUrl = `${APP_URL}/member/setup?token=${inviteToken}`;
        const tenantSnap2 = await db.doc(`tenants/${tenantId}`).get();
        const churchName2 = tenantSnap2.data()?.name || "your church";
        const recipientName = member.fullName || memberEmail;

        await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "api-key": BREVO_API_KEY,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            sender: { name: "Kereke Hub", email: process.env.BREVO_SENDER_EMAIL || "noreply@kerekehub.co.za" },
            to: [{ email: memberEmail, name: recipientName }],
            subject: `${churchName2} has set up your member profile`,
            htmlContent: `<p>Hi ${recipientName},</p><p>${churchName2} has created your member portal account on Kereke Hub. <a href="${inviteUrl}">Click here to set your password and access your profile</a>. This link expires in 7 days.</p><p>Powered by Kereke Hub &mdash; kerekehub.co.za</p>`,
          }),
        });
      }

      console.log(`[onMemberCreated] Portal account provisioned for ${memberEmail}`);
    } catch (portalErr) {
      // Non-fatal — log but don't fail the function
      console.error(`[onMemberCreated] Portal provisioning error:`, portalErr);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// TRIGGER 2: COMMUNICATIONS BROADCAST
//
// Fires when a new document is created in /communications/{docId}.
// The admin creates the document from the hub UI with status: "pending".
// This function sends the message to all listed member IDs via BCC,
// then updates the document status to "sent" or "failed".
//
// Required fields on the communications document:
//   - tenantId      (string)
//   - subject       (string)
//   - body          (string — HTML is supported)
//   - recipientIds  (string[] — array of member document IDs)
//   - status        (string — must be "pending" to trigger send)
//
// Written back by this function:
//   - status        → "processing" | "sent" | "failed"
//   - startedAt     → Timestamp
//   - sentAt        → Timestamp
//   - recipientCount → number
//   - error         → string (on failure only)
// ─────────────────────────────────────────────────────────────
export const onCommunicationCreated = onDocumentCreated(
  "communications/{docId}",
  async (event) => {
    const comm = event.data?.data();
    if (!comm) return;

    const { tenantId, subject, body, recipientIds, status } = comm;

    // Guard: only process documents explicitly marked as pending
    if (status !== "pending") return;

    if (!tenantId || !subject || !body || !Array.isArray(recipientIds) || !recipientIds.length) {
      console.error(
        `[onCommunicationCreated] Document ${event.params.docId} is missing required fields.`
      );
      return;
    }

    const docRef = db.doc(`communications/${event.params.docId}`);

    // Mark processing immediately to prevent duplicate sends on retries
    await docRef.update({ status: "processing", startedAt: new Date() });

    try {
      // Fetch all recipient member documents in parallel
      const memberFetches = (recipientIds as string[]).map((id) =>
        db.doc(`members/${id}`).get()
      );
      const memberSnaps = await Promise.all(memberFetches);

      const emails = memberSnaps
        .filter((snap) => snap.exists && snap.data()?.email)
        .map((snap) => snap.data()!.email as string);

      if (!emails.length) {
        await docRef.update({ status: "failed", error: "No valid recipient email addresses found." });
        return;
      }

      const { transporter, tenantData } = await getTransporter(tenantId);
      const churchName = tenantData.name || "Our Church";
      const fromAddress = tenantData.smtpConfig.gmailUser;

      // Send as BCC so recipient addresses remain private from each other
      await transporter.sendMail({
        from: `"${churchName}" <${fromAddress}>`,
        bcc: emails,
        subject,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 32px; border-radius: 8px;">
            ${body}
            <hr style="border-color: #3B9A5F; margin: 24px 0;" />
            <p style="color: #94A3B8; font-size: 12px; margin-bottom: 0;">
              Sent via Kereke Hub on behalf of ${churchName}.
            </p>
          </div>
        `,
      });

      await docRef.update({
        status: "sent",
        sentAt: new Date(),
        recipientCount: emails.length,
      });

      console.log(
        `[onCommunicationCreated] Broadcast ${event.params.docId} sent to ${emails.length} recipients.`
      );
    } catch (err: any) {
      console.error(`[onCommunicationCreated] Broadcast failed:`, err);
      await docRef.update({ status: "failed", error: err.message });
    }
  }
);


// ─────────────────────────────────────────────────────────────
// TRIGGER 3: SELF-SERVICE SIGNUP WELCOME EMAIL
//
// Fires when a new document is created in /signups/{signupId}.
// Actions:
//   1. Sends a welcome email to the new church admin
//   2. Notifies Sifiso of the new signup
//   3. Updates the signup document status to "welcome_sent"
// ─────────────────────────────────────────────────────────────
export const onSignupCreated = onDocumentCreated(
  {
    document: "signups/{signupId}",
    secrets: [SYSTEM_GMAIL_USER, SYSTEM_GMAIL_APP_PASSWORD],
  },
  async (event) => {
    const signup = event.data?.data();
    if (!signup) return;

    if (signup.source !== "self_service") return;
    if (signup.status !== "pending_welcome") return;

    const signupId = event.params.signupId;
    const gmailUser = SYSTEM_GMAIL_USER.value();
    const gmailPass = SYSTEM_GMAIL_APP_PASSWORD.value();

    if (!gmailUser || !gmailPass) {
      console.error("[onSignupCreated] System Gmail secrets not configured.");
      return;
    }

    const { churchName, adminName, email, accountType = "standard" } = signup;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });

    const hubLoginUrl = "https://hub.kerekehub.co.za/login";

    const billingBlock = (() => {
      if (accountType === "internal") {
        return `
          <div style="background: #1E293B; border-radius: 8px; padding: 20px; margin: 24px 0; border-left: 4px solid #3B9A5F;">
            <p style="color: #3B9A5F; font-weight: bold; font-size: 16px; margin: 0 0 4px 0;">Internal Account</p>
            <p style="color: #94A3B8; font-size: 14px; margin: 0;">This account has free lifetime access to Kereke Hub.</p>
          </div>`;
      }
      if (accountType === "beta") {
        return `
          <div style="background: #1E293B; border-radius: 8px; padding: 20px; margin: 24px 0; border-left: 4px solid #A78BFA;">
            <p style="color: #A78BFA; font-weight: bold; font-size: 14px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.05em;">Beta Tester Access</p>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="color: #94A3B8; padding: 4px 0; width: 130px;">Months 1-4</td><td style="color: #F8FAFC; font-weight: bold;">FREE</td></tr>
              <tr><td style="color: #94A3B8; padding: 4px 0;">Month 5+</td><td style="color: #F8FAFC; font-weight: bold;">R159/mo</td></tr>
            </table>
            <p style="color: #94A3B8; font-size: 13px; margin: 12px 0 0 0;">
              You have 4 full months to explore everything. If you want to continue after that, you will join at the standard R159/mo rate.
            </p>
          </div>`;
      }
      return `
        <div style="background: #1E293B; border-radius: 8px; padding: 20px; margin: 24px 0; border-left: 4px solid #3B9A5F;">
          <p style="color: #3B9A5F; font-weight: bold; font-size: 14px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.05em;">Your Pricing</p>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="color: #94A3B8; padding: 4px 0; width: 130px;">Month 1</td><td style="color: #F8FAFC; font-weight: bold;">FREE - setup &amp; data migration</td></tr>
            <tr><td style="color: #94A3B8; padding: 4px 0;">Months 2-4</td><td style="color: #F8FAFC; font-weight: bold;">R99/mo - evaluation window</td></tr>
            <tr><td style="color: #94A3B8; padding: 4px 0;">Month 5+</td><td style="color: #F8FAFC; font-weight: bold;">R159/mo - full rate</td></tr>
          </table>
          <p style="color: #94A3B8; font-size: 13px; margin: 12px 0 0 0;">
            No payment is required right now. You will receive details on how to pay before your evaluation window closes.
          </p>
        </div>`;
    })();

    // ── 1. Welcome email to the new church admin ─────────────
    try {
      await transporter.sendMail({
        from: `"Kereke Hub" <${gmailUser}>`,
        to: email,
        subject: `Welcome to Kereke Hub, ${adminName}!`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 40px; border-radius: 10px;">
            <h2 style="color: #3B9A5F; margin-top: 0; font-size: 24px;">Welcome to Kereke Hub!</h2>
            <p style="color: #F8FAFC; font-size: 16px;">
              Hi ${adminName}, your church administration platform for
              <strong>${churchName}</strong> is ready to go.
            </p>
            ${billingBlock}
            <div style="background: #1E293B; border-radius: 8px; padding: 16px; margin: 0 0 24px 0;">
              <p style="color: #94A3B8; margin: 0 0 4px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Your Login Email</p>
              <p style="color: #F8FAFC; font-weight: bold; margin: 0;">${email}</p>
            </div>
            <p style="color: #F8FAFC; margin-bottom: 8px;">Here is how to get started:</p>
            <ol style="color: #CBD5E1; padding-left: 20px; line-height: 1.9;">
              <li>Click the button below to sign in to your new dashboard.</li>
              <li>Add your church branches under Admin Settings.</li>
              <li>Build your member roster and start tracking attendance.</li>
              <li>Configure your SMTP settings so members receive automated communications.</li>
            </ol>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${hubLoginUrl}" style="background: #3B9A5F; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 15px; display: inline-block;">
                Go to My Dashboard
              </a>
            </div>
            <p style="color: #94A3B8; font-size: 14px;">
              If you run into anything, just reply to this email or visit
              <a href="https://kerekehub.co.za/contact" style="color: #3B9A5F;">kerekehub.co.za/contact</a>.
              We are here to help.
            </p>
            <hr style="border-color: #334155; margin: 24px 0;" />
            <p style="color: #475569; font-size: 12px; margin: 0;">
              Kereke Hub - Ministry Management, Simplified - kerekehub.co.za
            </p>
          </div>
        `,
      });
      console.log(`[onSignupCreated] Welcome email sent to ${email} for signup ${signupId}`);
    } catch (err) {
      console.error("[onSignupCreated] Failed to send welcome email:", err);
    }

    // ── 2. Notify Sifiso of the new signup ───────────────────
    const accountTypeLabel: Record<string, string> = {
      internal: "Internal (Free Forever)",
      beta: "Beta Tester (4 months free, then R159)",
      standard: "Standard (30-day trial, R99, R159)",
    };
    try {
      await transporter.sendMail({
        from: `"Kereke Hub Signups" <${gmailUser}>`,
        to: "sifisosibuyane@gmail.com",
        subject: `New Signup: ${churchName} [${accountType.toUpperCase()}]`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 32px; border-radius: 8px;">
            <h2 style="color: #3B9A5F; margin-top: 0;">New Church Signup</h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="color: #94A3B8; padding: 6px 0; width: 130px;">Church</td><td style="color: #F8FAFC; font-weight: bold;">${churchName}</td></tr>
              <tr><td style="color: #94A3B8; padding: 6px 0;">Admin</td><td style="color: #F8FAFC;">${adminName}</td></tr>
              <tr><td style="color: #94A3B8; padding: 6px 0;">Email</td><td style="color: #F8FAFC;">${email}</td></tr>
              <tr><td style="color: #94A3B8; padding: 6px 0;">Account Type</td><td style="color: #3B9A5F; font-weight: bold;">${accountTypeLabel[accountType] ?? accountType}</td></tr>
            </table>
            <hr style="border-color: #334155; margin: 24px 0;" />
            <p style="color: #64748B; font-size: 12px;">View this tenant in the Admin Settings panel on hub.kerekehub.co.za.</p>
          </div>
        `,
      });
      console.log(`[onSignupCreated] Admin notification sent for ${signupId}`);
    } catch (err) {
      console.error("[onSignupCreated] Failed to send admin notification:", err);
    }

    // ── 3. Mark signup as welcome sent ───────────────────────
    try {
      await db.doc(`signups/${signupId}`).update({
        status: "welcome_sent",
        welcomeSentAt: new Date(),
      });
    } catch (err) {
      console.error("[onSignupCreated] Failed to update signup status:", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// TRIGGER 3b: INVITED TEAM MEMBER EMAIL
//
// Fires when a new document is created in /users/{userId}
// with status: "invited". Sends the invitee a setup email
// with a password-reset link so they can choose their own
// password and log in for the first time.
//
// Required fields on the user document:
//   - email       (string)
//   - displayName (string)
//   - tenantId    (string)
//   - role        (string)
//   - status      (string — must be "invited")
// ─────────────────────────────────────────────────────────────
import { getAuth } from "firebase-admin/auth";

export const onInvitedUserCreated = onDocumentCreated(
  {
    document: "users/{userId}",
    secrets: [SYSTEM_GMAIL_USER, SYSTEM_GMAIL_APP_PASSWORD],
  },
  async (event) => {
    const user = event.data?.data();
    if (!user) return;

    // Only fire for invited team members, not self-registered owners
    if (user.status !== "invited") return;

    const gmailUser = SYSTEM_GMAIL_USER.value();
    const gmailPass = SYSTEM_GMAIL_APP_PASSWORD.value();

    if (!gmailUser || !gmailPass) {
      console.error("[onInvitedUserCreated] System Gmail secrets not configured.");
      return;
    }

    const { email, displayName, tenantId, role } = user;
    if (!email || !tenantId) {
      console.log(`[onInvitedUserCreated] Skipped ${event.params.userId} — missing email or tenantId.`);
      return;
    }

    // Fetch church name for the email
    const tenantSnap = await db.doc(`tenants/${tenantId}`).get();
    const churchName = tenantSnap.data()?.name || "Your Church";

    // Generate a password-reset link so they can set their own password
    let setupLink = "https://hub.kerekehub.co.za/login";
    try {
      setupLink = await getAuth().generatePasswordResetLink(email);
    } catch (err) {
      console.error("[onInvitedUserCreated] Failed to generate setup link:", err);
    }

    const roleLabels: Record<string, string> = {
      admin: "Administrator",
      viewer: "Viewer",
      finance: "Finance Manager",
      member_manager: "Member Manager",
    };
    const roleLabel = roleLabels[role] || role;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });

    try {
      await transporter.sendMail({
        from: `"Kereke Hub" <${gmailUser}>`,
        to: email,
        subject: `You have been invited to ${churchName} on Kereke Hub`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 40px; border-radius: 10px;">
            <h2 style="color: #3B9A5F; margin-top: 0; font-size: 24px;">You have been invited!</h2>
            <p style="color: #F8FAFC; font-size: 16px;">
              Hi ${displayName || email}, you have been added as a
              <strong>${roleLabel}</strong> on the
              <strong>${churchName}</strong> Kereke Hub account.
            </p>
            <div style="background: #1E293B; border-radius: 8px; padding: 16px; margin: 24px 0;">
              <p style="color: #94A3B8; margin: 0 0 4px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Your Login Email</p>
              <p style="color: #F8FAFC; font-weight: bold; margin: 0;">${email}</p>
            </div>
            <p style="color: #CBD5E1;">
              Click the button below to set your password and access your dashboard.
              This link is valid for 24 hours.
            </p>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${setupLink}" style="background: #3B9A5F; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 15px; display: inline-block;">
                Set Up My Account
              </a>
            </div>
            <p style="color: #94A3B8; font-size: 13px;">
              If the button does not work, copy and paste this link into your browser:<br/>
              <span style="color: #3B9A5F; word-break: break-all;">${setupLink}</span>
            </p>
            <hr style="border-color: #334155; margin: 24px 0;" />
            <p style="color: #475569; font-size: 12px; margin: 0;">
              Kereke Hub - Ministry Management, Simplified - kerekehub.co.za
            </p>
          </div>
        `,
      });
      console.log(`[onInvitedUserCreated] Invitation email sent to ${email}`);
    } catch (err) {
      console.error("[onInvitedUserCreated] Failed to send invitation email:", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// SCHEDULED: BILLING REMINDER EMAILS
//
// Runs daily at 08:00 SAST. Finds tenants whose free period ends
// in exactly 7 days or 1 day, and emails them a payment reminder
// with a direct link to hub.kerekehub.co.za/dashboard/billing.
//
// Skips: internal accounts, already-paying tenants, and anyone
// whose paymentStatus is already "active".
// ─────────────────────────────────────────────────────────────
import { onSchedule } from "firebase-functions/v2/scheduler";

export const billingReminder = onSchedule(
  {
    schedule: "0 6 * * *",   // 06:00 UTC = 08:00 SAST
    timeZone: "Africa/Johannesburg",
    secrets: [SYSTEM_GMAIL_USER, SYSTEM_GMAIL_APP_PASSWORD],
  },
  async () => {
    const gmailUser = SYSTEM_GMAIL_USER.value();
    const gmailPass = SYSTEM_GMAIL_APP_PASSWORD.value();
    if (!gmailUser || !gmailPass) {
      console.error("[billingReminder] System Gmail secrets not configured.");
      return;
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });

    const now = new Date();
    const billingUrl = "https://hub.kerekehub.co.za/dashboard/billing";

    // Helper: check if a date is N days away (within a 12-hour window to avoid duplicates)
    function isDaysAway(iso: string | null, n: number): boolean {
      if (!iso) return false;
      const target = new Date(iso).getTime();
      const diff = (target - now.getTime()) / (1000 * 60 * 60 * 24);
      return diff >= n - 0.5 && diff < n + 0.5;
    }

    // Fetch all non-internal, non-paying tenants
    const snap = await db
      .collection("tenants")
      .where("accountType", "in", ["standard", "beta"])
      .get();

    let sent = 0;

    for (const tenantDoc of snap.docs) {
      const t = tenantDoc.data();

      // Skip already paying
      if (t.paymentStatus === "active") continue;

      // Determine which date to check and what the upcoming rate is
      let checkDate: string | null = null;
      let daysLabel = "";
      let upcomingLabel = "";

      if (t.accountType === "beta") {
        checkDate = t.trialEndsAt;
        upcomingLabel = "R159/mo";
      } else if (t.billingPhase === "trial") {
        checkDate = t.trialEndsAt;
        upcomingLabel = "R99/mo";
      } else if (t.billingPhase === "evaluation") {
        checkDate = t.evaluationEndsAt;
        upcomingLabel = "R159/mo";
      }

      const is7Days = isDaysAway(checkDate, 7);
      const is1Day = isDaysAway(checkDate, 1);

      if (!is7Days && !is1Day) continue;

      daysLabel = is1Day ? "tomorrow" : "in 7 days";
      const urgency = is1Day ? "high" : "medium";

      const { ownerEmail, ownerName, name: churchName } = t;
      if (!ownerEmail) continue;

      const subject = is1Day
        ? `Action required: Set up payment for ${churchName} by tomorrow`
        : `Reminder: Your Kereke Hub free period ends in 7 days`;

      try {
        await transporter.sendMail({
          from: `"Kereke Hub" <${gmailUser}>`,
          to: ownerEmail,
          subject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 40px; border-radius: 10px;">
              <h2 style="color: ${urgency === "high" ? "#F59E0B" : "#3B9A5F"}; margin-top: 0;">
                ${urgency === "high" ? "Payment needed by tomorrow" : "Your free period ends soon"}
              </h2>
              <p style="color: #F8FAFC;">Hi ${ownerName},</p>
              <p style="color: #CBD5E1;">
                Your Kereke Hub free period for <strong>${churchName}</strong> ends
                <strong>${daysLabel}</strong>. After that, your plan moves to
                <strong>${upcomingLabel}</strong>.
              </p>
              <p style="color: #CBD5E1;">
                To keep your account running without interruption, set up your payment method now.
                It only takes a minute.
              </p>
              <div style="text-align: center; margin: 32px 0;">
                <a href="${billingUrl}" style="background: #3B9A5F; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 15px; display: inline-block;">
                  Set Up Payment
                </a>
              </div>
              <p style="color: #94A3B8; font-size: 14px;">
                Questions? Reply to this email or visit
                <a href="https://kerekehub.co.za/contact" style="color: #3B9A5F;">kerekehub.co.za/contact</a>.
              </p>
              <hr style="border-color: #334155; margin: 24px 0;" />
              <p style="color: #475569; font-size: 12px; margin: 0;">
                Kereke Hub &mdash; Ministry Management, Simplified
              </p>
            </div>
          `,
        });
        sent++;
        console.log(`[billingReminder] Reminder sent to ${ownerEmail} (${daysLabel})`);
      } catch (err) {
        console.error(`[billingReminder] Failed to email ${ownerEmail}:`, err);
      }
    }

    console.log(`[billingReminder] Done. ${sent} reminder(s) sent.`);
  }
);

// ─────────────────────────────────────────────────────────────
// TRIGGER 3b: DUNNING + AUTO-SUSPENSION ON A MISSED PAYMENT
//
// Runs daily. Looks at paid-tier churches that the PayFast ITN handler marked
// past due (pastDueSince set after a cancelled or failed payment). It sends a
// short reminder sequence, then auto-suspends after a grace period.
//
//   Day 1, 3, 7 past due : send a "payment failed, please update" email.
//   Day 10 (GRACE_DAYS)  : auto-suspend (status = "suspended",
//                          suspendedReason = "billing_auto") and email the owner.
//
// A later successful payment (see the ITN handler) clears pastDueSince and, if
// the church was auto-suspended, reactivates it automatically.
//
// Protected from auto-suspension:
//   - accountType "internal" (Sifiso's own / test churches)
//   - any church flagged billingHold === true (manual escape hatch, e.g. the
//     grandfathered sister churches)
// ─────────────────────────────────────────────────────────────
const GRACE_DAYS = 10;

export const dunning = onSchedule(
  {
    schedule: "0 7 * * *",   // 07:00 UTC = 09:00 SAST, an hour after billingReminder
    timeZone: "Africa/Johannesburg",
    secrets: [SYSTEM_GMAIL_USER, SYSTEM_GMAIL_APP_PASSWORD],
  },
  async () => {
    const gmailUser = SYSTEM_GMAIL_USER.value();
    const gmailPass = SYSTEM_GMAIL_APP_PASSWORD.value();
    if (!gmailUser || !gmailPass) {
      console.error("[dunning] System Gmail secrets not configured.");
      return;
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });

    const now = new Date();
    const billingUrl = "https://hub.kerekehub.co.za/dashboard/billing";

    // Only paid-tier churches that have been stamped past due.
    const snap = await db.collection("tenants").where("tier", "==", "paid").get();

    let suspended = 0;

    for (const tenantDoc of snap.docs) {
      const t = tenantDoc.data();
      if (!t.pastDueSince) continue;                 // not past due
      if (t.paymentStatus === "active") continue;    // already paid, safety
      if (t.accountType === "internal") continue;    // protected account type
      if (t.billingHold === true) continue;          // manual protection

      const daysPastDue = Math.floor(
        (now.getTime() - new Date(t.pastDueSince).getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysPastDue < 1) continue;

      const { ownerEmail, ownerName, name: churchName } = t;

      // ── Auto-suspend once the grace period is up ──────────────────────────
      if (daysPastDue >= GRACE_DAYS) {
        if (t.status !== "suspended") {
          try {
            await tenantDoc.ref.update({
              status: "suspended",
              suspendedReason: "billing_auto",
              updatedAt: now,
            });
            await db.collection("admin_audit").add({
              action: "tenant.auto_suspend",
              targetType: "tenant",
              targetId: tenantDoc.id,
              targetName: churchName || "",
              actorUid: "system",
              actorEmail: "",
              meta: { daysPastDue, graceDays: GRACE_DAYS },
              at: now,
            });
            suspended++;

            if (ownerEmail) {
              await transporter.sendMail({
                from: `"Kereke Hub" <${gmailUser}>`,
                to: ownerEmail,
                subject: `Access paused for ${churchName}`,
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 40px; border-radius: 10px;">
                    <h2 style="color: #F59E0B; margin-top: 0;">Your account access is paused</h2>
                    <p style="color: #F8FAFC;">Hi ${ownerName || "there"},</p>
                    <p style="color: #CBD5E1;">
                      We were not able to collect payment for <strong>${churchName}</strong>, and the
                      account is now paused after ${GRACE_DAYS} days. Your data is safe and nothing has
                      been deleted.
                    </p>
                    <p style="color: #CBD5E1;">
                      To restore access straight away, please update your payment method.
                    </p>
                    <div style="text-align: center; margin: 32px 0;">
                      <a href="${billingUrl}" style="background: #3B9A5F; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 15px; display: inline-block;">
                        Update Payment
                      </a>
                    </div>
                    <p style="color: #94A3B8; font-size: 14px;">
                      Need help? Reply to this email or visit
                      <a href="https://kerekehub.co.za/contact" style="color: #3B9A5F;">kerekehub.co.za/contact</a>.
                    </p>
                  </div>
                `,
              });
            }
            console.log(`[dunning] Auto-suspended ${churchName} (${daysPastDue} days past due).`);
          } catch (err) {
            console.error(`[dunning] Failed to auto-suspend ${tenantDoc.id}:`, err);
          }
        }
        continue; // suspended churches get no more reminder emails
      }

      // ── Day 1, 3, 7 reminder emails now live in Brevo ─────────────────────
      // These used to be sent here over Gmail. They have moved to Brevo
      // Automations (see brevo-billing-emails/BREVO_SETUP_GUIDE.md): the app adds
      // the owner to the "Past Due Churches" list on a failed payment, and a
      // Brevo automation sends day 1, 3, 7 with wait steps. This function keeps
      // only the day 10 auto-suspend above. Nothing more to send here.
    }

    console.log(`[dunning] Done. ${suspended} church(es) auto-suspended.`);
  }
);

// ─────────────────────────────────────────────────────────────
// TRIGGER 4: SUPPORT TICKET NOTIFICATIONS
//
// Fires when a new document is created in /support_tickets/{ticketId}.
// Comes from two sources:
//   - Public marketing contact form (no tenantId)
//   - Hub dashboard "Submit Ticket" form (has tenantId + churchName)
//
// Actions:
//   1. Email Sifiso at sifisosibuyane@gmail.com with full ticket details
//   2. Auto-reply to the submitter with their ticket reference
//   3. Write a ticketRef (e.g. TK-8F3A) back onto the document
//
// Secrets required (set once via Firebase CLI):
//   firebase functions:secrets:set SYSTEM_GMAIL_USER
//   firebase functions:secrets:set SYSTEM_GMAIL_APP_PASSWORD
// ─────────────────────────────────────────────────────────────
export const onSupportTicketCreated = onDocumentCreated(
  {
    document: "support_tickets/{ticketId}",
    secrets: [SYSTEM_GMAIL_USER, SYSTEM_GMAIL_APP_PASSWORD],
  },
  async (event) => {
    const ticket = event.data?.data();
    if (!ticket) return;

    // Dashboard tickets are now created and emailed by the Next.js API route
    // (/api/support/ticket). Skip those here to avoid double notifications.
    if (ticket.emailedVia === "api") {
      console.log("[onSupportTicketCreated] Skipped — already handled by API route.");
      return;
    }

    const ticketId = event.params.ticketId;
    const gmailUser = SYSTEM_GMAIL_USER.value();
    const gmailPass = SYSTEM_GMAIL_APP_PASSWORD.value();

    if (!gmailUser || !gmailPass) {
      console.error("[onSupportTicketCreated] System Gmail secrets not configured.");
      return;
    }

    // Generate a short human-readable ticket reference
    const ticketRef = "TK-" + ticketId.slice(0, 6).toUpperCase();

    // Write the ticketRef back to the document immediately
    try {
      await db.doc(`support_tickets/${ticketId}`).update({ ticketRef, status: "open" });
    } catch (err) {
      console.error("[onSupportTicketCreated] Failed to update ticketRef:", err);
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });

    const {
      name = "Unknown",
      email = "",
      phone = "",
      subject = "(no subject)",
      message = "",
      category = "general",
      priority = "normal",
      churchName = "",
      tenantId = "",
      source = "public_form",
    } = ticket;

    const sourceLabel = source === "dashboard" ? `Hub Dashboard (${churchName || tenantId})` : "Public Contact Form";
    const priorityLabel = priority === "urgent" ? "URGENT" : "Normal";

    // ── 1. Notify Sifiso ──
    try {
      await transporter.sendMail({
        from: `"Kereke Hub Support" <${gmailUser}>`,
        to: "sifisosibuyane@gmail.com",
        subject: `[${priorityLabel}] New Ticket ${ticketRef}: ${subject}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 32px; border-radius: 8px;">
            <h2 style="color: #3B9A5F; margin-top: 0;">New Support Ticket</h2>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
              <tr><td style="color: #94A3B8; padding: 6px 0; width: 130px;">Ticket Ref</td><td style="color: #F8FAFC; font-weight: bold;">${ticketRef}</td></tr>
              <tr><td style="color: #94A3B8; padding: 6px 0;">Priority</td><td style="color: ${priority === "urgent" ? "#EF4444" : "#3B9A5F"}; font-weight: bold;">${priorityLabel}</td></tr>
              <tr><td style="color: #94A3B8; padding: 6px 0;">Source</td><td style="color: #F8FAFC;">${sourceLabel}</td></tr>
              <tr><td style="color: #94A3B8; padding: 6px 0;">Category</td><td style="color: #F8FAFC; text-transform: capitalize;">${category.replace(/_/g, " ")}</td></tr>
              <tr><td style="color: #94A3B8; padding: 6px 0;">From</td><td style="color: #F8FAFC;">${name} &lt;${email}&gt;</td></tr>
              ${phone ? `<tr><td style="color: #94A3B8; padding: 6px 0;">Phone</td><td style="color: #F8FAFC;">${phone}</td></tr>` : ""}
              ${churchName ? `<tr><td style="color: #94A3B8; padding: 6px 0;">Church</td><td style="color: #F8FAFC;">${churchName}</td></tr>` : ""}
              <tr><td style="color: #94A3B8; padding: 6px 0;">Subject</td><td style="color: #F8FAFC; font-weight: bold;">${subject}</td></tr>
            </table>
            <div style="background: #1E293B; padding: 20px; border-radius: 6px; border-left: 4px solid #3B9A5F;">
              <p style="color: #94A3B8; margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Message</p>
              <p style="color: #F8FAFC; margin: 0; white-space: pre-wrap;">${message}</p>
            </div>
            <hr style="border-color: #334155; margin: 24px 0;" />
            <p style="color: #64748B; font-size: 12px; margin: 0;">
              Reply directly to ${email} to respond. View all tickets in the Admin Settings panel.
            </p>
          </div>
        `,
        replyTo: email || undefined,
      });
      console.log(`[onSupportTicketCreated] Admin notification sent for ${ticketRef}`);
    } catch (err) {
      console.error("[onSupportTicketCreated] Failed to send admin notification:", err);
    }

    // ── 2. Auto-reply to submitter ──
    if (!email) {
      console.log(`[onSupportTicketCreated] No submitter email for ${ticketRef} — skipping auto-reply.`);
      return;
    }

    try {
      await transporter.sendMail({
        from: `"Kereke Hub Support" <${gmailUser}>`,
        to: email,
        subject: `We received your request [${ticketRef}]`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 32px; border-radius: 8px;">
            <h2 style="color: #3B9A5F; margin-top: 0;">Thanks for reaching out, ${name}.</h2>
            <p style="color: #F8FAFC;">
              We've received your message and will get back to you as soon as possible. Here's a copy of what you sent:
            </p>
            <div style="background: #1E293B; padding: 20px; border-radius: 6px; margin: 20px 0;">
              <p style="color: #94A3B8; margin: 0 0 4px 0; font-size: 12px;">TICKET REFERENCE</p>
              <p style="color: #3B9A5F; font-size: 20px; font-weight: bold; margin: 0 0 16px 0;">${ticketRef}</p>
              <p style="color: #94A3B8; margin: 0 0 4px 0; font-size: 12px;">SUBJECT</p>
              <p style="color: #F8FAFC; font-weight: bold; margin: 0 0 16px 0;">${subject}</p>
              <p style="color: #94A3B8; margin: 0 0 4px 0; font-size: 12px;">YOUR MESSAGE</p>
              <p style="color: #F8FAFC; margin: 0; white-space: pre-wrap;">${message}</p>
            </div>
            <p style="color: #94A3B8;">
              Please keep your ticket reference handy. If you need to follow up, just reply to this email.
            </p>
            <hr style="border-color: #334155; margin: 24px 0;" />
            <p style="color: #64748B; font-size: 12px; margin: 0;">
              Kereke Hub &mdash; Church Administration Made Simple &mdash; kerekehub.co.za
            </p>
          </div>
        `,
      });
      console.log(`[onSupportTicketCreated] Auto-reply sent to ${email} for ${ticketRef}`);
    } catch (err) {
      console.error("[onSupportTicketCreated] Failed to send auto-reply:", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// SCHEDULED: BREVO BIRTHDAY EMAILS
//
// Runs daily at 08:00 SAST. For every tenant that has:
//   - brevoApiKey configured
//   - brevoBirthdayTemplateId configured
//
// Finds all members whose DOB month+day matches today and sends
// the birthday Brevo template to each of them.
//
// Members need a "dob" field in YYYY-MM-DD format on their doc.
// ─────────────────────────────────────────────────────────────
export const brevoBirthdayEmails = onSchedule(
  {
    schedule: "0 6 * * *",   // 06:00 UTC = 08:00 SAST
    timeZone: "Africa/Johannesburg",
  },
  async () => {
    const today = new Date();
    // Zero-pad month and day: "MM-DD"
    const todayMD =
      String(today.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(today.getDate()).padStart(2, "0");

    console.log(`[brevoBirthdayEmails] Running for ${todayMD}`);

    // Get all tenants that have Brevo birthday emails configured
    const tenantsSnap = await db.collection("tenants").get();
    let totalSent = 0;

    for (const tenantDoc of tenantsSnap.docs) {
      const t = tenantDoc.data();
      const apiKey: string | undefined = t.brevoApiKey;
      const templateId: string | undefined = t.brevoBirthdayTemplateId;

      if (!apiKey || !templateId) continue;

      // Fetch active members for this tenant
      const membersSnap = await db
        .collection("members")
        .where("tenantId", "==", tenantDoc.id)
        .where("status", "==", "active")
        .get();

      for (const memberDoc of membersSnap.docs) {
        const m = memberDoc.data();
        if (!m.email || !m.dob) continue;

        // m.dob is "YYYY-MM-DD" — extract "MM-DD"
        const dobMD = String(m.dob).slice(5, 10);
        if (dobMD !== todayMD) continue;

        const firstName = m.firstName || m.fullName?.split(" ")[0] || "";
        const lastName = m.lastName || m.fullName?.split(" ").slice(1).join(" ") || "";

        try {
          const res = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
              "api-key": apiKey,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              to: [{ email: m.email.trim(), name: `${firstName} ${lastName}`.trim() }],
              templateId: Number(templateId),
              params: { FIRSTNAME: firstName, LASTNAME: lastName },
            }),
          });

          if (res.ok) {
            totalSent++;
            console.log(`[brevoBirthdayEmails] Sent to ${m.email} (tenant: ${tenantDoc.id})`);
          } else {
            const body = await res.text();
            console.error(`[brevoBirthdayEmails] Failed for ${m.email}: ${body}`);
          }
        } catch (err) {
          console.error(`[brevoBirthdayEmails] Error sending to ${m.email}:`, err);
        }
      }
    }

    console.log(`[brevoBirthdayEmails] Done. ${totalSent} birthday email(s) sent.`);
  }
);

// ─────────────────────────────────────────────────────────────
// SCHEDULED: BULKSMS BIRTHDAY SMS
//
// Runs daily at 07:00 SAST. For every tenant that has:
//   - bulksmsTokenId + bulksmsTokenSecret configured
//   - bulksmsBirthdayEnabled === true
//
// Finds all active members whose DOB month+day matches today and who have a
// phone number, and texts them a personalized birthday message. Supports the
// [First Name] / [Last Name] / [Church Name] merge tags.
// ─────────────────────────────────────────────────────────────
function personalizeSms(
  message: string,
  vars: { firstName: string; lastName: string; churchName: string }
): string {
  return message
    .replace(/\[\s*first\s*name\s*\]/gi, vars.firstName)
    .replace(/\[\s*last\s*name\s*\]/gi, vars.lastName)
    .replace(/\[\s*church\s*name\s*\]/gi, vars.churchName);
}

function normaliseSmsNumber(raw: string): string {
  let n = String(raw || "").replace(/\D/g, "");
  if (n.startsWith("0")) n = "27" + n.substring(1);
  return n;
}

export const bulksmsBirthdaySms = onSchedule(
  {
    schedule: "0 5 * * *",   // 05:00 UTC = 07:00 SAST
    timeZone: "Africa/Johannesburg",
  },
  async () => {
    const today = new Date();
    const todayMD =
      String(today.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(today.getDate()).padStart(2, "0");

    console.log(`[bulksmsBirthdaySms] Running for ${todayMD}`);

    const tenantsSnap = await db.collection("tenants").get();
    let totalSent = 0;

    for (const tenantDoc of tenantsSnap.docs) {
      const t = tenantDoc.data();
      const tokenId: string | undefined = t.bulksmsTokenId;
      const tokenSecret: string | undefined = t.bulksmsTokenSecret;
      if (!tokenId || !tokenSecret || t.bulksmsBirthdayEnabled !== true) continue;

      const message: string =
        t.bulksmsBirthdayMessage ||
        "Happy birthday [First Name]! We thank God for your life and pray His blessings over you today.";
      const senderId: string | undefined = t.bulksmsSenderId;
      const churchName: string = t.name || "";
      const authHeader = "Basic " + Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64");

      const membersSnap = await db
        .collection("members")
        .where("tenantId", "==", tenantDoc.id)
        .where("status", "==", "active")
        .get();

      for (const memberDoc of membersSnap.docs) {
        const m = memberDoc.data();
        if (!m.dob) continue;
        if (String(m.dob).slice(5, 10) !== todayMD) continue;

        const to = normaliseSmsNumber(m.phone || m.cellphone || "");
        if (to.length < 10) continue;

        const firstName = m.firstName || String(m.fullName || "").split(" ")[0] || "";
        const lastName = m.lastName || String(m.fullName || "").split(" ").slice(1).join(" ") || "";
        const body = personalizeSms(message, { firstName, lastName, churchName });

        const payload: Record<string, unknown> = { to, body };
        if (senderId && senderId.trim()) payload.from = senderId.trim();

        try {
          const res = await fetch("https://api.bulksms.com/v1/messages", {
            method: "POST",
            headers: { Authorization: authHeader, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            totalSent++;
            console.log(`[bulksmsBirthdaySms] Sent to ${to} (tenant: ${tenantDoc.id})`);
          } else {
            const errBody = await res.text();
            console.error(`[bulksmsBirthdaySms] Failed for ${to}: ${errBody}`);
          }
        } catch (err) {
          console.error(`[bulksmsBirthdaySms] Error sending to ${to}:`, err);
        }
      }
    }

    console.log(`[bulksmsBirthdaySms] Done. ${totalSent} birthday SMS sent.`);
  }
);

// ─────────────────────────────────────────────────────────────
// SCHEDULED: ONE-TIME VISITOR THANK-YOU SMS (24h after capture)
//
// Runs hourly. Sends the one-time thank-you SMS to "Just visiting" guests who
// were captured with oneTimeSmsPending === true, once at least 24 hours have
// passed since capture. Marks them sent so each guest is only texted once.
// The tenant must still have BulkSMS connected and one-time SMS enabled.
// ─────────────────────────────────────────────────────────────
export const visitorFollowupSms = onSchedule(
  {
    schedule: "0 * * * *",   // top of every hour
    timeZone: "Africa/Johannesburg",
  },
  async () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago

    const pendingSnap = await db
      .collection("visitors")
      .where("oneTimeSmsPending", "==", true)
      .get();

    if (pendingSnap.empty) {
      console.log("[visitorFollowupSms] Nothing pending.");
      return;
    }

    const tenantCache: Record<string, any> = {};
    let totalSent = 0;

    for (const vDoc of pendingSnap.docs) {
      const v = vDoc.data();

      // Only send once 24h have elapsed since capture.
      const createdMs = v.createdAt && typeof v.createdAt.toMillis === "function" ? v.createdAt.toMillis() : 0;
      if (!createdMs || createdMs > cutoff) continue;

      const tid = v.tenantId;
      if (!tid) { await vDoc.ref.update({ oneTimeSmsPending: false }); continue; }

      if (!(tid in tenantCache)) {
        const tSnap = await db.collection("tenants").doc(tid).get();
        tenantCache[tid] = tSnap.exists ? tSnap.data() || null : null;
      }
      const t = tenantCache[tid];
      // If the church has turned the feature off or disconnected BulkSMS, skip
      // (leave pending so it can still go out if they re-enable it).
      if (!t || t.oneTimeVisitorSmsEnabled !== true || !t.bulksmsTokenId || !t.bulksmsTokenSecret) continue;

      const to = normaliseSmsNumber(v.phone || "");
      if (to.length < 10) { await vDoc.ref.update({ oneTimeSmsPending: false }); continue; }

      const firstName = v.firstName || String(v.fullName || "").split(" ")[0] || "";
      const lastName = v.lastName || String(v.fullName || "").split(" ").slice(1).join(" ") || "";
      const body = personalizeSms(
        t.oneTimeVisitorSmsMessage || "Thank you for visiting us today. We hope to see you again soon.",
        { firstName, lastName, churchName: t.name || "" }
      );

      const payload: Record<string, unknown> = { to, body };
      if (t.bulksmsSenderId && String(t.bulksmsSenderId).trim()) payload.from = String(t.bulksmsSenderId).trim();
      const authHeader = "Basic " + Buffer.from(`${t.bulksmsTokenId}:${t.bulksmsTokenSecret}`).toString("base64");

      try {
        const res = await fetch("https://api.bulksms.com/v1/messages", {
          method: "POST",
          headers: { Authorization: authHeader, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          totalSent++;
          await vDoc.ref.update({
            oneTimeSmsPending: false,
            oneTimeSmsSent: true,
            oneTimeSmsSentAt: new Date().toISOString(),
          });
          console.log(`[visitorFollowupSms] Sent to ${to} (tenant: ${tid})`);
        } else {
          const errBody = await res.text();
          console.error(`[visitorFollowupSms] Failed for ${to}: ${errBody}`);
        }
      } catch (err) {
        console.error(`[visitorFollowupSms] Error sending to ${to}:`, err);
      }
    }

    console.log(`[visitorFollowupSms] Done. ${totalSent} follow-up SMS sent.`);
  }
);

// ─────────────────────────────────────────────────────────────
// SCHEDULED: DAILY WHATSAPP SUMMARY (see ./dailySummary.ts)
// ─────────────────────────────────────────────────────────────
export { dailySummary } from "./dailySummary";

// ─────────────────────────────────────────────────────────────
// MEMBER COUNTER
// Keeps tenants/{tenantId}.activeMemberCount in sync so the free-tier
// member limit can be checked cheaply (in the app and in security rules)
// without counting the whole members collection each time.
//
// An "active member" is a member document whose status is "active", which
// matches how the rest of the app counts members. Archived or inactive
// members (any other status) do not count toward the limit.
//
// Fires on every create, update, and delete of a member document and
// adjusts the tenant's count by the change only.
// ─────────────────────────────────────────────────────────────
export const onMemberCountWrite = onDocumentWritten(
  "members/{memberId}",
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    const wasActive = before?.status === "active";
    const isActive = after?.status === "active";

    // Nothing that affects the active count changed.
    if (wasActive === isActive) return;

    const tenantId = after?.tenantId ?? before?.tenantId;
    if (!tenantId) return;

    const delta = (isActive ? 1 : 0) - (wasActive ? 1 : 0);

    try {
      await db.doc(`tenants/${tenantId}`).update({
        activeMemberCount: FieldValue.increment(delta),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        `[onMemberCountWrite] Failed to update activeMemberCount for tenant ${tenantId}:`,
        err
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────
// ATTENDANCE ROLLUP
// Keeps tenants/{tenantId}.lastServiceDate / lastServiceAttendance in sync
// so the super admin dashboard can show each church's most recent
// headcount without querying the whole attendance collection per tenant.
//
// Attendance is stored as one doc per member per service. Every time one
// of those docs is written, we recompute the present-count for that
// service date (cheap: one filtered query) and, if that date is the
// tenant's most recent, write it onto the tenant doc. Older-date writes
// (edits to a past service) are skipped since they cannot change what
// the "latest" numbers are.
// ─────────────────────────────────────────────────────────────
export const onAttendanceWrite = onDocumentWritten(
  "attendance/{recordId}",
  async (event) => {
    const after = event.data?.after?.data();
    const before = event.data?.before?.data();
    const rec = after ?? before;
    const tenantId = rec?.tenantId;
    const serviceDate = rec?.serviceDate;
    if (!tenantId || !serviceDate) return;

    try {
      const tenantSnap = await db.doc(`tenants/${tenantId}`).get();
      const currentLastDate = tenantSnap.data()?.lastServiceDate;
      // This write can't be the latest service, so it can't change the
      // headcount we show. Skip the recompute.
      if (currentLastDate && serviceDate < currentLastDate) return;

      const presentSnap = await db
        .collection("attendance")
        .where("tenantId", "==", tenantId)
        .where("serviceDate", "==", serviceDate)
        .where("status", "==", "present")
        .get();

      await db.doc(`tenants/${tenantId}`).set(
        {
          lastServiceDate: serviceDate,
          lastServiceAttendance: presentSnap.size,
          lastServiceUpdatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    } catch (err) {
      console.error(`[onAttendanceWrite] Failed to roll up attendance for tenant ${tenantId}:`, err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// INACTIVITY CHECK
// Runs daily. Flags active churches that have not logged in for a while
// (tenants/{tenantId}.lastLoginAt is stamped by /api/login on every
// sign-in) and emails the owner a nudge. Re-sends at most once every
// INACTIVITY_EMAIL_COOLDOWN_DAYS so it doesn't nag daily.
//
// Skipped for: suspended/trial tenants (not relevant), internal/test
// accounts, and any church with no ownerEmail on file.
// ─────────────────────────────────────────────────────────────
const INACTIVITY_DAYS = 14;
const INACTIVITY_EMAIL_COOLDOWN_DAYS = 14;

export const inactivityCheck = onSchedule(
  {
    schedule: "0 8 * * *", // 08:00 UTC = 10:00 SAST
    timeZone: "Africa/Johannesburg",
    secrets: [SYSTEM_GMAIL_USER, SYSTEM_GMAIL_APP_PASSWORD],
  },
  async () => {
    const gmailUser = SYSTEM_GMAIL_USER.value();
    const gmailPass = SYSTEM_GMAIL_APP_PASSWORD.value();
    if (!gmailUser || !gmailPass) {
      console.error("[inactivityCheck] System Gmail secrets not configured.");
      return;
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });

    const now = new Date();
    const loginUrl = "https://hub.kerekehub.co.za/login";

    const snap = await db.collection("tenants").where("status", "==", "active").get();
    let emailed = 0;

    for (const tenantDoc of snap.docs) {
      const t = tenantDoc.data();
      if (t.accountType === "internal") continue;
      if (!t.ownerEmail) continue;

      const lastActive = t.lastLoginAt || t.createdAt;
      if (!lastActive) continue;

      const daysSince = Math.floor((now.getTime() - new Date(lastActive).getTime()) / 86400000);
      if (daysSince < INACTIVITY_DAYS) continue;

      const lastSent = t.lastInactivityEmailSentAt;
      if (lastSent) {
        const daysSinceSent = Math.floor((now.getTime() - new Date(lastSent).getTime()) / 86400000);
        if (daysSinceSent < INACTIVITY_EMAIL_COOLDOWN_DAYS) continue;
      }

      try {
        await transporter.sendMail({
          from: `"Kereke Hub" <${gmailUser}>`,
          to: t.ownerEmail,
          subject: `We haven't seen ${t.name || "your church"} on Kereke Hub in a while`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0F172A; color: #F8FAFC; padding: 40px; border-radius: 10px;">
              <h2 style="color: #3B9A5F; margin-top: 0;">It's been ${daysSince} days</h2>
              <p style="color: #F8FAFC;">Hi ${t.ownerName || "there"},</p>
              <p style="color: #CBD5E1;">
                Nobody from <strong>${t.name || "your church"}</strong> has logged into Kereke Hub in
                about ${daysSince} days. If you've hit a snag or something isn't working the way you
                expect, just reply to this email and we'll help sort it out.
              </p>
              <div style="text-align: center; margin: 32px 0;">
                <a href="${loginUrl}" style="background: #3B9A5F; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 15px; display: inline-block;">
                  Log In
                </a>
              </div>
              <p style="color: #94A3B8; font-size: 14px;">
                Kereke Hub. Church Administration Made Simple.
              </p>
            </div>
          `,
        });

        await tenantDoc.ref.set(
          { lastInactivityEmailSentAt: now.toISOString() },
          { merge: true }
        );
        emailed++;
      } catch (err) {
        console.error(`[inactivityCheck] Failed to email tenant ${tenantDoc.id}:`, err);
      }
    }

    console.log(`[inactivityCheck] Done. ${emailed} reminder(s) sent.`);
  }
);

// ─────────────────────────────────────────────────────────────
// SCHEDULED: EMAILED REPORTS
//
// Runs daily at 06:00 SAST. For each active report_schedule that is due
// (monthly on the 1st, weekly on Mondays), generates the report server-side
// and emails it to the recipients via the church's own Brevo account, with the
// full report attached as a CSV. Only non-sensitive reports can be scheduled
// (the config UI only lists those).
// ─────────────────────────────────────────────────────────────
import { generateReport, reportToCsv, reportEmailHtml } from "./reportGen";

export const scheduledReports = onSchedule(
  { schedule: "0 6 * * *", timeZone: "Africa/Johannesburg" }, // 06:00 SAST
  async () => {
    // "Today" in SAST (UTC+2, no DST) for the cadence check.
    const sast = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const dayOfMonth = sast.getUTCDate();
    const dayOfWeek = sast.getUTCDay(); // 0 Sun .. 1 Mon

    const snap = await db.collection("report_schedules").where("active", "==", true).get();
    let sent = 0;

    for (const d of snap.docs) {
      const s = d.data();
      const due =
        (s.cadence === "monthly" && dayOfMonth === 1) ||
        (s.cadence === "weekly" && dayOfWeek === 1);
      if (!due) continue;

      // Guard against a double-send if the scheduler retries within the day.
      const last = s.lastRunAt && typeof s.lastRunAt.toDate === "function" ? s.lastRunAt.toDate() : null;
      if (last && Date.now() - last.getTime() < 20 * 60 * 60 * 1000) continue;

      try {
        const tenantSnap = await db.doc(`tenants/${s.tenantId}`).get();
        const t = tenantSnap.data() || {};
        const recipients: string[] = Array.isArray(s.recipients) ? s.recipients.filter(Boolean) : [];
        if (!t.brevoApiKey || !t.brevoSenderEmail) {
          await d.ref.update({ lastRunAt: new Date(), lastRunStatus: "skipped_no_brevo" });
          continue;
        }
        if (recipients.length === 0) {
          await d.ref.update({ lastRunAt: new Date(), lastRunStatus: "no_recipients" });
          continue;
        }
        const report = await generateReport(db, s.tenantId, s.reportId, s.cadence);
        if (!report) {
          await d.ref.update({ lastRunAt: new Date(), lastRunStatus: "unknown_report" });
          continue;
        }
        const csv = reportToCsv(report.columns, report.rows);
        const res = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": t.brevoApiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            sender: { name: t.brevoSenderName || t.name || "Kereke Hub", email: t.brevoSenderEmail },
            to: recipients.map((email) => ({ email })),
            subject: `${report.title} — ${report.meta}`,
            htmlContent: reportEmailHtml(t.name || "", report),
            attachment: [{ content: Buffer.from(csv, "utf-8").toString("base64"), name: `${s.reportId}.csv` }],
          }),
        });
        await d.ref.update({ lastRunAt: new Date(), lastRunStatus: res.ok ? "sent" : "brevo_error" });
        if (res.ok) {
          sent++;
        } else {
          console.error(`[scheduledReports] Brevo error for ${d.id}:`, await res.text().catch(() => ""));
        }
      } catch (err) {
        console.error(`[scheduledReports] Failed for ${d.id}:`, err);
        await d.ref.update({ lastRunAt: new Date(), lastRunStatus: "error" }).catch(() => {});
      }
    }

    console.log(`[scheduledReports] Done. ${sent} report(s) emailed.`);
  }
);
