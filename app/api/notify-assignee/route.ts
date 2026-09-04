// hub: app/api/notify-assignee/route.ts
//
// Emails a team member to let them know they have been assigned a visitor (or a
// member follow-up / workflow) to care for. Uses the tenant's own Brevo account,
// the same one used for the email broadcasts.
//
// POST body: {
//   assigneeUid: string,        // who to notify
//   subjectName: string,        // the visitor/member's name
//   subjectPhone?: string,      // their contact number (shown in the email)
//   kind?: "visitor" | "member" | "workflow" | "care",
//   reason?: string,            // e.g. the visitor's reason for visiting
//   note?: string               // any capture note
// }
//
// The assignee's email is looked up server-side from their user doc and the
// tenant match is enforced, so the browser never has to be trusted with it.

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { adminAuth, adminDb } from "@/lib/firebase-admin";

async function getCaller(req: NextRequest): Promise<{ uid: string; tenantId: string } | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("session")?.value;
  if (!sessionCookie) return null;
  try {
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);
    const userSnap = await adminDb.collection("users").doc(decoded.uid).get();
    if (!userSnap.exists) return null;
    return { uid: decoded.uid, tenantId: userSnap.data()!.tenantId };
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function POST(req: NextRequest) {
  const caller = await getCaller(req);
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { assigneeUid, subjectName, subjectPhone, kind, reason, note } = await req.json();
  if (!assigneeUid) return NextResponse.json({ error: "assigneeUid is required." }, { status: 400 });

  // Look up the assignee and confirm they belong to the same church.
  const assigneeSnap = await adminDb.collection("users").doc(assigneeUid).get();
  if (!assigneeSnap.exists) return NextResponse.json({ error: "Assignee not found." }, { status: 404 });
  const assignee = assigneeSnap.data()!;
  if (assignee.tenantId !== caller.tenantId) {
    return NextResponse.json({ error: "Assignee is not in your church." }, { status: 403 });
  }
  const assigneeEmail = (assignee.email || "").trim();
  const assigneeName = assignee.displayName || assignee.email || "there";
  if (!assigneeEmail) {
    return NextResponse.json({ error: "That team member has no email address on file.", skipped: true }, { status: 200 });
  }

  // Tenant Brevo credentials.
  const tenantSnap = await adminDb.collection("tenants").doc(caller.tenantId).get();
  if (!tenantSnap.exists) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  const tenant = tenantSnap.data()!;
  const { brevoApiKey, brevoSenderEmail, brevoSenderName, name: churchName } = tenant;
  if (!brevoApiKey || !brevoSenderEmail) {
    // Not an error the user needs to see — assignment still succeeded, just no email.
    return NextResponse.json({ skipped: true, reason: "Brevo not connected" }, { status: 200 });
  }

  const who =
    kind === "member"
      ? "a new member"
      : kind === "workflow"
      ? "a follow-up"
      : kind === "care"
      ? "a pastoral care follow-up"
      : "a visitor";
  const subject = `You have been assigned ${who}: ${subjectName || ""}`.trim();

  const rows: string[] = [];
  if (subjectName) rows.push(`<strong>Name:</strong> ${esc(subjectName)}`);
  if (subjectPhone) rows.push(`<strong>Contact:</strong> ${esc(subjectPhone)}`);
  if (reason) rows.push(`<strong>Reason for visiting:</strong> ${esc(reason)}`);
  if (note) rows.push(`<strong>Note:</strong> ${esc(note)}`);

  const htmlContent = `
    <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#222;">
      <p>Hi ${esc(assigneeName)},</p>
      <p>You have been assigned ${who} to follow up with at ${esc(churchName || "your church")}.</p>
      <div style="background:#f4f7f5;border:1px solid #e2e8e4;border-radius:8px;padding:14px 16px;margin:14px 0;">
        ${rows.join("<br>")}
      </div>
      <p>Please reach out to them and log your contact in Kereke Hub when done.</p>
      <p style="color:#6b7280;font-size:13px;">Sent automatically by Kereke Hub.</p>
    </div>`.trim();

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": brevoApiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: brevoSenderName || churchName || "Kereke Hub", email: brevoSenderEmail },
        to: [{ email: assigneeEmail, name: assigneeName }],
        subject,
        htmlContent,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "Brevo rejected the email.", detail }, { status: 502 });
    }
    return NextResponse.json({ sent: true });
  } catch {
    return NextResponse.json({ error: "Could not reach the email service." }, { status: 502 });
  }
}
