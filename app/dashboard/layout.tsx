import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminAuth, adminDb } from "../../lib/firebase-admin";
import LogoutButton from "./LogoutButton";
import MobileSidebar from "./MobileSidebar";
import OverdueBadge from "../components/OverdueBadge";
import PendingApprovalBadge from "../components/PendingApprovalBadge";
import MemberUsageMeter from "../components/MemberUsageMeter";
import { isPaidTier, PAID_NAV_HREFS } from "../../lib/tier";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("session")?.value;

  if (!sessionCookie) {
    redirect("/login");
  }

  let userDocData = null;
  let tenantData = null;

  try {
    // checkRevoked=false: verify the cookie's signature without a live network
    // round-trip to Google on every page load. Faster logins/navigation. The
    // trade-off is a revoked session stays valid until the cookie expires;
    // acceptable here, and Secure Logout now clears the cookie anyway.
    const decodedToken = await adminAuth.verifySessionCookie(sessionCookie, false);

    const userDoc = await adminDb.collection("users").doc(decodedToken.uid).get();

    if (userDoc.exists) {
      userDocData = userDoc.data();

      const tenantId = userDocData?.tenantId;
      if (tenantId) {
        const tenantDoc = await adminDb.collection("tenants").doc(tenantId).get();
        if (tenantDoc.exists) {
          tenantData = tenantDoc.data();
        }
      }
    }
  } catch (error: any) {
    if (error?.digest?.startsWith("NEXT_REDIRECT")) throw error;
    console.error("Session verification failed:", error);
    redirect("/login");
  }

  const userRole = userDocData?.role || "user";
  const userName = userDocData?.displayName || userDocData?.name || "Member";
  const tenantId = userDocData?.tenantId || "";

  // Backstop for existing sessions: if a tenant is suspended after a user is
  // already logged in, bounce them to the suspended notice. The login route
  // blocks new sign-ins; this catches sessions minted before the suspension.
  // Super admins have no tenant, so they are never affected.
  if (userRole !== "super_admin" && tenantData?.status === "suspended") {
    redirect("/suspended");
  }

  const churchName = tenantData?.name || "KerekeHub";
  const primaryColor = tenantData?.primaryColor || "#059669";
  const tenantSlug = tenantData?.slug || "";
  const userMemberId = userDocData?.memberId || "";

  // Free-tier member usage, surfaced in the sidebar for owners and admins.
  const tenantTier = tenantData?.tier ?? null;
  const activeMemberCount = tenantData?.activeMemberCount ?? null;
  const memberLimit = tenantData?.memberLimit ?? null;
  const canSeeUsageMeter = userRole === "owner" || userRole === "admin";
  // Free tenants see paid modules as locked links to the billing/upgrade page.
  const tenantIsPaid = isPaidTier(tenantTier);

  const allNavigation = [
    { name: "Church Overview", href: "/dashboard/analytics", icon: "📊", roles: ["owner", "admin", "viewer", "finance", "member_manager", "member_viewer"] },
    { name: "Church Profile", href: "/dashboard/profile", icon: "⛪", roles: ["owner", "admin"] },
    { name: "Membership Management", href: "/dashboard/roster", icon: "👥", roles: ["owner", "admin", "member_manager", "member_viewer", "cell_leader", "branch_admin"] },
    { name: "Attendance Capture", href: "/dashboard/attendance", icon: "📝", roles: ["owner", "admin", "member_manager", "cell_leader", "branch_admin"] },
    { name: "Attendance Report", href: "/dashboard/attendance/report", icon: "📊", roles: ["owner", "admin", "member_manager", "member_viewer", "cell_leader", "branch_admin"] },
    { name: "First-Time Guests", href: "/dashboard/visitors", icon: "👋", roles: ["owner", "admin", "member_manager", "member_viewer", "follow_up", "branch_admin"] },
    { name: "Financials", href: "/dashboard/finance", icon: "💰", roles: ["owner", "admin", "finance", "branch_admin"] },
    { name: "Pastoral Care", href: "/dashboard/pastoral", icon: "🫶", roles: ["owner", "admin"] },
    { name: "Communications", href: "/dashboard/communications", icon: "💬", roles: ["owner", "admin", "member_manager"] },
    { name: "Daily Summary", href: "/dashboard/daily-summary", icon: "🔔", roles: ["owner", "admin"] },
    { name: "Forms", href: "/dashboard/forms", icon: "📋", roles: ["owner", "admin", "member_manager"] },
    { name: "Groups", href: "/dashboard/groups", icon: "🫂", roles: ["owner", "admin", "member_manager", "cell_leader", "branch_admin"] },
    { name: "Events", href: "/dashboard/events", icon: "🗓️", roles: ["owner", "admin", "member_manager"] },
    { name: "Announcements", href: "/dashboard/announcements", icon: "📢", roles: ["owner", "admin", "member_manager"] },
    { name: "Volunteers", href: "/dashboard/volunteers", icon: "🙌", roles: ["owner", "admin", "member_manager", "cell_leader"] },
    { name: "Worship Planning", href: "/dashboard/worship", icon: "🎵", roles: ["owner", "admin", "member_manager"] },
    { name: "Workflows", href: "/dashboard/workflows", icon: "⚡", roles: ["owner", "admin", "member_manager", "cell_leader"] },
    { name: "Team Members", href: "/dashboard/team", icon: "🧑‍🤝‍🧑", roles: ["owner"] },
    { name: "Church Settings", href: "/dashboard/church-settings", icon: "⚙️", roles: ["owner", "admin"] },
    { name: "Branding", href: "/dashboard/branding", icon: "🎨", roles: ["owner", "admin"] },
    { name: "Billing", href: "/dashboard/billing", icon: "🧾", roles: ["owner"] },
    { name: "Sign-in History", href: "/dashboard/sign-in-history", icon: "🔐", roles: ["owner", "admin"] },
    { name: "Support", href: "/dashboard/support", icon: "🎧", roles: ["owner", "admin", "member_manager", "finance", "viewer", "cell_leader", "branch_admin"] },
  ];

  const navigation = allNavigation.filter(item => item.roles.includes(userRole));

  // Super-admin only: standalone admin sections + a live open-ticket count for
  // the badge on the Tickets link.
  const adminNavigation = [
    { name: "Tenants", href: "/dashboard/admin/tenants", icon: "⛪" },
    { name: "Signups", href: "/dashboard/admin/signups", icon: "✍️" },
    { name: "Demo Requests", href: "/dashboard/admin/demos", icon: "📣" },
    { name: "Support Tickets", href: "/dashboard/admin/tickets", icon: "🎧" },
    { name: "Email Churches", href: "/dashboard/admin/email", icon: "✉️" },
    { name: "Audit Log", href: "/dashboard/admin/audit", icon: "📜" },
  ];

  let openTicketCount = 0;
  if (userRole === "super_admin") {
    try {
      const cnt = await adminDb
        .collection("support_tickets")
        .where("status", "==", "open")
        .count()
        .get();
      openTicketCount = cnt.data().count;
    } catch (err) {
      console.error("Open ticket count failed:", err);
    }
  }

  return (
    <div className="flex h-screen bg-gray-50 font-sans text-gray-900 antialiased">
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col z-20 hidden md:flex shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-gray-200">
          <h1
            className="text-xl font-black tracking-tight truncate"
            style={{ color: primaryColor }}
          >
            {churchName}
          </h1>
        </div>

        <div className="px-6 py-5">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Ministry Platform</p>
        </div>

        <nav className="flex-1 overflow-y-auto">
          <ul className="flex flex-col space-y-1">
            <li>
              <Link
                href="/dashboard"
                className="flex items-center gap-3 px-6 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-l-4 border-transparent"
              >
                <span className="text-base opacity-60">🏠</span>
                <span>Dashboard</span>
              </Link>
            </li>
            {navigation.map((item) => {
              const locked = !tenantIsPaid && PAID_NAV_HREFS.includes(item.href);
              // Locked paid modules point at billing instead of the feature page.
              return (
                <li key={item.name}>
                  <Link
                    href={locked ? "/dashboard/billing" : item.href}
                    className="flex items-center gap-3 px-6 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-l-4 border-transparent"
                  >
                    <span className="text-base opacity-60">{item.icon}</span>
                    <span className={locked ? "text-gray-400" : ""}>{item.name}</span>
                    {locked && (
                      <span className="ml-auto text-[9px] font-bold uppercase tracking-wide text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                        🔒 Paid
                      </span>
                    )}
                    {!locked && item.name === "Workflows" && ["owner", "admin", "member_manager"].includes(userRole) && (
                      <OverdueBadge tenantId={tenantId} />
                    )}
                    {!locked && item.name === "Membership Management" && (
                      <PendingApprovalBadge tenantId={tenantId} />
                    )}
                  </Link>
                </li>
              );
            })}

            {userRole === "super_admin" && (
              <>
                <li className="px-6 pt-5 pb-2">
                  <p className="text-[10px] font-bold text-amber-600 uppercase tracking-widest">Admin</p>
                </li>
                {adminNavigation.map((item) => {
                  const isTickets = item.href === "/dashboard/admin/tickets";
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="flex items-center gap-3 px-6 py-3 text-sm font-medium text-amber-800 hover:bg-amber-50 border-l-4 border-transparent hover:border-amber-400"
                      >
                        <span className="text-base opacity-70">{item.icon}</span>
                        <span>{item.name}</span>
                        {isTickets && openTicketCount > 0 && (
                          <span className="ml-auto text-[10px] font-black text-white bg-red-500 rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                            {openTicketCount}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </>
            )}
          </ul>
        </nav>

        {canSeeUsageMeter && (
          <MemberUsageMeter
            tier={tenantTier}
            activeMemberCount={activeMemberCount}
            memberLimit={memberLimit}
          />
        )}

        {tenantSlug && (
          <div className="px-4 pb-2 border-t border-gray-100 pt-3">
            {userMemberId ? (
              <a
                href={`/member/${tenantSlug}/home`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition w-full"
              >
                <span className="text-base">📱</span>
                Member App
                <span className="ml-auto text-[10px] text-emerald-500 font-medium">↗</span>
              </a>
            ) : (
              <Link
                href="/dashboard/profile"
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 transition w-full"
              >
                <span className="text-base">📱</span>
                Link Member Profile
              </Link>
            )}
          </div>
        )}

        <div className="p-4 border-t border-gray-200">
          <LogoutButton />
        </div>
      </aside>

      <main className="flex-1 flex flex-col h-screen overflow-hidden bg-gray-50">
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 md:px-8 z-10 shrink-0">
          <div className="flex items-center gap-3">
            <MobileSidebar
              navigation={navigation}
              churchName={churchName}
              primaryColor={primaryColor}
              userRole={userRole}
              tenantSlug={tenantSlug}
              userMemberId={userMemberId}
              openTicketCount={openTicketCount}
              tenantId={tenantId}
            />
            <div className="text-lg font-semibold text-gray-800">Dashboard</div>
          </div>

          <div className="flex items-center gap-4 border-l border-gray-200 pl-6">
            {/* Member App shortcut. Visible on mobile only, always in the header. */}
            {/* No target="_blank" on mobile: keeps PWA context and avoids exiting the app */}
            {tenantSlug && userMemberId && (
              <a
                href={`/member/${tenantSlug}/home`}
                className="md:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold"
              >
                📱 App
              </a>
            )}
            <div className="text-right hidden sm:block">
              <p className="text-sm font-bold text-gray-800">{userName}</p>
              <p
                className="text-xs font-medium uppercase tracking-wider"
                style={{ color: primaryColor }}
              >
                {userRole.replace("_", " ")}
              </p>
            </div>
            <div
              className="w-9 h-9 rounded flex items-center justify-center text-white font-bold text-sm uppercase"
              style={{ backgroundColor: primaryColor }}
            >
              {userName.substring(0, 2)}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6 md:p-10">
          <div className="max-w-7xl mx-auto pb-12">{children}</div>
        </div>
      </main>
    </div>
  );
}
