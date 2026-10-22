"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { db } from "../../../lib/firebase";
import DateInput from "../../../components/ui/DateInput";
import { useAppUser } from "../../../lib/useAppUser";
import { pickAutoAssignee, notifyAssignee } from "../../../lib/visitorMinistry";
import {
  collection, query, where, getDocs, addDoc,
  updateDoc, deleteDoc, doc, getDoc, serverTimestamp, onSnapshot,
} from "firebase/firestore";
import ExportMemberButton from "../../components/ExportMemberButton";
import { formatSurnameFirst, compareBySurname } from "../../../lib/nameFormat";
import NotesPanel from "../../components/NotesPanel";
import InfoTooltip from "../../components/InfoTooltip";

// ─── Types ────────────────────────────────────────────────────────────────────

const EXCEPTION_TAGS = ["School", "Work", "Medical", "Travel", "Other"];

interface AbsenceException {
  tag: string;
  note?: string;
  setAt?: string;
}

interface Member {
  id: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone: string;
  dob?: string;
  gender?: string;
  maritalStatus?: string;
  membershipType?: string;
  ministries?: string[];
  role: string;
  householdId?: string;
  householdRole?: string;
  parentId?: string;
  spouseId?: string;
  faithStatus?: { bornAgain: string; waterBaptized: string };
  consentedToPrivacyPolicy: boolean;
  branch?: string;
  cellRegion?: string;
  ministryGroup?: string;
  churchRole?: string;
  source?: string;
  absenceException?: AbsenceException | null;
  portalStatus?: "not_invited" | "invited" | "active";
  authUid?: string;
  status?: string;
  suspendedAt?: any;
  suspendedReason?: string | null;
  suspendedBy?: string;
}

interface Household {
  id: string;
  familyName?: string;
  primaryMemberId?: string;
  spouseMemberId?: string;
}

interface ChildInput {
  firstName: string;
  lastName: string;
  dob: string;
  gender: string;
  isMember: boolean;
}

interface ParentInput { name: string; surname: string; dob: string; }

interface TenantConfig {
  ministries: string[];
  membershipTypes: string[];
  roles: string[];
  branches: string[];
  cellGroupBranch: Record<string, string>;
  cellRegions: string[];
  ministryGroups: string[];
  churchRoles: string[];
}

interface FormFieldConfig {
  label: string;
  enabled: boolean;
  required: boolean;
  type: string;
  options?: string[];
}

interface CustomFieldDef {
  id: string;
  label: string;
  enabled: boolean;
  required: boolean;
  type: string;
  options?: string[];
}

interface MemberFormConfig {
  fields: Record<string, FormFieldConfig>;
  customFields: CustomFieldDef[];
}

const DEFAULT_FORM_CONFIG: MemberFormConfig = {
  fields: {
    role: { label: "Church Role", enabled: true, required: false, type: "dropdown", options: [] },
    branch: { label: "Branch", enabled: true, required: false, type: "dropdown", options: [] },
    cellRegion: { label: "Cell Group", enabled: true, required: false, type: "dropdown", options: [] },
    ministryGroup: { label: "Ministry Group", enabled: true, required: false, type: "dropdown", options: [] },
    churchRole: { label: "Church Role / Office", enabled: true, required: false, type: "dropdown", options: [] },
    membershipType: { label: "Type of Membership Sought", enabled: true, required: false, type: "dropdown", options: [] },
    maritalStatus: { label: "Marital Status", enabled: true, required: false, type: "dropdown", options: [] },
    bornAgain: { label: "Born Again?", enabled: true, required: false, type: "dropdown", options: [] },
    waterBaptized: { label: "Water Baptized?", enabled: true, required: false, type: "dropdown", options: [] },
    address: { label: "Residential Address", enabled: true, required: false, type: "text" },
  },
  customFields: [],
};

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MINISTRIES = [
  "Intercessory", "Band", "Worship Team", "Media Team (Sound)",
  "Media Team (Visuals)", "Ushering", "Hospitality", "Kingdom Kids", "Events Security",
];
const DEFAULT_MEMBERSHIP_TYPES = ["Full Active", "Associate"];
const DEFAULT_ROLES = ["Member", "Pastor", "Youth Leader", "Treasurer", "Branch Administrator"];
const DEFAULT_BRANCHES: string[] = [];
const DEFAULT_CELL_REGIONS: string[] = [];

// ─── Branch / Cell Group helpers ────────────────────────────────────────────
// A cell group belongs to a branch via the cellGroupBranch map. Legacy cell
// groups with no branch assigned stay visible under every branch so nothing
// disappears when branches are first switched on.
function cellGroupsForBranch(
  cellGroups: string[],
  cellGroupBranch: Record<string, string>,
  branch: string,
): string[] {
  if (!branch) return cellGroups;
  return cellGroups.filter(cg => !cellGroupBranch[cg] || cellGroupBranch[cg] === branch);
}
const DEFAULT_MINISTRY_GROUPS = ["Youth", "Mens Fellowship", "Womens Ministry", "Seniors"];
const DEFAULT_CHURCH_ROLES: string[] = ["Elder", "Deacon", "Deaconess", "Trustee"];

// Southern African country codes (default ZA)
const COUNTRY_CODES = [
  { code: "27",  label: "ZA", name: "South Africa" },
  { code: "263", label: "ZW", name: "Zimbabwe" },
  { code: "260", label: "ZM", name: "Zambia" },
  { code: "267", label: "BW", name: "Botswana" },
  { code: "264", label: "NA", name: "Namibia" },
  { code: "258", label: "MZ", name: "Mozambique" },
  { code: "266", label: "LS", name: "Lesotho" },
  { code: "268", label: "SZ", name: "Eswatini" },
  { code: "44",  label: "UK", name: "United Kingdom" },
  { code: "1",   label: "US", name: "United States" },
];

const emptyPerson = () => ({
  firstName: "", lastName: "", dob: "", gender: "", email: "", phone: "",
  countryCode: "27",
  maritalStatus: "", branch: "", cellRegion: "", ministryGroup: "", churchRole: "",
  address: { line1: "", line2: "", suburb: "", town: "", postalCode: "" },
  bornAgain: "", waterBaptized: "", membershipType: "", ministries: [] as string[],
  role: "Member",
});
const emptyParent = (): ParentInput => ({ name: "", surname: "", dob: "" });

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Convert Excel serial date numbers (e.g. 39710) to YYYY-MM-DD strings
function normalizeDob(val: any): string {
  if (!val && val !== 0) return "";
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const str = String(val).trim();
  if (/^\d+$/.test(str)) {
    const n = parseInt(str, 10);
    // Excel serial range sanity check (1 Jan 1900 = 1, 1 Jan 2100 = ~73050)
    if (n > 1000 && n < 80000) {
      const d = new Date((n - 25569) * 86400000);
      return d.toISOString().slice(0, 10);
    }
  }
  // Text dates: accept YYYY/MM/DD and DD/MM/YYYY (with / or - separators) -> ISO YYYY-MM-DD
  let m = str.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/); // YYYY/MM/DD
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/); // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return str;
}

function isUnder16(dob?: string): boolean {
  if (!dob) return false;
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return false;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 16);
  return birth > cutoff;
}

function calcAge(dob: string): number | null {
  if (!dob) return null;
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function assignMinistryGroup(dob: string, gender: string, maritalStatus: string): string {
  const age = calcAge(dob);
  if (age === null) return "";
  const isMarried = maritalStatus.toLowerCase() === "married";
  const isMale = gender.toLowerCase() === "male" || gender.toLowerCase() === "m";
  if (age <= 12) return "Kingdom Kids";
  if (age <= 17) return "Kingdom Arsenals";
  // 18+: married always goes to gender group
  if (isMarried) return isMale ? "Mighty Men" : "Women of Faith";
  if (age <= 35) return "Youth";
  return isMale ? "Mighty Men" : "Women of Faith";
}

function fmtPhone(raw: string, countryCode: string = "27"): string {
  const c = raw.trim().replace(/\s+/g, "").replace(/^\+/, "");
  if (c.startsWith("0")) return countryCode + c.substring(1);
  return c;
}

function parseDobParts(dob: string): { mm: number; dd: number } | null {
  // Handle YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    const [, mm, dd] = dob.split("-").map(Number);
    return { mm, dd };
  }
  // Handle DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dob)) {
    const [dd, mm] = dob.split("/").map(Number);
    return { mm, dd };
  }
  // Handle D/M/YYYY or D/MM/YYYY variants
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dob)) {
    const [dd, mm] = dob.split("/").map(Number);
    return { mm, dd };
  }
  return null;
}

function daysUntilBirthday(dob?: string): number | null {
  if (!dob) return null;
  const parts = parseDobParts(dob);
  if (!parts) return null;
  const { mm, dd } = parts;
  if (isNaN(mm) || isNaN(dd) || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let next = new Date(today.getFullYear(), mm - 1, dd);
  if (next < today) next = new Date(today.getFullYear() + 1, mm - 1, dd);
  return Math.round((next.getTime() - today.getTime()) / 86400000);
}

// ─── Small UI pieces ──────────────────────────────────────────────────────────

const inp = "border p-2 rounded text-sm text-gray-700 focus:outline-blue-500 w-full";
const sel = "border p-2 rounded text-sm text-gray-700 bg-white focus:outline-blue-500 w-full";

function F({ label, req, children }: { label: string; req?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
        {label}{req && <span className="text-red-500 ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}

function SecHead({ n, title, sub }: { n: string; title: string; sub?: string }) {
  return (
    <div className="flex items-start gap-3 pb-3 border-b border-gray-200 mb-1">
      <span className="w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
        {n}
      </span>
      <div>
        <p className="text-base font-bold text-gray-800">{title}</p>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function AddrBlock({
  v, on, disabled = false,
}: { v: ReturnType<typeof emptyPerson>["address"]; on: (k: string, val: string) => void; disabled?: boolean }) {
  const disabledClass = disabled ? "bg-gray-100 cursor-not-allowed" : "";
  return (
    <div className="flex flex-col gap-2">
      <input disabled={disabled} value={v.line1} onChange={e => on("line1", e.target.value)} placeholder="Street address" className={`${inp} ${disabledClass}`} required />
      <input disabled={disabled} value={v.line2} onChange={e => on("line2", e.target.value)} placeholder="Line 2 (optional)" className={`${inp} ${disabledClass}`} />
      <div className="grid grid-cols-3 gap-2">
        <input disabled={disabled} value={v.suburb} onChange={e => on("suburb", e.target.value)} placeholder="Suburb" className={`${inp} ${disabledClass}`} required />
        <input disabled={disabled} value={v.town} onChange={e => on("town", e.target.value)} placeholder="Town / City" className={`${inp} ${disabledClass}`} required />
        <input disabled={disabled} value={v.postalCode} onChange={e => on("postalCode", e.target.value)} placeholder="Postal code" className={`${inp} ${disabledClass}`} required />
      </div>
    </div>
  );
}

function MinChecks({ list, sel: selected, on }: { list: string[]; sel: string[]; on: (v: string[]) => void }) {
  const toggle = (m: string) => on(selected.includes(m) ? selected.filter(x => x !== m) : [...selected, m]);
  return (
    <div className="grid grid-cols-2 gap-2">
      {list.map(m => (
        <label key={m} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
          <input type="checkbox" checked={selected.includes(m)} onChange={() => toggle(m)}
            className="h-4 w-4 rounded text-blue-600 border-gray-300" />
          {m}
        </label>
      ))}
    </div>
  );
}

// ─── Full member input block (reused for primary + spouse) ────────────────────

function MemberBlock({
  data, set, config, formConfig, showFaith = true, ageRestricted = false,
  customValues, setCustomValues, addressDisabled = false, lockedBranch = "",
}: {
  data: ReturnType<typeof emptyPerson>;
  set: (k: string, v: any) => void;
  config: TenantConfig;
  formConfig: MemberFormConfig;
  showFaith?: boolean;
  ageRestricted?: boolean;
  customValues?: Record<string, string>;
  setCustomValues?: (vals: Record<string, string>) => void;
  addressDisabled?: boolean;
  lockedBranch?: string;
}) {
  const fc = formConfig.fields;
  const roleOpts = fc.role?.options?.length ? fc.role.options : config.roles;
  const branchOpts = fc.branch?.options?.length ? fc.branch.options : config.branches;
  // A branch admin can only file people under their own branch, so the branch
  // is fixed and shown read-only rather than as a dropdown.
  const showBranch = !lockedBranch && branchOpts.length > 1;
  useEffect(() => {
    if (lockedBranch) {
      if (data.branch !== lockedBranch) set("branch", lockedBranch);
    } else if (branchOpts.length === 1 && !data.branch) {
      // Single branch: quietly default to it so the record still carries one.
      set("branch", branchOpts[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchOpts.length, lockedBranch]);
  const allCellOpts = fc.cellRegion?.options?.length ? fc.cellRegion.options : config.cellRegions;
  const cellOpts = cellGroupsForBranch(allCellOpts, config.cellGroupBranch || {}, data.branch);
  const mgOpts = fc.ministryGroup?.options?.length ? fc.ministryGroup.options : config.ministryGroups;
  const crOpts = fc.churchRole?.options?.length ? fc.churchRole.options : config.churchRoles;
  const mtOpts = fc.membershipType?.options?.length ? fc.membershipType.options : config.membershipTypes;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <F label="First Name" req><input value={data.firstName} onChange={e => set("firstName", e.target.value)} placeholder="e.g. Jane" className={inp} required /></F>
        <F label="Last Name" req><input value={data.lastName} onChange={e => set("lastName", e.target.value)} placeholder="e.g. Doe" className={inp} required /></F>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <F label="Date of Birth" req><DateInput value={data.dob} onChange={val => set("dob", val)} className={inp} required /></F>
        <F label="Gender" req>
          <select value={data.gender} onChange={e => set("gender", e.target.value)} className={sel} required>
            <option value="">Select</option>
            <option>Male</option><option>Female</option>
          </select>
        </F>
      </div>
      <F label="Email Address">
        <input type="email" value={data.email} onChange={e => set("email", e.target.value)} placeholder="e.g. jane@gmail.com (optional)" className={inp} />
      </F>
      <F label="Contact Number" req={!ageRestricted}>
        <div className="flex gap-2">
          <select
            value={data.countryCode || "27"}
            onChange={e => set("countryCode", e.target.value)}
            className="border p-2 rounded text-sm text-gray-700 bg-white focus:outline-blue-500 w-24 shrink-0"
          >
            {COUNTRY_CODES.map(c => (
              <option key={c.code} value={c.code}>{c.label} +{c.code}</option>
            ))}
          </select>
          <input type="tel" value={data.phone} onChange={e => set("phone", e.target.value)} placeholder="e.g. 0812345678" className={`${inp} flex-1`} required={!ageRestricted} />
        </div>
      </F>
      {(fc.address?.enabled !== false) && (
        <F label={fc.address?.label || "Residential Address"} req={fc.address?.required}>
          <AddrBlock v={data.address} on={(k, v) => set("address", { ...data.address, [k]: v })} disabled={addressDisabled} />
        </F>
      )}
      {(fc.role?.enabled !== false) && (
        <F label={fc.role?.label || "Church Role"} req={fc.role?.required}>
          <select value={data.role} onChange={e => set("role", e.target.value)} className={sel}>
            {roleOpts.map(r => <option key={r}>{r}</option>)}
          </select>
        </F>
      )}
      {lockedBranch && (
        <F label={fc.branch?.label || "Branch"}>
          <div className="border border-gray-100 rounded px-3 py-2 text-sm text-gray-500 bg-gray-50">
            {lockedBranch}
          </div>
        </F>
      )}
      {showBranch && (fc.branch?.enabled !== false) && (
        <F label={fc.branch?.label || "Branch"} req={fc.branch?.required}>
          <select
            value={data.branch}
            onChange={e => {
              const b = e.target.value;
              set("branch", b);
              // Drop a cell group that no longer belongs to the chosen branch.
              const stillValid = cellGroupsForBranch(allCellOpts, config.cellGroupBranch || {}, b);
              if (data.cellRegion && !stillValid.includes(data.cellRegion)) set("cellRegion", "");
            }}
            className={sel}
            required={fc.branch?.required}
          >
            <option value="">Select</option>
            {data.branch && !branchOpts.includes(data.branch) && (
              <option value={data.branch}>{data.branch}</option>
            )}
            {branchOpts.map(b => <option key={b}>{b}</option>)}
          </select>
        </F>
      )}
      {(fc.cellRegion?.enabled !== false) && (
        <F label={fc.cellRegion?.label || "Cell Group"} req={fc.cellRegion?.required}>
          <select value={data.cellRegion} onChange={e => set("cellRegion", e.target.value)} className={sel}>
            <option value="">Select</option>
            {data.cellRegion && !cellOpts.includes(data.cellRegion) && (
              <option value={data.cellRegion}>{data.cellRegion}</option>
            )}
            {cellOpts.map(r => <option key={r}>{r}</option>)}
          </select>
        </F>
      )}
      {(fc.ministryGroup?.enabled !== false) && (
        <F label={fc.ministryGroup?.label || "Ministry Group"} req={fc.ministryGroup?.required}>
          <select value={data.ministryGroup} onChange={e => set("ministryGroup", e.target.value)} className={sel}>
            <option value="">Select</option>
            {data.ministryGroup && !mgOpts.includes(data.ministryGroup) && (
              <option value={data.ministryGroup}>{data.ministryGroup}</option>
            )}
            {mgOpts.map(g => <option key={g}>{g}</option>)}
          </select>
        </F>
      )}
      {(fc.churchRole?.enabled !== false) && (
        <F label={fc.churchRole?.label || "Church Role / Office"} req={fc.churchRole?.required}>
          <select value={data.churchRole} onChange={e => set("churchRole", e.target.value)} className={sel}>
            <option value="">None / General Member</option>
            {data.churchRole && !crOpts.includes(data.churchRole) && (
              <option value={data.churchRole}>{data.churchRole}</option>
            )}
            {crOpts.map(r => <option key={r}>{r}</option>)}
          </select>
        </F>
      )}
      {showFaith && (
        <>
          {(fc.bornAgain?.enabled !== false) && (
            <F label={fc.bornAgain?.label || "Born Again?"} req={fc.bornAgain?.required}>
              <select value={data.bornAgain} onChange={e => set("bornAgain", e.target.value)} className={sel} required={fc.bornAgain?.required}>
                <option value="">Select</option><option>Yes</option><option>No</option>
              </select>
            </F>
          )}
          {(fc.waterBaptized?.enabled !== false) && (
            <F label={fc.waterBaptized?.label || "Water Baptized?"} req={fc.waterBaptized?.required}>
              <select value={data.waterBaptized} onChange={e => set("waterBaptized", e.target.value)} className={sel} required={fc.waterBaptized?.required}>
                <option value="">Select</option><option>Yes</option><option>No</option>
              </select>
            </F>
          )}
          {(fc.membershipType?.enabled !== false) && (
            <F label={fc.membershipType?.label || "Type of Membership Sought"} req={fc.membershipType?.required}>
              <select value={data.membershipType} onChange={e => set("membershipType", e.target.value)} className={sel} required={fc.membershipType?.required}>
                <option value="">Select</option>
                {mtOpts.map(t => <option key={t}>{t}</option>)}
              </select>
            </F>
          )}
          {config.ministries.length > 0 && (
            <F label="Ministries to Serve In">
              <MinChecks list={config.ministries} sel={data.ministries} on={v => set("ministries", v)} />
            </F>
          )}
        </>
      )}

      {/* Custom fields */}
      {formConfig.customFields.filter(f => f.enabled).map(cf => (
        <F key={cf.id} label={cf.label} req={cf.required}>
          {cf.type === "dropdown" ? (
            <select
              value={customValues?.[cf.id] || ""}
              onChange={e => setCustomValues?.({ ...customValues, [cf.id]: e.target.value })}
              className={sel}
              required={cf.required}
            >
              <option value="">Select</option>
              {(cf.options || []).map(o => <option key={o}>{o}</option>)}
            </select>
          ) : (
            <input
              value={customValues?.[cf.id] || ""}
              onChange={e => setCustomValues?.({ ...customValues, [cf.id]: e.target.value })}
              className={inp}
              required={cf.required}
            />
          )}
        </F>
      ))}
    </div>
  );
}

// ─── Free-tier upgrade modal ────────────────────────────────────────────────
// Shown instead of a raw error when a free church hits its member cap.
function UpgradeLimitModal({
  open,
  limit,
  onClose,
}: {
  open: boolean;
  limit: number | null;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-xl">
            🌱
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Your church has grown</h2>
            <p className="mt-1 text-sm text-gray-600">
              You have reached the free plan limit of {limit ?? 50} active members.
              Upgrade to the Church plan for R159 a month for unlimited members and
              every module.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <a
            href="/dashboard/billing"
            className="inline-flex justify-center rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition"
          >
            Upgrade for R159/mo
          </a>
          <button
            onClick={onClose}
            className="inline-flex justify-center rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition"
          >
            Not now
          </button>
        </div>
        <p className="mt-3 text-xs text-gray-400">
          Tip: archiving members who have left frees up space on the free plan.
        </p>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ManageMembershipPage() {
  const { appUser, loading: userLoading } = useAppUser();

  const [invitingMemberId, setInvitingMemberId] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const [bulkInviting, setBulkInviting] = useState(false);
  const [bulkInviteResult, setBulkInviteResult] = useState<{ invited: number; skipped: number; failed: number } | null>(null);
  const [view, setView] = useState<"list" | "form" | "import" | "configure" | "pending" | "suspended">("list");
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [showJoinLink, setShowJoinLink] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [households, setHouseholds] = useState<Household[]>([]);

  // ── Suspend / reinstate membership ──
  const [suspendModalMember, setSuspendModalMember] = useState<Member | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [suspending, setSuspending] = useState(false);

  // ── Family linking ──
  const [joinExistingFamily, setJoinExistingFamily] = useState(false);
  const [familySearch, setFamilySearch] = useState("");
  const [familyTargetId, setFamilyTargetId] = useState("");
  const [familyRole, setFamilyRole] = useState<"spouse" | "child" | "parent" | "other">("child");
  const [linkFamilyMember, setLinkFamilyMember] = useState<Member | null>(null);
  const [linkFamilySearch, setLinkFamilySearch] = useState("");
  const [linkFamilyTargetId, setLinkFamilyTargetId] = useState("");
  const [linkFamilyRole, setLinkFamilyRole] = useState<"spouse" | "child" | "parent" | "other">("child");
  const [linkingFamily, setLinkingFamily] = useState(false);
  const [familyModalId, setFamilyModalId] = useState<string | null>(null);
  // ── Filter state ──
  const [memberSearch, setMemberSearch] = useState("");
  const [filterMinistryGroup, setFilterMinistryGroup] = useState("");
  const [filterMaritalStatus, setFilterMaritalStatus] = useState("");
  const [filterBranch, setFilterBranch] = useState("");
  const [filterCellRegion, setFilterCellRegion] = useState("");
  const [filterBornAgain, setFilterBornAgain] = useState("");
  const [filterWaterBaptized, setFilterWaterBaptized] = useState("");
  const [filterMembershipType, setFilterMembershipType] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [config, setConfig] = useState<TenantConfig>({
    ministries: DEFAULT_MINISTRIES,
    membershipTypes: DEFAULT_MEMBERSHIP_TYPES,
    roles: DEFAULT_ROLES,
    branches: DEFAULT_BRANCHES,
    cellGroupBranch: {},
    cellRegions: DEFAULT_CELL_REGIONS,
    ministryGroups: DEFAULT_MINISTRY_GROUPS,
    churchRoles: DEFAULT_CHURCH_ROLES,
  });
  const [formConfig, setFormConfig] = useState<MemberFormConfig>(DEFAULT_FORM_CONFIG);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>({});
  const [memberWorkflows, setMemberWorkflows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // ── Free-tier member cap ──
  const [tier, setTier] = useState<string | null>(null);
  const [activeMemberCount, setActiveMemberCount] = useState<number | null>(null);
  const [memberLimit, setMemberLimit] = useState<number | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  // Configure lists state
  const [editMinistries, setEditMinistries] = useState<string[]>([]);
  const [editMembershipTypes, setEditMembershipTypes] = useState<string[]>([]);
  const [editBranches, setEditBranches] = useState<string[]>([]);
  const [editCellGroupBranch, setEditCellGroupBranch] = useState<Record<string, string>>({});
  const [editCellRegions, setEditCellRegions] = useState<string[]>([]);
  const [editMinistryGroups, setEditMinistryGroups] = useState<string[]>([]);
  const [editChurchRoles, setEditChurchRoles] = useState<string[]>([]);
  const [newMinistry, setNewMinistry] = useState("");
  const [newMembershipType, setNewMembershipType] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [newCellRegion, setNewCellRegion] = useState("");
  const [newCellRegionBranch, setNewCellRegionBranch] = useState("");
  const [newMinistryGroup, setNewMinistryGroup] = useState("");
  const [newChurchRole, setNewChurchRole] = useState("");
  const [configSaving, setConfigSaving] = useState(false);

  // Primary member
  const [primary, setPrimary] = useState(emptyPerson());
  const setP = (k: string, v: any) => setPrimary(p => ({ ...p, [k]: v }));

  // Spouse
  const [isSpouseMember, setIsSpouseMember] = useState<"" | "yes" | "no">("");
  const [spouse, setSpouse] = useState(emptyPerson());
  const setSp = (k: string, v: any) => setSpouse(p => ({ ...p, [k]: v }));
  const [spouseBasic, setSpouseBasic] = useState({ firstName: "", lastName: "", dob: "", gender: "", phone: "" });
  const [spouseSameAddress, setSpouseSameAddress] = useState(false);

  // Children
  const [children, setChildren] = useState<ChildInput[]>([]);

  // Parents / in-laws
  const [parents, setParents] = useState({ mother: emptyParent(), father: emptyParent() });
  const [inLaws, setInLaws] = useState({ motherInLaw: emptyParent(), fatherInLaw: emptyParent() });

  // POPIA
  const [consent, setConsent] = useState({ privacy: false, special: false, truth: false });

  // Exception state
  const [editingMemberException, setEditingMemberException] = useState<AbsenceException | null>(null);
  const [showExceptionModal, setShowExceptionModal] = useState(false);
  const [exceptionTag, setExceptionTag] = useState("School");
  const [exceptionNote, setExceptionNote] = useState("");
  const [customTag, setCustomTag] = useState("");
  const [savingException, setSavingException] = useState(false);
  const [clearingException, setClearingException] = useState(false);

  // Import
  const [importRows, setImportRows] = useState<any[]>([]);
  const [importParsing, setImportParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importCountryCode, setImportCountryCode] = useState("27");
  const fileRef = useRef<HTMLInputElement>(null);

  // Duplicate detection
  interface DuplicateFlag { rowIndex: number; importName: string; importDob: string; existingName: string; }
  const [duplicateWarning, setDuplicateWarning] = useState<{ dups: DuplicateFlag[]; total: number } | null>(null);

  // ─── Load ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (userLoading || !appUser) { if (!userLoading) setLoading(false); return; }
    const load = async () => {
      try {
        const tenantSnap = await getDoc(doc(db, "tenants", appUser.tenantId));
        if (tenantSnap.exists()) {
          const td = tenantSnap.data();
          setConfig({
            ministries: td.ministries?.length ? td.ministries : DEFAULT_MINISTRIES,
            membershipTypes: td.membershipTypes?.length ? td.membershipTypes : DEFAULT_MEMBERSHIP_TYPES,
            roles: td.roles?.length ? td.roles : DEFAULT_ROLES,
            branches: td.branches?.length ? td.branches : DEFAULT_BRANCHES,
            cellGroupBranch: td.cellGroupBranch || {},
            cellRegions: td.cellRegions?.length ? td.cellRegions : DEFAULT_CELL_REGIONS,
            ministryGroups: td.ministryGroups?.length ? td.ministryGroups : DEFAULT_MINISTRY_GROUPS,
            churchRoles: td.churchRoles?.length ? td.churchRoles : DEFAULT_CHURCH_ROLES,
          });
          // Free-tier limit fields, used to guard the add-member flows below.
          setTier(td.tier ?? null);
          setActiveMemberCount(typeof td.activeMemberCount === "number" ? td.activeMemberCount : null);
          setMemberLimit(typeof td.memberLimit === "number" ? td.memberLimit : null);
        }
        // Load form config from Church Settings
        try {
          const fcSnap = await getDoc(doc(db, "tenants", appUser.tenantId, "settings", "formConfig"));
          if (fcSnap.exists()) {
            const fcData = fcSnap.data() as { member?: MemberFormConfig };
            if (fcData.member) {
              setFormConfig({
                fields: { ...DEFAULT_FORM_CONFIG.fields, ...fcData.member.fields },
                customFields: fcData.member.customFields || [],
              });
            }
          }
        } catch (e) { console.warn("formConfig load failed:", e); }
        // Cell leaders only see their assigned cell group; branch admins only
        // see their assigned branch. Everyone else sees the whole tenant.
        const isCellLeader = appUser.role === "cell_leader";
        const isBranchAdmin = appUser.role === "branch_admin";
        const q = isCellLeader && appUser.assignedCellRegion
          ? query(collection(db, "members"), where("tenantId", "==", appUser.tenantId), where("cellRegion", "==", appUser.assignedCellRegion))
          : isBranchAdmin && appUser.assignedBranch
          ? query(collection(db, "members"), where("tenantId", "==", appUser.tenantId), where("branch", "==", appUser.assignedBranch))
          : query(collection(db, "members"), where("tenantId", "==", appUser.tenantId));
        const snap = await getDocs(q);
        const list: Member[] = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() } as Member));
        list.sort(compareBySurname);

        // Household records, used to label and display family links. Loaded
        // once alongside members; cheap since it's one doc per family.
        try {
          const hhSnap = await getDocs(query(collection(db, "households"), where("tenantId", "==", appUser.tenantId)));
          setHouseholds(hhSnap.docs.map(d => ({ id: d.id, ...d.data() } as Household)));
        } catch (e) { console.warn("Household load failed:", e); }

        // ── One-time backfill: write firstName/lastName into any Firestore doc that
        //    only has fullName stored (legacy records). Runs silently; no-ops once
        //    every member has proper dedicated fields.
        const needsBackfill = list.filter(m => !m.firstName || !m.lastName);
        if (needsBackfill.length > 0) {
          await Promise.all(needsBackfill.map(m => {
            const parts = (m.fullName || "").trim().split(/\s+/);
            const first = m.firstName || parts[0] || "";
            const last  = m.lastName  || parts.slice(1).join(" ") || "";
            // Update local state so the export reflects the fix immediately
            m.firstName = first;
            m.lastName  = last;
            // Persist to Firestore
            return updateDoc(doc(db, "members", m.id), { firstName: first, lastName: last });
          }));
        }

        setMembers(list);
      } catch (e) { console.error("Load error:", e); }
      finally { setLoading(false); }
    };
    load();
  }, [appUser, userLoading]);

  // ── Restore the register scroll position ──────────────────────────────────
  // When you open a member and come back, jump to where you were instead of the
  // top of the list. We only restore once the members have actually rendered,
  // otherwise the page is still short and the browser has nowhere to scroll to.
  useEffect(() => {
    if (loading || view !== "list" || members.length === 0) return;
    const saved = sessionStorage.getItem("rosterScrollY");
    if (saved) {
      // Wait a tick so the list rows are painted before we scroll.
      requestAnimationFrame(() => {
        window.scrollTo(0, parseInt(saved, 10));
        sessionStorage.removeItem("rosterScrollY");
      });
    }
  }, [loading, view, members.length]);

  // ─── Pending membership requests ─────────────────────────────────────────────

  const loadPending = async () => {
    if (!appUser) return;
    setPendingLoading(true);
    try {
      const q = query(
        collection(db, "memberRequests"),
        where("tenantId", "==", appUser.tenantId),
        where("status", "==", "pending")
      );
      const snap = await getDocs(q);
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      list.sort((a, b) => (a.submittedAt?.seconds || 0) - (b.submittedAt?.seconds || 0));
      setPendingRequests(list);
    } catch (e) { console.error(e); }
    finally { setPendingLoading(false); }
  };

  const approvePending = async (req: any) => {
    if (!appUser) return;
    // Approving a self-join adds one active member. Guard the free-tier cap.
    if (wouldExceedLimit(1)) { setShowUpgradeModal(true); return; }
    try {
      const { id, status, submittedAt, source, tenantId: _t, ...memberData } = req;
      await addDoc(collection(db, "members"), {
        ...memberData,
        tenantId: appUser.tenantId,
        role: memberData.role || "Member",
        source: "self-join",
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "memberRequests", req.id), { status: "approved" });
      bumpLocalCount(1);
      setPendingRequests((p) => p.filter((r) => r.id !== req.id));
    } catch (e: any) {
      console.error(e);
      if (isLimitError(e)) setShowUpgradeModal(true);
      else alert("Failed to approve. Please try again.");
    }
  };

  const rejectPending = async (reqId: string) => {
    if (!appUser) return;
    try {
      await updateDoc(doc(db, "memberRequests", reqId), { status: "rejected" });
      setPendingRequests((p) => p.filter((r) => r.id !== reqId));
    } catch (e) { console.error(e); alert("Failed to reject. Please try again."); }
  };

  // ─── Reset ──────────────────────────────────────────────────────────────────

  const reset = () => {
    setPrimary(emptyPerson());
    setIsSpouseMember(""); setSpouse(emptyPerson());
    setSpouseBasic({ firstName: "", lastName: "", dob: "", gender: "", phone: "" });
    setChildren([]); setParents({ mother: emptyParent(), father: emptyParent() });
    setInLaws({ motherInLaw: emptyParent(), fatherInLaw: emptyParent() });
    setConsent({ privacy: false, special: false, truth: false });
    setCustomFieldValues({});
    setFeedback(null);
    setJoinExistingFamily(false);
    setFamilySearch(""); setFamilyTargetId(""); setFamilyRole("child");
  };

  // ─── Children helpers ───────────────────────────────────────────────────────

  const addChild = () => setChildren(p => [...p, { firstName: "", lastName: "", dob: "", gender: "", isMember: false }]);
  const updChild = (i: number, k: string, v: any) => setChildren(p => p.map((c, idx) => idx === i ? { ...c, [k]: v } : c));
  const rmChild = (i: number) => setChildren(p => p.filter((_, idx) => idx !== i));

  // ─── Refresh member list ────────────────────────────────────────────────────

  const refreshList = async () => {
    if (!appUser) return;
    const q = query(collection(db, "members"), where("tenantId", "==", appUser.tenantId));
    const snap = await getDocs(q);
    const list: Member[] = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() } as Member));
    list.sort(compareBySurname);
    setMembers(list);
  };

  // ─── Portal invite ───────────────────────────────────────────────────────────

  const inviteMemberToPortal = async (memberId: string) => {
    setInvitingMemberId(memberId);
    setInviteResult(null);
    try {
      const res = await fetch("/api/invite-member", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setInviteResult({ id: memberId, ok: false, msg: data.error || "Failed to send invite." });
      } else {
        setInviteResult({ id: memberId, ok: true, msg: data.emailSent ? "Invite sent." : "Account created. Copy link to share manually." });
        // Optimistically update local state
        setMembers(prev => prev.map(m => m.id === memberId ? { ...m, portalStatus: "invited" } : m));
      }
    } catch {
      setInviteResult({ id: memberId, ok: false, msg: "Network error." });
    } finally {
      setInvitingMemberId(null);
    }
  };

  const bulkInviteMembers = async () => {
    if (!confirm("Send portal invites to all members who have an email address and have not yet been invited?")) return;
    setBulkInviting(true);
    setBulkInviteResult(null);
    try {
      const res = await fetch("/api/bulk-invite-members", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setBulkInviteResult({ invited: data.invited, skipped: data.skipped, failed: data.failed });
        // Refresh member list to pick up updated portalStatus fields
        setMembers(prev => prev.map(m => m.email ? { ...m, portalStatus: m.portalStatus || "invited" } : m));
      }
    } catch {
      setBulkInviteResult({ invited: 0, skipped: 0, failed: 1 });
    } finally {
      setBulkInviting(false);
    }
  };

  // ─── Trigger member_added workflows ─────────────────────────────────────────

  const triggerMemberWorkflows = async (memberId: string, memberName: string, memberPhone: string) => {
    if (!appUser) return;
    try {
      const wfSnap = await getDocs(query(
        collection(db, "workflows"),
        where("tenantId", "==", appUser.tenantId),
        where("trigger", "==", "member_added"),
        where("active", "==", true),
      ));
      for (const wfDoc of wfSnap.docs) {
        const wf = wfDoc.data();
        const stepsSnap = await getDocs(query(
          collection(db, "workflow_steps"),
          where("tenantId", "==", appUser.tenantId),
          where("workflowId", "==", wfDoc.id),
        ));
        const steps = stepsSnap.docs
          .map((d) => ({ id: d.id, ...d.data() } as any))
          .sort((a: any, b: any) => a.order - b.order);
        if (steps.length === 0) continue;

        const addDays = (days: number) => {
          const d = new Date();
          d.setDate(d.getDate() + days);
          return d.toISOString().split("T")[0];
        };

        // Auto-assign a responsible person, spreading load. Prefers the
        // Follow-Up Team, falls back to the whole team when none is set.
        let assignee: { uid: string; name: string } | null = null;
        try {
          const picked = await pickAutoAssignee(appUser.tenantId);
          if (picked) assignee = { uid: picked.uid, name: picked.name };
        } catch (e) { console.warn("Auto-assign skipped:", e); }

        const instanceRef = await addDoc(collection(db, "workflow_instances"), {
          workflowId: wfDoc.id,
          workflowName: wf.name || "",
          tenantId: appUser.tenantId,
          subjectId: memberId,
          subjectName: memberName,
          subjectPhone: memberPhone,
          subjectType: "member",
          status: "active",
          completedSteps: 0,
          totalSteps: steps.length,
          // Needed for the Workflows dashboard, which sorts active instances by
          // nextDueDate. Without it the instance is invisible on that list.
          nextDueDate: addDays(steps[0]?.delayDays || 0),
          overdueCount: 0,
          dueTodayCount: 0,
          startedAt: serverTimestamp(),
          ...(assignee ? { assignedToUid: assignee.uid, assignedToName: assignee.name } : {}),
        });

        if (assignee) {
          notifyAssignee({
            assigneeUid: assignee.uid,
            subjectName: memberName,
            subjectPhone: memberPhone,
            kind: "member",
          });
        }

        for (const step of steps) {
          await addDoc(collection(db, "workflow_instance_steps"), {
            instanceId: instanceRef.id,
            workflowId: wfDoc.id,
            tenantId: appUser.tenantId,
            stepId: step.id,
            stepOrder: step.order,
            actionType: step.actionType,
            title: step.title,
            message: step.message,
            dependsOnStepIds: step.dependsOnStepIds || [],
            dueDate: addDays(step.delayDays || 0),
            status: "pending",
          });
        }
        await updateDoc(doc(db, "workflows", wfDoc.id), {
          instanceCount: (wf.instanceCount || 0) + 1,
        });
      }
    } catch (err) {
      console.error("Member workflow trigger error:", err);
    }
  };

  // ─── Submit form ─────────────────────────────────────────────────────────────

  // ─── Free-tier limit helpers ──────────────────────────────────────────────
  const isFreeTier = tier === "free";
  // True when a free church is already at or over its cap.
  const atMemberLimit =
    isFreeTier &&
    typeof activeMemberCount === "number" &&
    typeof memberLimit === "number" &&
    activeMemberCount >= memberLimit;
  // True when adding `toAdd` active members would push a free church past the cap.
  const wouldExceedLimit = (toAdd: number) =>
    isFreeTier &&
    typeof activeMemberCount === "number" &&
    typeof memberLimit === "number" &&
    activeMemberCount + toAdd > memberLimit;
  // The security rule denies the write with permission-denied when the cap is
  // hit. On a free tenant that means "you are full", so we show the upgrade
  // modal rather than a generic failure.
  const isLimitError = (err: any) => isFreeTier && err?.code === "permission-denied";
  // Keep the local count roughly in step after a successful add, so a second
  // add in the same session is guarded correctly without a full reload.
  const bumpLocalCount = (n: number) =>
    setActiveMemberCount((c) => (typeof c === "number" ? c + n : c));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appUser) return;
    if (!consent.privacy) { setFeedback({ ok: false, text: "Privacy policy consent is required." }); return; }

    // How many active member records this submission will create.
    const memberChildrenToAdd = children.filter((c) => c.isMember).length;
    const toAdd =
      1 +
      (primary.maritalStatus === "Married" && isSpouseMember === "yes" ? 1 : 0) +
      memberChildrenToAdd;
    if (wouldExceedLimit(toAdd)) { setShowUpgradeModal(true); return; }

    setSubmitting(true); setFeedback(null);

    try {
      const isMarried = primary.maritalStatus === "Married";

      // 1. Create household document
      const householdRef = await addDoc(collection(db, "households"), {
        tenantId: appUser.tenantId,
        familyName: primary.lastName.trim(),
        parents: { mother: parents.mother, father: parents.father },
        inLaws: isMarried ? { motherInLaw: inLaws.motherInLaw, fatherInLaw: inLaws.fatherInLaw } : null,
        nonMemberSpouse: isMarried && isSpouseMember === "no" ? spouseBasic : null,
        nonMemberChildren: children.filter(c => !c.isMember),
        createdAt: serverTimestamp(),
        capturedBy: appUser.email,
      });

      const hid = householdRef.id;
      const baseConsent = { consentedToPrivacyPolicy: consent.privacy, consentedToSpecialInfo: consent.special, consentTimestamp: serverTimestamp(), consentPolicyVersion: "v1.0" };

      // 2. Create primary member
      const primaryRef = await addDoc(collection(db, "members"), {
        tenantId: appUser.tenantId,
        fullName: `${primary.firstName.trim()} ${primary.lastName.trim()}`,
        firstName: primary.firstName.trim(), lastName: primary.lastName.trim(),
        email: primary.email.trim().toLowerCase(), phone: fmtPhone(primary.phone, primary.countryCode || "27"),
        dob: primary.dob, gender: primary.gender, maritalStatus: primary.maritalStatus,
        address: primary.address, role: primary.role, branch: primary.branch.trim(), cellRegion: primary.cellRegion.trim(), ministryGroup: primary.ministryGroup.trim(),
        churchRole: primary.churchRole?.trim() || "",
        membershipType: primary.membershipType, ministries: primary.ministries,
        faithStatus: { bornAgain: primary.bornAgain, waterBaptized: primary.waterBaptized },
        householdId: hid, householdRole: "primary",
        isMember: true, status: "active", source: "manual",
        customFields: customFieldValues,
        ...baseConsent, createdAt: serverTimestamp(), capturedBy: appUser.email,
      });

      // Update household with primary member ID
      await updateDoc(doc(db, "households", hid), { primaryMemberId: primaryRef.id });

      // Trigger member_added workflows for the new primary member
      triggerMemberWorkflows(
        primaryRef.id,
        `${primary.firstName.trim()} ${primary.lastName.trim()}`,
        fmtPhone(primary.phone, primary.countryCode || "27"),
      );

      // 3. Spouse as member — second member document
      let spouseDocRef: any = null;
      if (isMarried && isSpouseMember === "yes") {
        spouseDocRef = await addDoc(collection(db, "members"), {
          tenantId: appUser.tenantId,
          fullName: `${spouse.firstName.trim()} ${spouse.lastName.trim()}`,
          firstName: spouse.firstName.trim(), lastName: spouse.lastName.trim(),
          email: spouse.email.trim().toLowerCase(), phone: fmtPhone(spouse.phone, spouse.countryCode || "27"),
          dob: spouse.dob, gender: spouse.gender, maritalStatus: "Married",
          address: spouse.address, role: spouse.role, branch: spouse.branch.trim(), cellRegion: spouse.cellRegion.trim(), ministryGroup: spouse.ministryGroup.trim(),
          churchRole: spouse.churchRole?.trim() || "",
          membershipType: spouse.membershipType, ministries: spouse.ministries,
          faithStatus: { bornAgain: spouse.bornAgain, waterBaptized: spouse.waterBaptized },
          householdId: hid, householdRole: "spouse", spouseId: primaryRef.id,
          isMember: true, status: "active", source: "manual",
          consentedToPrivacyPolicy: true, consentedToSpecialInfo: consent.special,
          consentTimestamp: serverTimestamp(), consentPolicyVersion: "v1.0",
          createdAt: serverTimestamp(), capturedBy: appUser.email,
        });
        await updateDoc(doc(db, "members", primaryRef.id), { spouseId: spouseDocRef.id });
        await updateDoc(doc(db, "households", hid), { spouseMemberId: spouseDocRef.id });
      }

      // 4. Children who are members — separate member documents, inheriting parent's address
      for (const child of children.filter(c => c.isMember)) {
        await addDoc(collection(db, "members"), {
          tenantId: appUser.tenantId,
          fullName: `${child.firstName.trim()} ${child.lastName.trim()}`,
          firstName: child.firstName.trim(), lastName: child.lastName.trim(),
          email: "", phone: "", dob: child.dob, gender: child.gender,
          maritalStatus: "Single", role: "Member",
          address: primary.address,
          branch: primary.branch.trim(),
          cellRegion: primary.cellRegion.trim(),
          householdId: hid, householdRole: "child", parentId: primaryRef.id,
          isMember: true, status: "active", source: "manual",
          consentedToPrivacyPolicy: true, consentedToSpecialInfo: false,
          consentTimestamp: serverTimestamp(), consentPolicyVersion: "v1.0",
          createdAt: serverTimestamp(), capturedBy: appUser.email,
        });
      }

      await refreshList();
      const count = 1 + (isSpouseMember === "yes" ? 1 : 0) + children.filter(c => c.isMember).length;
      bumpLocalCount(count);
      setFeedback({ ok: true, text: `${count} member record${count !== 1 ? "s" : ""} saved successfully.` });
      reset(); setView("list");
    } catch (err: any) {
      console.error("Save error:", err);
      if (isLimitError(err)) {
        setShowUpgradeModal(true);
      } else {
        setFeedback({ ok: false, text: "Save failed. Please try again." });
      }
    } finally { setSubmitting(false); }
  };

  // ─── Submit: joining an existing family (single new member, no new household) ──

  const handleJoinFamily = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appUser) return;
    if (!consent.privacy) { setFeedback({ ok: false, text: "Privacy policy consent is required." }); return; }
    if (!familyTargetId) { setFeedback({ ok: false, text: "Please select which family they are joining." }); return; }
    if (wouldExceedLimit(1)) { setShowUpgradeModal(true); return; }

    setSubmitting(true); setFeedback(null);
    try {
      const target = members.find(m => m.id === familyTargetId);
      if (!target) { setFeedback({ ok: false, text: "That family member could not be found. Please pick again." }); return; }
      const hid = await resolveHouseholdFor(target);

      const memberRef = await addDoc(collection(db, "members"), {
        tenantId: appUser.tenantId,
        fullName: `${primary.firstName.trim()} ${primary.lastName.trim()}`,
        firstName: primary.firstName.trim(), lastName: primary.lastName.trim(),
        email: primary.email.trim().toLowerCase(), phone: primary.phone ? fmtPhone(primary.phone, primary.countryCode || "27") : "",
        dob: primary.dob, gender: primary.gender, maritalStatus: primary.maritalStatus,
        address: primary.address, role: primary.role, branch: primary.branch.trim(), cellRegion: primary.cellRegion.trim(), ministryGroup: primary.ministryGroup.trim(),
        churchRole: primary.churchRole?.trim() || "",
        membershipType: primary.membershipType, ministries: primary.ministries,
        faithStatus: { bornAgain: primary.bornAgain, waterBaptized: primary.waterBaptized },
        householdId: hid, householdRole: familyRole,
        ...(familyRole === "child" ? { parentId: familyTargetId } : {}),
        isMember: true, status: "active", source: "manual",
        customFields: customFieldValues,
        consentedToPrivacyPolicy: consent.privacy, consentedToSpecialInfo: consent.special,
        consentTimestamp: serverTimestamp(), consentPolicyVersion: "v1.0",
        createdAt: serverTimestamp(), capturedBy: appUser.email,
      });

      if (familyRole === "spouse") {
        await updateDoc(doc(db, "households", hid), { spouseMemberId: memberRef.id });
      }

      triggerMemberWorkflows(
        memberRef.id,
        `${primary.firstName.trim()} ${primary.lastName.trim()}`,
        primary.phone ? fmtPhone(primary.phone, primary.countryCode || "27") : "",
      );

      bumpLocalCount(1);
      await refreshList();
      setFeedback({ ok: true, text: "Member added and linked to the family." });
      reset(); setView("list");
    } catch (err: any) {
      console.error("Join family save error:", err);
      if (isLimitError(err)) {
        setShowUpgradeModal(true);
      } else {
        setFeedback({ ok: false, text: "Save failed. Please try again." });
      }
    } finally { setSubmitting(false); }
  };

  // ─── Configure lists ────────────────────────────────────────────────────────

  const openConfigure = () => {
    setEditMinistries([...config.ministries]);
    setEditMembershipTypes([...config.membershipTypes]);
    setEditBranches([...config.branches]);
    setEditCellGroupBranch({ ...(config.cellGroupBranch || {}) });
    setEditCellRegions([...config.cellRegions]);
    setEditMinistryGroups([...config.ministryGroups]);
    setEditChurchRoles([...config.churchRoles]);
    setNewMinistry("");
    setNewMembershipType("");
    setNewBranch("");
    setNewCellRegion("");
    setNewCellRegionBranch("");
    setNewMinistryGroup("");
    setNewChurchRole("");
    setView("configure");
  };

  const saveConfig = async () => {
    if (!appUser) return;
    setConfigSaving(true);
    try {
      // Only keep branch mappings for cell groups that still exist.
      const cleanedCellGroupBranch: Record<string, string> = {};
      editCellRegions.forEach(cg => {
        if (editCellGroupBranch[cg]) cleanedCellGroupBranch[cg] = editCellGroupBranch[cg];
      });
      await updateDoc(doc(db, "tenants", appUser.tenantId), {
        ministries: editMinistries,
        membershipTypes: editMembershipTypes,
        branches: editBranches,
        cellGroupBranch: cleanedCellGroupBranch,
        cellRegions: editCellRegions,
        ministryGroups: editMinistryGroups,
        churchRoles: editChurchRoles,
      });
      setConfig(prev => ({
        ...prev,
        ministries: editMinistries,
        membershipTypes: editMembershipTypes,
        branches: editBranches,
        cellGroupBranch: cleanedCellGroupBranch,
        cellRegions: editCellRegions,
        ministryGroups: editMinistryGroups,
        churchRoles: editChurchRoles,
      }));
      setView("list");
    } catch (e) {
      console.error("Config save error:", e);
      alert("Could not save. Please try again.");
    } finally {
      setConfigSaving(false);
    }
  };

  // ─── Edit member ─────────────────────────────────────────────────────────────

  const openEdit = (m: Member) => {
    setEditingMemberId(m.id);
    // Imported members may only have fullName — fall back to splitting it
    const parts = (m.fullName || "").trim().split(/\s+/);
    const fallbackFirst = parts[0] || "";
    const fallbackLast = parts.slice(1).join(" ") || "";
    setPrimary({
      firstName: m.firstName || fallbackFirst,
      lastName: m.lastName || fallbackLast,
      dob: m.dob || "",
      gender: m.gender || "",
      email: m.email || "",
      phone: m.phone || "",
      countryCode: (m as any).countryCode || "27",
      maritalStatus: m.maritalStatus || "",
      branch: m.branch || "",
      cellRegion: m.cellRegion || "",
      ministryGroup: m.ministryGroup || "",
      churchRole: m.churchRole || "",
      address: (m as any).address || { line1: "", line2: "", suburb: "", town: "", postalCode: "" },
      bornAgain: m.faithStatus?.bornAgain || (m as any).bornAgain || "",
      waterBaptized: m.faithStatus?.waterBaptized || (m as any).waterBaptized || "",
      membershipType: m.membershipType || "",
      ministries: m.ministries || [],
      role: m.role || "Member",
    });
    setCustomFieldValues((m as any).customFields || {});
    setEditingMemberException((m as any).absenceException || null);
    setMemberWorkflows([]);
    setFeedback(null);
    setView("form");
    // Load workflow instances for this member. The tenantId filter is required:
    // the rules only allow tenant-scoped queries, so without it Firestore
    // rejects the whole query and the member's workflows never show.
    if (appUser?.tenantId) {
      getDocs(query(
        collection(db, "workflow_instances"),
        where("tenantId", "==", appUser.tenantId),
        where("subjectId", "==", m.id),
      )).then((snap) => {
        setMemberWorkflows(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      }).catch((err) => console.warn("Could not load member workflows:", err));
    }
  };

  const saveException = async () => {
    if (!editingMemberId) return;
    const finalTag = exceptionTag === "Other" ? customTag.trim() : exceptionTag;
    if (!finalTag) return;
    setSavingException(true);
    try {
      const exceptionData: AbsenceException = {
        tag: finalTag,
        setAt: new Date().toISOString().split("T")[0],
        ...(exceptionNote.trim() ? { note: exceptionNote.trim() } : {}),
      };
      await updateDoc(doc(db, "members", editingMemberId), { absenceException: exceptionData });
      setEditingMemberException(exceptionData);
      setMembers(prev => prev.map(m => m.id === editingMemberId ? { ...m, absenceException: exceptionData } : m));
      setShowExceptionModal(false);
      setExceptionNote("");
      setCustomTag("");
    } catch (e) {
      console.error("Failed to save exception:", e);
      alert("Could not save exception. Please try again.");
    } finally {
      setSavingException(false);
    }
  };

  const clearException = async () => {
    if (!editingMemberId) return;
    setClearingException(true);
    try {
      await updateDoc(doc(db, "members", editingMemberId), { absenceException: null });
      setEditingMemberException(null);
      setMembers(prev => prev.map(m => m.id === editingMemberId ? { ...m, absenceException: null } : m));
    } catch (e) {
      console.error("Failed to remove exception:", e);
      alert("Could not remove exception. Please try again.");
    } finally {
      setClearingException(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appUser || !editingMemberId) return;
    setSubmitting(true); setFeedback(null);
    try {
      await updateDoc(doc(db, "members", editingMemberId), {
        fullName: `${primary.firstName.trim()} ${primary.lastName.trim()}`,
        firstName: primary.firstName.trim(),
        lastName: primary.lastName.trim(),
        email: primary.email.trim().toLowerCase(),
        phone: fmtPhone(primary.phone, primary.countryCode || "27"),
        dob: primary.dob,
        gender: primary.gender,
        maritalStatus: primary.maritalStatus,
        address: primary.address,
        role: primary.role,
        branch: primary.branch.trim(),
        cellRegion: primary.cellRegion.trim(),
        ministryGroup: primary.ministryGroup.trim(),
        churchRole: primary.churchRole?.trim() || "",
        membershipType: primary.membershipType,
        ministries: primary.ministries,
        faithStatus: { bornAgain: primary.bornAgain, waterBaptized: primary.waterBaptized },
        customFields: customFieldValues,
        updatedAt: serverTimestamp(),
        updatedBy: appUser.email,
      });
      await refreshList();
      setFeedback({ ok: true, text: "Member record updated successfully." });
      setEditingMemberId(null);
      reset();
      setView("list");
    } catch (err) {
      console.error("Update error:", err);
      setFeedback({ ok: false, text: "Update failed. Please try again." });
    } finally {
      setSubmitting(false); }
  };

  // ─── Delete member ──────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this member from the register?")) return;
    try {
      await deleteDoc(doc(db, "members", id));
      setMembers(p => p.filter(m => m.id !== id));
    } catch { alert("Could not remove. Try again."); }
  };

  // ─── Suspend / reinstate membership ─────────────────────────────────────────
  // A suspended member keeps every field on their record (so nothing is lost)
  // but is filtered off the Active Register and out of attendance capture, and
  // no longer counts toward the free-tier member limit — the same "status"
  // field the member-count Cloud Function already keys off of.

  const openSuspend = (m: Member) => {
    setSuspendModalMember(m);
    setSuspendReason("");
  };

  const confirmSuspend = async () => {
    if (!suspendModalMember || !appUser) return;
    setSuspending(true);
    try {
      await updateDoc(doc(db, "members", suspendModalMember.id), {
        status: "suspended",
        suspendedAt: serverTimestamp(),
        suspendedReason: suspendReason.trim() || null,
        suspendedBy: appUser.email,
      });
      setMembers(p => p.map(m => m.id === suspendModalMember.id
        ? { ...m, status: "suspended", suspendedReason: suspendReason.trim() || null }
        : m));
      setSuspendModalMember(null);
      setSuspendReason("");
    } catch (e) {
      console.error("Suspend error:", e);
      alert("Could not suspend this member. Please try again.");
    } finally {
      setSuspending(false);
    }
  };

  const reinstateMember = async (id: string) => {
    if (!confirm("Reinstate this member? They will reappear on the active register and attendance.")) return;
    try {
      await updateDoc(doc(db, "members", id), { status: "active", reinstatedAt: serverTimestamp() });
      setMembers(p => p.map(m => m.id === id ? { ...m, status: "active" } : m));
    } catch (e) {
      console.error("Reinstate error:", e);
      alert("Could not reinstate this member. Please try again.");
    }
  };

  // ─── Family linking ──────────────────────────────────────────────────────────
  // Resolves (or creates, for a legacy member who predates the household model)
  // the household a given existing member belongs to. Shared by "join an
  // existing family" on the add-member form and "Link to Family" on a row.
  const resolveHouseholdFor = async (target: Member): Promise<string> => {
    if (target.householdId) return target.householdId;
    if (!appUser) return "";
    const familyName = target.lastName || (target.fullName || "").trim().split(/\s+/).slice(-1)[0] || "";
    const newHh = await addDoc(collection(db, "households"), {
      tenantId: appUser.tenantId,
      familyName,
      primaryMemberId: target.id,
      createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "members", target.id), { householdId: newHh.id, householdRole: target.householdRole || "primary" });
    setMembers(p => p.map(m => m.id === target.id ? { ...m, householdId: newHh.id, householdRole: m.householdRole || "primary" } : m));
    setHouseholds(p => [...p, { id: newHh.id, familyName, primaryMemberId: target.id }]);
    return newHh.id;
  };

  const confirmLinkFamily = async () => {
    if (!linkFamilyMember || !linkFamilyTargetId || !appUser) return;
    setLinkingFamily(true);
    try {
      const target = members.find(m => m.id === linkFamilyTargetId);
      if (!target) return;
      const hid = await resolveHouseholdFor(target);
      await updateDoc(doc(db, "members", linkFamilyMember.id), {
        householdId: hid,
        householdRole: linkFamilyRole,
        ...(linkFamilyRole === "child" ? { parentId: linkFamilyTargetId } : {}),
      });
      if (linkFamilyRole === "spouse") {
        await updateDoc(doc(db, "households", hid), { spouseMemberId: linkFamilyMember.id });
      }
      setMembers(p => p.map(m => m.id === linkFamilyMember.id
        ? { ...m, householdId: hid, householdRole: linkFamilyRole, ...(linkFamilyRole === "child" ? { parentId: linkFamilyTargetId } : {}) }
        : m));
      setLinkFamilyMember(null);
      setLinkFamilySearch("");
      setLinkFamilyTargetId("");
    } catch (e) {
      console.error("Link to family error:", e);
      alert("Could not link this member to the family. Please try again.");
    } finally {
      setLinkingFamily(false);
    }
  };

  // ─── Import (CSV/XLSX) parse ─────────────────────────────────────────────────

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImportParsing(true); setImportRows([]);
    try {
      const isCSV = file.name.endsWith(".csv");
      const buf = await file.arrayBuffer();

      if (isCSV) {
        const text = new TextDecoder().decode(buf);
        const lines = text.trim().split("\n");
        if (lines.length === 0) { alert("CSV file is empty."); return; }

        const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
        const rows = lines.slice(1).map(line => {
          const values = line.match(/("([^"]|"")*"|[^,]*)/g)?.map(v => v.replace(/^"|"$/g, "").replace(/""/g, '"')) || [];
          const row: Record<string, string> = {};
          headers.forEach((h, i) => { row[h] = values[i]?.trim() || ""; });
          return row;
        });
        setImportRows(rows);
      } else {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(buf, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        setImportRows(XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[]);
      }
    } catch { alert("Could not read file. Make sure it is a valid CSV or XLSX file."); }
    finally { setImportParsing(false); }
  };

  // ─── Duplicate check ─────────────────────────────────────────────────────────

  const runDuplicateCheck = (): DuplicateFlag[] => {
    const norm = (v: any) => String(v ?? "").trim().toLowerCase();
    const dups: DuplicateFlag[] = [];
    importRows.forEach((row, rowIndex) => {
      const firstName = norm(row["First Name"] || row.firstName || row.name);
      const lastName = norm(row["Last Name"] || row.lastName || row.surname);
      const dob = normalizeDob(row["Date of Birth"] || row.dob || row["Date of birth"]);
      if (!firstName && !lastName) return;
      // Only flag when DOB is also present — avoids false positives on name-only matches
      if (!dob) return;
      const match = members.find(m =>
        (m.firstName || "").trim().toLowerCase() === firstName &&
        (m.lastName || "").trim().toLowerCase() === lastName &&
        (m.dob || "") === dob
      );
      if (match) {
        dups.push({
          rowIndex,
          importName: `${row["First Name"] || row.firstName || ""} ${row["Last Name"] || row.lastName || ""}`.trim(),
          importDob: dob,
          existingName: match.fullName,
        });
      }
    });
    return dups;
  };

  const handleImportClick = () => {
    setDuplicateWarning(null);
    const dups = runDuplicateCheck();
    if (dups.length > 0) {
      setDuplicateWarning({ dups, total: importRows.length });
    } else {
      handleImport(new Set());
    }
  };

  const handleImport = async (skipIndices: Set<number>) => {
    if (!appUser || !importRows.length) return;
    // A free church that is already full cannot import more members. Rows that
    // would tip an almost-full church over the cap are stopped per-record by the
    // security rule, and caught below.
    if (atMemberLimit) { setShowUpgradeModal(true); return; }
    setDuplicateWarning(null);
    setImporting(true); let count = 0;

    const s = (v: any) => String(v ?? "").trim();
    const yn = (v: any) => s(v).toLowerCase() === "yes" ? "Yes" : s(v).toLowerCase() === "no" ? "No" : "";
    const baseConsent = {
      consentedToPrivacyPolicy: true, consentedToSpecialInfo: false,
      consentTimestamp: serverTimestamp(), consentPolicyVersion: "v1.0",
    };

    try {
      for (let rowIndex = 0; rowIndex < importRows.length; rowIndex++) {
        if (skipIndices.has(rowIndex)) continue;
        const row = importRows[rowIndex];
        const firstName = s(row["First Name"] || row.firstName || row.name);
        const lastName = s(row["Last Name"] || row.lastName || row.surname);
        const fullName = s(row["Full Name"] || row.fullName || `${firstName} ${lastName}`);
        if (!fullName) continue;

        const isMarried = s(row["Marital Status"] || row.maritalStatus).toLowerCase() === "married";
        const spouseIsMember = yn(row["Is Spouse a Member"] || row["Is Spouse a member"]) === "Yes";

        // ── Build children arrays ──────────────────────────────────────────────
        const allChildren = [1, 2, 3, 4, 5].map(n => ({
          firstName: s(row[`Child ${n} First Name`]),
          lastName: s(row[`Child ${n} Last Name`]),
          dob: normalizeDob(row[`Child ${n} DOB`]),
          gender: s(row[`Child ${n} Gender`]),
          isMember: yn(row[`Is Child ${n} a Member`] || row[`Is child ${n} a member`]) === "Yes",
        })).filter(c => c.firstName || c.lastName);

        const memberChildren = allChildren.filter(c => c.isMember);
        const nonMemberChildren = allChildren.filter(c => !c.isMember);

        // ── Parents ───────────────────────────────────────────────────────────
        const motherName = s(row["Mother Name"] || row.motherName);
        const motherSur = s(row["Mother Surname"] || row.motherSurname);
        const fatherName = s(row["Father Name"] || row.fatherName);
        const fatherSur = s(row["Father Surname"] || row.fatherSurname);
        const milName = s(row["Mother-in-Law Name"] || row.motherInLawName);
        const milSur = s(row["Mother-in-Law Surname"] || row.motherInLawSurname);
        const filName = s(row["Father-in-Law Name"] || row.fatherInLawName);
        const filSur = s(row["Father-in-Law Surname"] || row.fatherInLawSurname);

        // ── Non-member spouse basic ────────────────────────────────────────────
        const nonMemberSpouse = isMarried && !spouseIsMember && s(row["Spouse First Name"] || row["Spouse Name"]) ? {
          firstName: s(row["Spouse First Name"] || row["Spouse Name"]),
          lastName: s(row["Spouse Last Name"] || row["Spouse Surname"]),
          dob: normalizeDob(row["Spouse DOB"]),
          gender: s(row["Spouse Gender"]),
          phone: s(row["Spouse Phone"] || row["Contact Number.1"]),
        } : null;

        // ── 1. Household ──────────────────────────────────────────────────────
        const householdRef = await addDoc(collection(db, "households"), {
          tenantId: appUser.tenantId,
          familyName: lastName,
          parents: {
            mother: { name: motherName, surname: motherSur, dob: "" },
            father: { name: fatherName, surname: fatherSur, dob: "" },
          },
          inLaws: isMarried ? {
            motherInLaw: { name: milName, surname: milSur, dob: "" },
            fatherInLaw: { name: filName, surname: filSur, dob: "" },
          } : null,
          nonMemberSpouse,
          nonMemberChildren,
          createdAt: serverTimestamp(),
          capturedBy: appUser.email,
        });
        const hid = householdRef.id;

        // ── 2. Primary member ─────────────────────────────────────────────────
        const primaryRef = await addDoc(collection(db, "members"), {
          tenantId: appUser.tenantId,
          fullName, firstName, lastName,
          email: s(row["Email"] || row.email).toLowerCase(),
          phone: s(row["Phone"] || row.phone || row["Contact Number"]) ? fmtPhone(s(row["Phone"] || row.phone || row["Contact Number"]), importCountryCode) : "",
          dob: normalizeDob(row["Date of Birth"] || row.dob || row["Date of birth"]),
          gender: s(row["Gender"] || row.gender),
          maritalStatus: s(row["Marital Status"] || row.maritalStatus),
          membershipType: s(row["Membership Type"] || row.membershipType),
          branch: s(row["Branch"] || row.branch),
          cellRegion: s(row["Cell Group"] || row["Cell Region / Branch"] || row["Cell Region"] || row.cellRegion),
          ministryGroup: s(row["Ministry Group"] || row.ministryGroup) || assignMinistryGroup(normalizeDob(row["Date of Birth"] || row.dob || row["Date of birth"]), s(row["Gender"] || row.gender), s(row["Marital Status"] || row.maritalStatus)),
          churchRole: s(row["Church Role"] || row.churchRole),
          address: {
            line1: s(row["Address Line 1"] || row["Line 1"] || row.address || ""),
            line2: s(row["Address Line 2"] || row["Line 2"] || ""),
            suburb: s(row["Suburb"] || row.suburb || ""),
            town: s(row["Town"] || row.town || ""),
            postalCode: s(row["Postal Code"] || row["Postal code"] || row.postalCode || ""),
          },
          faithStatus: {
            bornAgain: yn(row["Born Again"] || row.bornAgain),
            waterBaptized: yn(row["Water Baptized"] || row.waterBaptized),
          },
          ministries: s(row["Ministries to serve in"] || row["Ministries"] || row.ministries).split(/[,;]/).map((x: string) => x.trim()).filter(Boolean),
          role: s(row["Role"] || row.role) || "Member",
          householdId: hid, householdRole: "primary",
          isMember: true, status: "active", source: "xlsx_import",
          ...baseConsent, createdAt: serverTimestamp(), capturedBy: appUser.email,
        });

        await updateDoc(doc(db, "households", hid), { primaryMemberId: primaryRef.id });
        count++;

        // ── 3. Spouse as member ───────────────────────────────────────────────
        if (isMarried && spouseIsMember) {
          const spFirst = s(row["Spouse First Name"] || row["Spouse Name"]);
          const spLast = s(row["Spouse Last Name"] || row["Spouse Surname"]);
          if (spFirst || spLast) {
            const spouseRef = await addDoc(collection(db, "members"), {
              tenantId: appUser.tenantId,
              fullName: `${spFirst} ${spLast}`.trim(),
              firstName: spFirst, lastName: spLast,
              email: s(row["Spouse Email"] || row["Email.1"]).toLowerCase(),
              phone: s(row["Spouse Phone"] || row["Contact Number.1"]) ? fmtPhone(s(row["Spouse Phone"] || row["Contact Number.1"]), importCountryCode) : "",
              dob: normalizeDob(row["Spouse DOB"]),
              gender: s(row["Spouse Gender"]),
              maritalStatus: "Married",
              ministryGroup: assignMinistryGroup(normalizeDob(row["Spouse DOB"]), s(row["Spouse Gender"]), "Married"),
              membershipType: s(row["Spouse Membership Type"]),
              address: {
                line1: s(row["Address Line 1"] || row["Line 1.1"] || row["Line 1"] || ""),
                line2: s(row["Address Line 2"] || row["Line 2.1"] || row["Line 2"] || ""),
                suburb: s(row["Suburb.1"] || row["Suburb"] || ""),
                town: s(row["Town.1"] || row["Town"] || ""),
                postalCode: s(row["Postal Code"] || row["Postal code"] || ""),
              },
              faithStatus: { bornAgain: "", waterBaptized: "" },
              ministries: [],
              role: "Member",
              householdId: hid, householdRole: "spouse", spouseId: primaryRef.id,
              isMember: true, status: "active", source: "xlsx_import",
              ...baseConsent, createdAt: serverTimestamp(), capturedBy: appUser.email,
            });
            await updateDoc(doc(db, "members", primaryRef.id), { spouseId: spouseRef.id });
            await updateDoc(doc(db, "households", hid), { spouseMemberId: spouseRef.id });
            count++;
          }
        }

        // ── 4. Member children ────────────────────────────────────────────────
        for (const child of memberChildren) {
          await addDoc(collection(db, "members"), {
            tenantId: appUser.tenantId,
            fullName: `${child.firstName} ${child.lastName}`.trim(),
            firstName: child.firstName, lastName: child.lastName,
            email: "", phone: "",
            dob: child.dob, gender: child.gender,
            maritalStatus: "Single",
            ministryGroup: assignMinistryGroup(child.dob, child.gender, "Single"),
            role: "Member",
            address: {
              line1: s(row["Address Line 1"] || row["Line 1"] || ""),
              line2: s(row["Address Line 2"] || row["Line 2"] || ""),
              suburb: s(row["Suburb"] || ""),
              town: s(row["Town"] || ""),
              postalCode: s(row["Postal Code"] || row["Postal code"] || ""),
            },
            faithStatus: { bornAgain: "", waterBaptized: "" },
            ministries: [],
            householdId: hid, householdRole: "child", parentId: primaryRef.id,
            isMember: true, status: "active", source: "xlsx_import",
            ...baseConsent, createdAt: serverTimestamp(), capturedBy: appUser.email,
          });
          count++;
        }
      }
      await refreshList();
      bumpLocalCount(count);
      alert(`${count} member record${count !== 1 ? "s" : ""} imported successfully.`);
      setImportRows([]); if (fileRef.current) fileRef.current.value = "";
      setView("list");
    } catch (err: any) {
      console.error("Import error:", err);
      if (isLimitError(err)) {
        // Some rows may have saved before the cap was hit; refresh so the list is accurate.
        await refreshList();
        setShowUpgradeModal(true);
      } else {
        alert("Import failed. Check console.");
      }
    }
    finally { setImporting(false); }
  };

  // ─── Loading ────────────────────────────────────────────────────────────────

  // ── Derived: household lookup, active vs. suspended ───────────────────────
  const householdMap = new Map<string, Household>(households.map(h => [h.id, h]));
  const activeMembersOnly = members.filter(m => m.status !== "suspended");
  const suspendedMembers = members.filter(m => m.status === "suspended");

  // ── Derived: filtered members ─────────────────────────────────────────────
  const filteredMembers = activeMembersOnly.filter((m) => {
    if (memberSearch.trim()) {
      const q = memberSearch.trim().toLowerCase();
      const haystack = [
        m.fullName, m.firstName, m.lastName, m.email, m.phone,
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filterMinistryGroup && m.ministryGroup !== filterMinistryGroup) return false;
    if (filterMaritalStatus && m.maritalStatus !== filterMaritalStatus) return false;
    if (filterBranch && m.branch !== filterBranch) return false;
    if (filterCellRegion && m.cellRegion !== filterCellRegion) return false;
    if (filterBornAgain && m.faithStatus?.bornAgain !== filterBornAgain) return false;
    if (filterWaterBaptized && m.faithStatus?.waterBaptized !== filterWaterBaptized) return false;
    if (filterMembershipType && m.membershipType !== filterMembershipType) return false;
    return true;
  });
  const activeFilters = [filterMinistryGroup, filterMaritalStatus, filterBranch, filterCellRegion, filterBornAgain, filterWaterBaptized, filterMembershipType].filter(Boolean).length;

  if (userLoading || loading) {
    return (
      <div className="p-10 flex items-center gap-2">
        <div className="spinner !border-blue-600 !border-t-transparent" />
        <p className="text-gray-600">Loading membership records...</p>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FORM VIEW
  // ═══════════════════════════════════════════════════════════════════════════

  if (view === "form") {
    const isMarried = primary.maritalStatus === "Married";
    let sectionNum = 0;
    const next = () => String(++sectionNum);

    const isEditing = !!editingMemberId;

    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <UpgradeLimitModal open={showUpgradeModal} limit={memberLimit} onClose={() => setShowUpgradeModal(false)} />
        <button onClick={() => { setView("list"); reset(); setEditingMemberId(null); }}
          className="text-sm text-blue-600 hover:text-blue-800 font-medium mb-4 flex items-center gap-1">
          ← Back to register
        </button>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">
          {isEditing ? "Edit Member Record" : "New Member Registration"}
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          {isEditing
            ? "Update this member's details. Changes are saved immediately to their record."
            : "A household record is created automatically. No signature required for manual capture."}
        </p>

        {!isEditing && (
          <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 mb-6 flex flex-col gap-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={joinExistingFamily}
                onChange={e => { setJoinExistingFamily(e.target.checked); setFamilySearch(""); setFamilyTargetId(""); }}
                className="mt-1 h-4 w-4 rounded text-teal-600 border-gray-300"
              />
              <span className="text-sm text-teal-900">
                <strong>This person is joining a family already in the register</strong> — e.g. a child whose parent joined earlier. Skips the spouse/children sections below and links straight into that family instead of starting a new household.
              </span>
            </label>
            {joinExistingFamily && (
              <div className="flex flex-col gap-2 pl-7">
                <F label="Search for the family member they're joining" req>
                  <input
                    value={familySearch}
                    onChange={e => { setFamilySearch(e.target.value); setFamilyTargetId(""); }}
                    placeholder="Type a name..."
                    className={inp}
                  />
                </F>
                {familySearch.trim() && !familyTargetId && (
                  <div className="border rounded-lg bg-white max-h-48 overflow-y-auto divide-y divide-gray-50">
                    {members.filter(m => m.status !== "suspended" && (m.fullName || `${m.firstName || ""} ${m.lastName || ""}`).toLowerCase().includes(familySearch.trim().toLowerCase())).slice(0, 20).map(m => (
                      <button
                        type="button"
                        key={m.id}
                        onClick={() => { setFamilyTargetId(m.id); setFamilySearch(m.fullName || `${m.firstName || ""} ${m.lastName || ""}`.trim()); }}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-teal-50 transition-colors"
                      >
                        {m.fullName || `${m.firstName || ""} ${m.lastName || ""}`.trim()}
                        {m.phone && <span className="text-xs text-gray-400 ml-2">+{m.phone}</span>}
                      </button>
                    ))}
                    {members.filter(m => m.status !== "suspended" && (m.fullName || `${m.firstName || ""} ${m.lastName || ""}`).toLowerCase().includes(familySearch.trim().toLowerCase())).length === 0 && (
                      <p className="px-3 py-2 text-xs text-gray-400 italic">No matching member found.</p>
                    )}
                  </div>
                )}
                {familyTargetId && (
                  <F label="Their relationship to this new member" req>
                    <select value={familyRole} onChange={e => setFamilyRole(e.target.value as any)} className={sel} required>
                      <option value="child">This new member is their Child</option>
                      <option value="spouse">This new member is their Spouse</option>
                      <option value="parent">This new member is their Parent</option>
                      <option value="other">Other relative</option>
                    </select>
                  </F>
                )}
              </div>
            )}
          </div>
        )}

        <form onSubmit={isEditing ? handleUpdate : (joinExistingFamily ? handleJoinFamily : handleSubmit)} className="flex flex-col gap-6">

          {/* ── SECTION 1: Member Details ── */}
          <div className="bg-white border rounded-xl p-6 shadow-sm flex flex-col gap-5">
            <SecHead n={next()} title="Member Details" sub="Primary member's personal information" />
            <MemberBlock data={primary} set={setP} config={config} formConfig={formConfig} showFaith={false} ageRestricted={isUnder16(primary.dob)} customValues={customFieldValues} setCustomValues={setCustomFieldValues} lockedBranch={appUser?.role === "branch_admin" ? (appUser.assignedBranch || "") : ""} />
            <F label="Marital Status" req>
              <select value={primary.maritalStatus} onChange={e => setP("maritalStatus", e.target.value)} className={sel} required>
                <option value="">Select</option>
                <option>Single</option>
                <option>Married</option>
                <option>Divorced</option>
                <option>Widowed</option>
              </select>
            </F>
          </div>

          {/* ── SECTION 2: Faith & Membership (primary) ── */}
          {(() => { const u16 = isUnder16(primary.dob); return (
          <div className="bg-white border rounded-xl p-6 shadow-sm flex flex-col gap-5">
            <SecHead n={next()} title="Faith & Membership" />
            {u16 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
                Faith and membership fields are optional for members under 16 as they cannot yet make these decisions independently.
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <F label="Born Again?" req={!u16}>
                <select value={primary.bornAgain} onChange={e => setP("bornAgain", e.target.value)} className={sel} required={!u16}>
                  <option value="">Select</option><option>Yes</option><option>No</option>
                </select>
              </F>
              <F label="Water Baptized?" req={!u16}>
                <select value={primary.waterBaptized} onChange={e => setP("waterBaptized", e.target.value)} className={sel} required={!u16}>
                  <option value="">Select</option><option>Yes</option><option>No</option>
                </select>
              </F>
            </div>
            <F label="Type of Membership Sought" req={!u16}>
              <select value={primary.membershipType} onChange={e => setP("membershipType", e.target.value)} className={sel} required={!u16}>
                <option value="">Select</option>
                {config.membershipTypes.map(t => <option key={t}>{t}</option>)}
              </select>
            </F>
            <F label="Ministries to Serve In">
              <MinChecks list={config.ministries} sel={primary.ministries} on={v => setP("ministries", v)} />
            </F>
          </div>
          ); })()}

          {/* ── SECTION 3: Spouse (conditional on married, new registrations only) ── */}
          {!isEditing && !joinExistingFamily && isMarried && (
            <div className="bg-white border rounded-xl p-6 shadow-sm flex flex-col gap-5">
              <SecHead n={next()} title="Spouse Details" />
              <F label="Is your spouse a member of this church?" req>
                <select value={isSpouseMember} onChange={e => setIsSpouseMember(e.target.value as any)} className={sel} required>
                  <option value="">Select</option>
                  <option value="yes">Yes — register them as a member</option>
                  <option value="no">No — record basic details only</option>
                </select>
              </F>

              {isSpouseMember === "no" && (
                <div className="border-t pt-4 flex flex-col gap-4">
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
                    These details are saved to the household record only — not added to the member register.
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <F label="First Name"><input value={spouseBasic.firstName} onChange={e => setSpouseBasic(p => ({ ...p, firstName: e.target.value }))} className={inp} /></F>
                    <F label="Last Name"><input value={spouseBasic.lastName} onChange={e => setSpouseBasic(p => ({ ...p, lastName: e.target.value }))} className={inp} /></F>
                    <F label="Date of Birth"><DateInput value={spouseBasic.dob} onChange={val => setSpouseBasic(p => ({ ...p, dob: val }))} className={inp} /></F>
                    <F label="Gender">
                      <select value={spouseBasic.gender} onChange={e => setSpouseBasic(p => ({ ...p, gender: e.target.value }))} className={sel}>
                        <option value="">Select</option><option>Male</option><option>Female</option>
                      </select>
                    </F>
                  </div>
                  <F label="Contact Number"><input type="tel" value={spouseBasic.phone} onChange={e => setSpouseBasic(p => ({ ...p, phone: e.target.value }))} className={inp} /></F>
                </div>
              )}

              {isSpouseMember === "yes" && (
                <div className="border-t pt-4 flex flex-col gap-4">
                  <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 px-3 py-2 rounded-lg">
                    This will create a second member record linked to the same household.
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                    <input type="checkbox" checked={spouseSameAddress} onChange={(e) => {
                      setSpouseSameAddress(e.target.checked);
                      if (e.target.checked) {
                        setSp("address", JSON.parse(JSON.stringify(primary.address)));
                      }
                    }}
                      className="h-4 w-4 rounded text-blue-600 border-gray-300" />
                    Same residential address as main member
                  </label>
                  <MemberBlock data={spouse} set={setSp} config={config} formConfig={formConfig} showFaith={true} addressDisabled={spouseSameAddress} lockedBranch={appUser?.role === "branch_admin" ? (appUser.assignedBranch || "") : ""} />
                </div>
              )}
            </div>
          )}

          {/* ── SECTION 4: Children (new registrations only) ── */}
          {!isEditing && !joinExistingFamily && <div className="bg-white border rounded-xl p-6 shadow-sm flex flex-col gap-5">
            <SecHead n={next()} title="Children" sub="Add each child. Tick 'is a member' only if they should appear on the register." />
            <button type="button" onClick={addChild}
              className="self-start text-sm bg-blue-50 hover:bg-blue-100 text-blue-700 font-medium px-4 py-2 rounded-lg border border-blue-200 transition-colors">
              + Add Child
            </button>
            {children.length === 0 && (
              <p className="text-xs text-gray-400 italic">No children added yet.</p>
            )}
            {children.map((child, i) => (
              <div key={i} className="border rounded-lg p-4 bg-gray-50 flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <p className="text-sm font-bold text-gray-700">Child {i + 1}</p>
                  <button type="button" onClick={() => rmChild(i)} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <F label="First Name" req><input value={child.firstName} onChange={e => updChild(i, "firstName", e.target.value)} className={inp} required /></F>
                  <F label="Last Name" req><input value={child.lastName} onChange={e => updChild(i, "lastName", e.target.value)} className={inp} required /></F>
                  <F label="Date of Birth" req><DateInput value={child.dob} onChange={val => updChild(i, "dob", val)} className={inp} required /></F>
                  <F label="Gender" req>
                    <select value={child.gender} onChange={e => updChild(i, "gender", e.target.value)} className={sel} required>
                      <option value="">Select</option><option>Male</option><option>Female</option>
                    </select>
                  </F>
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700 mt-1">
                  <input type="checkbox" checked={child.isMember} onChange={e => updChild(i, "isMember", e.target.checked)}
                    className="h-4 w-4 rounded text-blue-600 border-gray-300" />
                  This child is a church member (will appear on the register)
                </label>
              </div>
            ))}
          </div>}

          {/* ── SECTION 5: Parents (new registrations only) ── */}
          {!isEditing && !joinExistingFamily && <div className="bg-white border rounded-xl p-6 shadow-sm flex flex-col gap-5">
            <SecHead n={next()} title="Parents' Details" sub="For record purposes only — no membership question." />
            <div className="grid grid-cols-2 gap-6">
              {(["mother", "father"] as const).map(p => (
                <div key={p} className="border rounded-lg p-4 bg-gray-50 flex flex-col gap-3">
                  <p className="text-sm font-bold text-gray-600 capitalize">{p}</p>
                  <F label="Name"><input value={parents[p].name} onChange={e => setParents(prev => ({ ...prev, [p]: { ...prev[p], name: e.target.value } }))} className={inp} /></F>
                  <F label="Surname"><input value={parents[p].surname} onChange={e => setParents(prev => ({ ...prev, [p]: { ...prev[p], surname: e.target.value } }))} className={inp} /></F>
                  <F label="Date of Birth"><DateInput value={parents[p].dob} onChange={val => setParents(prev => ({ ...prev, [p]: { ...prev[p], dob: val } }))} className={inp} /></F>
                </div>
              ))}
            </div>
          </div>}

          {/* ── SECTION 6: Parents-in-law (new registrations only, only if married) ── */}
          {!isEditing && !joinExistingFamily && isMarried && (
            <div className="bg-white border rounded-xl p-6 shadow-sm flex flex-col gap-5">
              <SecHead n={next()} title="Parents-in-law" sub="For record purposes only — no membership question." />
              <div className="grid grid-cols-2 gap-6">
                {([["motherInLaw", "Mother-in-law"], ["fatherInLaw", "Father-in-law"]] as const).map(([key, label]) => (
                  <div key={key} className="border rounded-lg p-4 bg-gray-50 flex flex-col gap-3">
                    <p className="text-sm font-bold text-gray-600">{label}</p>
                    <F label="Name"><input value={inLaws[key].name} onChange={e => setInLaws(prev => ({ ...prev, [key]: { ...prev[key], name: e.target.value } }))} className={inp} /></F>
                    <F label="Surname"><input value={inLaws[key].surname} onChange={e => setInLaws(prev => ({ ...prev, [key]: { ...prev[key], surname: e.target.value } }))} className={inp} /></F>
                    <F label="Date of Birth"><DateInput value={inLaws[key].dob} onChange={val => setInLaws(prev => ({ ...prev, [key]: { ...prev[key], dob: val } }))} className={inp} /></F>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── SECTION 7: POPIA Consent (new registrations only) ── */}
          {!isEditing && <div className="bg-white border rounded-xl p-6 shadow-sm flex flex-col gap-4">
            <SecHead n={next()} title="POPIA Consent" sub="Required before any personal information can be stored." />
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={consent.privacy} onChange={e => setConsent(p => ({ ...p, privacy: e.target.checked }))}
                className="mt-1 h-4 w-4 rounded text-blue-600 border-gray-300" required />
              <span className="text-sm text-gray-700">
                <strong>Privacy policy consent (required).</strong> This member confirms they have read and agreed to the church's privacy policy and consents to storage and processing of their personal information under POPIA.
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={consent.special} onChange={e => setConsent(p => ({ ...p, special: e.target.checked }))}
                className="mt-1 h-4 w-4 rounded text-blue-600 border-gray-300" />
              <span className="text-sm text-gray-700">
                <strong>Special information consent (optional — POPIA s.27).</strong> This member expressly consents to the processing of special personal information including religious beliefs and faith status.
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={consent.truth} onChange={e => setConsent(p => ({ ...p, truth: e.target.checked }))}
                className="mt-1 h-4 w-4 rounded text-blue-600 border-gray-300" />
              <span className="text-sm text-gray-700">I confirm that all information provided is true and accurate.</span>
            </label>
          </div>}

          {feedback && (
            <div className={`p-3 rounded-lg text-sm font-medium border ${feedback.ok ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
              {feedback.text}
            </div>
          )}

          <div className="flex gap-3 pb-10">
            <button type="submit" disabled={submitting}
              className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-bold py-3 rounded-lg transition-colors text-sm flex items-center justify-center gap-2">
              {submitting && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              {submitting ? "Saving..." : isEditing ? "Save Changes" : "Save Member"}
            </button>
            <button type="button" onClick={() => { setView("list"); reset(); setEditingMemberId(null); }}
              className="px-6 py-3 border border-gray-300 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          </div>
        </form>

        {/* Absence Exception — only shown when editing */}
        {editingMemberId && (
          <div className="mt-6 bg-white border border-blue-200 rounded-xl p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-gray-800">Absence Exception</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  Set this when a member is temporarily away (school, work, etc.). Their absences will still be recorded but will not count toward care tier alerts.
                </p>
              </div>
              {editingMemberException?.tag ? (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-full">
                    {editingMemberException.tag}
                  </span>
                  <button
                    type="button"
                    onClick={clearException}
                    disabled={clearingException}
                    className="text-xs font-semibold text-gray-500 bg-gray-50 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition disabled:opacity-50"
                  >
                    {clearingException ? "Removing..." : "Remove"}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { setExceptionTag("School"); setExceptionNote(""); setCustomTag(""); setShowExceptionModal(true); }}
                  className="shrink-0 text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition"
                >
                  Set Exception
                </button>
              )}
            </div>
            {editingMemberException?.note && (
              <p className="text-xs text-blue-500 mt-2 italic">{editingMemberException.note}</p>
            )}
          </div>
        )}

        {/* Exception Modal */}
        {showExceptionModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 flex flex-col gap-5">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Set Absence Exception</h3>
                  <p className="text-sm text-gray-500 mt-0.5">This member will be excluded from care tier alerts while the exception is active.</p>
                </div>
                <button onClick={() => setShowExceptionModal(false)} className="text-gray-400 hover:text-gray-600 text-xl font-bold leading-none">&times;</button>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Reason</label>
                <div className="flex flex-wrap gap-2">
                  {EXCEPTION_TAGS.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setExceptionTag(tag)}
                      className={`text-sm px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                        exceptionTag === tag
                          ? "bg-blue-50 border-blue-400 text-blue-700"
                          : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                {exceptionTag === "Other" && (
                  <input
                    type="text"
                    value={customTag}
                    onChange={(e) => setCustomTag(e.target.value)}
                    placeholder="Describe the reason..."
                    className="mt-1 border border-gray-200 rounded-lg p-2.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Note (optional)</label>
                <input
                  type="text"
                  value={exceptionNote}
                  onChange={(e) => setExceptionNote(e.target.value)}
                  placeholder="e.g. Studying in Cape Town until December"
                  className="border border-gray-200 rounded-lg p-2.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setShowExceptionModal(false)} className="text-sm text-gray-500 hover:text-gray-700 font-medium px-4 py-2 rounded-lg">Cancel</button>
                <button
                  type="button"
                  onClick={saveException}
                  disabled={savingException || (exceptionTag === "Other" && !customTag.trim())}
                  className="text-sm font-bold bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white px-5 py-2 rounded-lg transition"
                >
                  {savingException ? "Saving..." : "Save Exception"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Notes — only shown when editing an existing member */}
        {editingMemberId && (
          <div className="mt-6 bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
            <h2 className="text-base font-bold text-gray-800 mb-1">Notes</h2>
            <p className="text-xs text-gray-400 mb-4">Timestamped notes about this member. Each entry is permanent.</p>
            <NotesPanel
              parentPath={`members/${editingMemberId}`}
              authorName={appUser?.displayName || appUser?.name || appUser?.email || "Admin"}
              authorEmail={appUser?.email || ""}
              tenantId={appUser?.tenantId || ""}
            />
          </div>
        )}

        {/* Workflow instances — only shown when editing an existing member */}
        {editingMemberId && (
          <div className="mt-6 bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-bold text-gray-800">Active Workflows</h2>
                <p className="text-xs text-gray-400 mt-0.5">Workflows currently running for this member.</p>
              </div>
            </div>

            {memberWorkflows.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No workflows linked to this member.</p>
            ) : (
              <div className="space-y-3">
                {memberWorkflows.map((wf) => {
                  const pct = wf.totalSteps > 0 ? Math.round((wf.completedSteps / wf.totalSteps) * 100) : 0;
                  const statusColor = wf.status === "completed"
                    ? "bg-emerald-100 text-emerald-700"
                    : wf.status === "active"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-gray-100 text-gray-500";
                  return (
                    <div key={wf.id} className="flex items-center gap-4 p-3 bg-gray-50 border border-gray-100 rounded-lg">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{wf.workflowName}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden max-w-[100px]">
                            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-gray-400">{wf.completedSteps}/{wf.totalSteps} steps</span>
                        </div>
                      </div>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${statusColor}`}>
                        {wf.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURE VIEW
  // ═══════════════════════════════════════════════════════════════════════════

  if (view === "configure") {
    const addMinistry = () => {
      const val = newMinistry.trim();
      if (!val || editMinistries.includes(val)) return;
      setEditMinistries(p => [...p, val]);
      setNewMinistry("");
    };
    const addMembershipType = () => {
      const val = newMembershipType.trim();
      if (!val || editMembershipTypes.includes(val)) return;
      setEditMembershipTypes(p => [...p, val]);
      setNewMembershipType("");
    };

    return (
      <div className="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
        <button onClick={() => setView("list")} className="text-sm text-blue-600 hover:text-blue-800 font-medium self-start">
          ← Back to register
        </button>
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800">
          <strong>Tip:</strong> For full form customisation — toggle fields, rename labels, add custom fields — go to{" "}
          <a href="/dashboard/church-settings" className="underline font-semibold">Church Settings</a>.
          The lists below configure the ministry dropdown options saved on the tenant profile.
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-800 mb-1">Configure Lists</h1>
          <p className="text-sm text-gray-500">Customise the ministries and membership types available on your member registration form.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* Ministries */}
          <div className="bg-white border rounded-xl p-5 shadow-sm flex flex-col gap-4">
            <div>
              <p className="text-base font-bold text-gray-800">Ministries to Serve In</p>
              <p className="text-xs text-gray-400 mt-0.5">Shown as checkboxes on the registration form.</p>
            </div>
            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
              {editMinistries.map((m) => (
                <div key={m} className="flex items-center justify-between bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                  <span className="text-sm text-gray-700">{m}</span>
                  <button onClick={() => setEditMinistries(p => p.filter(x => x !== m))} className="text-red-400 hover:text-red-600 text-xs font-bold ml-2">Remove</button>
                </div>
              ))}
              {editMinistries.length === 0 && <p className="text-xs text-gray-400 italic py-2">No ministries added yet.</p>}
            </div>
            <div className="flex gap-2 mt-auto">
              <input value={newMinistry} onChange={e => setNewMinistry(e.target.value)} onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addMinistry())} placeholder="e.g. Youth Ministry" className={inp} />
              <button onClick={addMinistry} className="px-3 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 transition shrink-0">Add</button>
            </div>
          </div>

          {/* Membership Types */}
          <div className="bg-white border rounded-xl p-5 shadow-sm flex flex-col gap-4">
            <div>
              <p className="text-base font-bold text-gray-800">Type of Membership Sought</p>
              <p className="text-xs text-gray-400 mt-0.5">Shown as a dropdown on the registration form.</p>
            </div>
            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
              {editMembershipTypes.map((t) => (
                <div key={t} className="flex items-center justify-between bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                  <span className="text-sm text-gray-700">{t}</span>
                  <button onClick={() => setEditMembershipTypes(p => p.filter(x => x !== t))} className="text-red-400 hover:text-red-600 text-xs font-bold ml-2">Remove</button>
                </div>
              ))}
              {editMembershipTypes.length === 0 && <p className="text-xs text-gray-400 italic py-2">No types added yet.</p>}
            </div>
            <div className="flex gap-2 mt-auto">
              <input value={newMembershipType} onChange={e => setNewMembershipType(e.target.value)} onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addMembershipType())} placeholder="e.g. Youth Member" className={inp} />
              <button onClick={addMembershipType} className="px-3 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 transition shrink-0">Add</button>
            </div>
          </div>

          {/* Branches */}
          <div className="bg-white border rounded-xl p-5 shadow-sm flex flex-col gap-4">
            <div>
              <p className="text-base font-bold text-gray-800">Branches</p>
              <p className="text-xs text-gray-400 mt-0.5">Your church campuses or sites. Add one for each branch. When you have more than one, members choose their branch on the form. With a single branch it is filled in automatically.</p>
            </div>
            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
              {editBranches.map((b) => (
                <div key={b} className="flex items-center justify-between bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                  <span className="text-sm text-gray-700">{b}</span>
                  <button
                    onClick={() => {
                      setEditBranches(p => p.filter(x => x !== b));
                      // Unlink any cell groups that pointed at this branch.
                      setEditCellGroupBranch(prev => {
                        const next = { ...prev };
                        Object.keys(next).forEach(cg => { if (next[cg] === b) delete next[cg]; });
                        return next;
                      });
                      if (newCellRegionBranch === b) setNewCellRegionBranch("");
                    }}
                    className="text-red-400 hover:text-red-600 text-xs font-bold ml-2"
                  >Remove</button>
                </div>
              ))}
              {editBranches.length === 0 && <p className="text-xs text-gray-400 italic py-2">No branches added yet. Leave empty if you run a single site.</p>}
            </div>
            <div className="flex gap-2 mt-auto">
              <input value={newBranch} onChange={e => setNewBranch(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); const v = newBranch.trim(); if (v && !editBranches.includes(v)) { setEditBranches(p => [...p, v]); setNewBranch(""); } }}} placeholder="e.g. Main Campus" className={inp} />
              <button onClick={() => { const v = newBranch.trim(); if (v && !editBranches.includes(v)) { setEditBranches(p => [...p, v]); setNewBranch(""); }}} className="px-3 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 transition shrink-0">Add</button>
            </div>
          </div>

          {/* Cell Groups */}
          <div className="bg-white border rounded-xl p-5 shadow-sm flex flex-col gap-4">
            <div>
              <p className="text-base font-bold text-gray-800">Cell Groups</p>
              <p className="text-xs text-gray-400 mt-0.5">Small groups a member belongs to. If you have branches, pick which branch each cell group sits under so the form shows the right ones.</p>
            </div>
            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
              {editCellRegions.map((r) => (
                <div key={r} className="flex items-center justify-between bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                  <div className="flex flex-col">
                    <span className="text-sm text-gray-700">{r}</span>
                    {editBranches.length > 0 && (
                      <select
                        value={editCellGroupBranch[r] || ""}
                        onChange={e => {
                          const b = e.target.value;
                          setEditCellGroupBranch(prev => {
                            const next = { ...prev };
                            if (b) next[r] = b; else delete next[r];
                            return next;
                          });
                        }}
                        className="mt-1 border border-gray-200 rounded px-2 py-1 text-xs text-gray-600 bg-white"
                      >
                        <option value="">All branches</option>
                        {editBranches.map(b => <option key={b} value={b}>{b}</option>)}
                      </select>
                    )}
                  </div>
                  <button onClick={() => { setEditCellRegions(p => p.filter(x => x !== r)); setEditCellGroupBranch(prev => { const next = { ...prev }; delete next[r]; return next; }); }} className="text-red-400 hover:text-red-600 text-xs font-bold ml-2 shrink-0">Remove</button>
                </div>
              ))}
              {editCellRegions.length === 0 && <p className="text-xs text-gray-400 italic py-2">No cell groups added yet.</p>}
            </div>
            <div className="flex flex-col gap-2 mt-auto">
              {editBranches.length > 0 && (
                <select value={newCellRegionBranch} onChange={e => setNewCellRegionBranch(e.target.value)} className={sel}>
                  <option value="">All branches</option>
                  {editBranches.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
              <div className="flex gap-2">
                <input value={newCellRegion} onChange={e => setNewCellRegion(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); const v = newCellRegion.trim(); if (v && !editCellRegions.includes(v)) { setEditCellRegions(p => [...p, v]); if (newCellRegionBranch) setEditCellGroupBranch(prev => ({ ...prev, [v]: newCellRegionBranch })); setNewCellRegion(""); } }}} placeholder="e.g. Tuesday Night Cell" className={inp} />
                <button onClick={() => { const v = newCellRegion.trim(); if (v && !editCellRegions.includes(v)) { setEditCellRegions(p => [...p, v]); if (newCellRegionBranch) setEditCellGroupBranch(prev => ({ ...prev, [v]: newCellRegionBranch })); setNewCellRegion(""); }}} className="px-3 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 transition shrink-0">Add</button>
              </div>
            </div>
          </div>

          {/* Ministry Group */}
          <div className="bg-white border rounded-xl p-5 shadow-sm flex flex-col gap-4">
            <div>
              <p className="text-base font-bold text-gray-800">Ministry Group</p>
              <p className="text-xs text-gray-400 mt-0.5">Required dropdown on the registration form. e.g. Youth, Mens Fellowship.</p>
            </div>
            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
              {editMinistryGroups.map((g) => (
                <div key={g} className="flex items-center justify-between bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                  <span className="text-sm text-gray-700">{g}</span>
                  <button onClick={() => setEditMinistryGroups(p => p.filter(x => x !== g))} className="text-red-400 hover:text-red-600 text-xs font-bold ml-2">Remove</button>
                </div>
              ))}
              {editMinistryGroups.length === 0 && <p className="text-xs text-gray-400 italic py-2">No ministry groups added yet.</p>}
            </div>
            <div className="flex gap-2 mt-auto">
              <input value={newMinistryGroup} onChange={e => setNewMinistryGroup(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); const v = newMinistryGroup.trim(); if (v && !editMinistryGroups.includes(v)) { setEditMinistryGroups(p => [...p, v]); setNewMinistryGroup(""); } }}} placeholder="e.g. Youth" className={inp} />
              <button onClick={() => { const v = newMinistryGroup.trim(); if (v && !editMinistryGroups.includes(v)) { setEditMinistryGroups(p => [...p, v]); setNewMinistryGroup(""); }}} className="px-3 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 transition shrink-0">Add</button>
            </div>
          </div>

          {/* Church Role / Office */}
          <div className="bg-white border rounded-xl p-5 shadow-sm flex flex-col gap-4">
            <div>
              <p className="text-base font-bold text-gray-800">Church Role / Office</p>
              <p className="text-xs text-gray-400 mt-0.5">Formal church offices. e.g. Elder, Deacon, Trustee. Shown as a dropdown on the registration form.</p>
            </div>
            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
              {editChurchRoles.map((r) => (
                <div key={r} className="flex items-center justify-between bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                  <span className="text-sm text-gray-700">{r}</span>
                  <button onClick={() => setEditChurchRoles(p => p.filter(x => x !== r))} className="text-red-400 hover:text-red-600 text-xs font-bold ml-2">Remove</button>
                </div>
              ))}
              {editChurchRoles.length === 0 && <p className="text-xs text-gray-400 italic py-2">No church roles added yet.</p>}
            </div>
            <div className="flex gap-2 mt-auto">
              <input value={newChurchRole} onChange={e => setNewChurchRole(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); const v = newChurchRole.trim(); if (v && !editChurchRoles.includes(v)) { setEditChurchRoles(p => [...p, v]); setNewChurchRole(""); } }}} placeholder="e.g. Elder" className={inp} />
              <button onClick={() => { const v = newChurchRole.trim(); if (v && !editChurchRoles.includes(v)) { setEditChurchRoles(p => [...p, v]); setNewChurchRole(""); }}} className="px-3 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 transition shrink-0">Add</button>
            </div>
          </div>

        </div>

        <div className="flex gap-3">
          <button
            onClick={saveConfig}
            disabled={configSaving}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-bold py-2.5 px-6 rounded-lg text-sm transition"
          >
            {configSaving ? "Saving..." : "Save Changes"}
          </button>
          <button
            onClick={() => setView("list")}
            className="px-6 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IMPORT VIEW
  // ═══════════════════════════════════════════════════════════════════════════

  if (view === "import") {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6 flex flex-col gap-6">
        <UpgradeLimitModal open={showUpgradeModal} limit={memberLimit} onClose={() => setShowUpgradeModal(false)} />
        <button onClick={() => setView("list")} className="text-sm text-blue-600 hover:text-blue-800 font-medium self-start">← Back to register</button>
        <div>
          <h1 className="text-2xl font-bold text-gray-800 mb-1">Import Members</h1>
          <p className="text-sm text-gray-500">Upload a CSV or XLSX file from your website or any source. Common column names are mapped automatically.</p>
        </div>

        {/* Export guide */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 flex flex-col gap-3">
          <p className="text-sm font-bold text-amber-800">How to export your members from the kfwc-members-zone Firebase project</p>
          <ol className="text-xs text-amber-700 space-y-1.5 list-decimal list-inside">
            <li>Download your service account key: Firebase console → <strong>kfwc-members-zone</strong> → Project Settings → Service accounts → Generate new private key</li>
            <li>Save the file as <code className="bg-white px-1 rounded">serviceAccountKey.json</code> in your project folder</li>
            <li>Run the script below — it reads <code>membership_forms</code> and writes <code>members-export.xlsx</code></li>
          </ol>
          <pre className="bg-white border border-amber-100 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto whitespace-pre">{`// export-members.mjs  (run with: node export-members.mjs)
import admin from 'firebase-admin';
import { utils, write } from 'xlsx';
import { writeFileSync } from 'fs';
import sa from './serviceAccountKey.json' assert { type: 'json' };

admin.initializeApp({ credential: admin.credential.cert(sa) });
const snap = await admin.firestore().collection('membership_forms').get();

const rows = snap.docs.map(d => {
  const data = d.data();
  const pd   = data.personalDetails || {};
  return {
    firstName:      pd.name            || '',
    lastName:       pd.surname         || '',
    email:          pd.email           || '',
    phone:          pd.contactNumber   || '',
    dob:            pd.dob             || '',
    gender:         pd.gender          || '',
    maritalStatus:  data.maritalStatus || '',
    membershipType: data.membershipType|| '',
    bornAgain:      data.faithStatus?.bornAgain      || '',
    waterBaptized:  data.faithStatus?.waterBaptized  || '',
    ministries:     (data.ministries || []).join(', '),
  };
});

const wb = utils.book_new();
utils.book_append_sheet(wb, utils.json_to_sheet(rows), 'Members');
writeFileSync('members-export.xlsx', write(wb, { type: 'buffer', bookType: 'xlsx' }));
console.log(\`Exported \${rows.length} records → members-export.xlsx\`);`}</pre>
          <p className="text-xs text-amber-600">You need Node 18+ and: <code className="bg-white px-1 rounded">npm install firebase-admin xlsx</code></p>
        </div>

        {/* File upload */}
        <div className="bg-white border rounded-xl p-6 shadow-sm flex flex-col gap-3">
          <p className="text-sm font-bold text-gray-700">Upload your CSV or XLSX file</p>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFile}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer" />
          {importParsing && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" /> Reading file...
            </div>
          )}
          <div className="border-t border-gray-100 pt-3 flex items-center gap-3">
            <label className="text-xs font-semibold text-gray-500 whitespace-nowrap">Phone country</label>
            <select
              value={importCountryCode}
              onChange={e => setImportCountryCode(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {COUNTRY_CODES.map(c => (
                <option key={c.code} value={c.code}>{c.label} +{c.code} ({c.name})</option>
              ))}
            </select>
            <p className="text-xs text-gray-400">Used to format phone numbers starting with 0 in the file.</p>
          </div>
        </div>

        {/* Preview */}
        {importRows.length > 0 && (
          <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b bg-gray-50 flex justify-between items-center">
              <p className="text-sm font-bold text-gray-700">{importRows.length} rows detected</p>
              <p className="text-xs text-gray-500 truncate max-w-xs">Columns: {Object.keys(importRows[0]).join(", ")}</p>
            </div>
            <div className="overflow-x-auto max-h-56 overflow-y-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-gray-50 sticky top-0 border-b">
                  <tr>{Object.keys(importRows[0]).slice(0, 8).map(c => (
                    <th key={c} className="px-3 py-2 text-gray-500 font-semibold uppercase tracking-wider">{c}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {importRows.slice(0, 8).map((row, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      {Object.values(row as object).slice(0, 8).map((v: any, j) => (
                        <td key={j} className="px-3 py-2 text-gray-700 truncate max-w-[120px]">{String(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {importRows.length > 8 && <p className="p-3 text-center text-xs text-gray-400">...and {importRows.length - 8} more rows</p>}
            </div>
            <div className="p-4 border-t bg-gray-50 flex flex-col gap-3">
              {/* Duplicate warning panel */}
              {duplicateWarning && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col gap-3">
                  <p className="text-sm font-bold text-amber-800">
                    {duplicateWarning.dups.length} potential duplicate{duplicateWarning.dups.length !== 1 ? "s" : ""} found
                  </p>
                  <p className="text-xs text-amber-700">
                    The following rows match an existing member by first name, last name, and date of birth. Please review before importing.
                  </p>
                  <ul className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                    {duplicateWarning.dups.map((d, i) => (
                      <li key={i} className="text-xs text-amber-800 bg-white border border-amber-100 rounded-lg px-3 py-2">
                        <span className="font-semibold">{d.importName}</span>
                        <span className="text-amber-500 mx-1">DOB: {d.importDob}</span>
                        <span className="text-amber-600">matches existing member: <span className="font-semibold">{d.existingName}</span></span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-3 flex-wrap">
                    <button
                      onClick={() => handleImport(new Set(duplicateWarning.dups.map(d => d.rowIndex)))}
                      disabled={importing}
                      className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-bold py-2 px-4 rounded-lg text-sm"
                    >
                      Skip duplicates — import {duplicateWarning.total - duplicateWarning.dups.length} new record{duplicateWarning.total - duplicateWarning.dups.length !== 1 ? "s" : ""}
                    </button>
                    <button
                      onClick={() => handleImport(new Set())}
                      disabled={importing}
                      className="bg-white hover:bg-gray-50 disabled:opacity-50 border border-amber-300 text-amber-800 font-bold py-2 px-4 rounded-lg text-sm"
                    >
                      Import all {duplicateWarning.total} anyway
                    </button>
                    <button
                      onClick={() => setDuplicateWarning(null)}
                      className="text-sm text-gray-500 hover:text-gray-700 font-medium px-2"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {!duplicateWarning && (
                <button onClick={handleImportClick} disabled={importing}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-bold py-2 px-6 rounded-lg text-sm flex items-center gap-2 self-start">
                  {importing && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                  {importing ? "Importing..." : `Import ${importRows.length} Member${importRows.length !== 1 ? "s" : ""}`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PENDING APPROVALS VIEW
  // ═══════════════════════════════════════════════════════════════════════════

  if (view === "pending") {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6 flex flex-col gap-6">
        <UpgradeLimitModal open={showUpgradeModal} limit={memberLimit} onClose={() => setShowUpgradeModal(false)} />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Pending Membership Requests</h1>
            <p className="text-sm text-gray-500 mt-1">Review and approve self-submitted membership forms.</p>
          </div>
          <button onClick={() => setView("list")} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
            Back to Register
          </button>
        </div>

        {pendingLoading ? (
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            Loading requests...
          </div>
        ) : pendingRequests.length === 0 ? (
          <div className="bg-white border rounded-xl p-10 text-center text-gray-400 text-sm">
            No pending requests at the moment.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {pendingRequests.map((req) => (
              <div key={req.id} className="bg-white border rounded-xl p-5 shadow-sm flex flex-col gap-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {Object.entries(req)
                    .filter(([k]) => !["id","status","submittedAt","source","tenantId"].includes(k))
                    .map(([k, v]) => (
                      <div key={k}>
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider capitalize">
                          {k.replace(/([A-Z])/g, " $1")}
                        </p>
                        <p className="text-sm text-gray-800">{String(v || "")}</p>
                      </div>
                    ))}
                </div>
                <div className="flex gap-3 pt-2 border-t">
                  <button
                    onClick={() => approvePending(req)}
                    className="px-4 py-2 text-sm font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
                  >
                    Approve and Add Member
                  </button>
                  <button
                    onClick={() => rejectPending(req.id)}
                    className="px-4 py-2 text-sm font-semibold text-red-600 border border-red-200 bg-white rounded-lg hover:bg-red-50 transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SUSPENDED MEMBERS VIEW
  // ═══════════════════════════════════════════════════════════════════════════

  if (view === "suspended") {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6 flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Suspended Members</h1>
            <p className="text-sm text-gray-500 mt-1">
              These members are hidden from the active register and attendance, and no longer count toward your member limit. Nothing is deleted — reinstate at any time.
            </p>
          </div>
          <button onClick={() => setView("list")} className="text-sm text-blue-600 hover:text-blue-800 font-medium shrink-0">
            Back to Register
          </button>
        </div>

        {suspendedMembers.length === 0 ? (
          <div className="bg-white border rounded-xl p-10 text-center text-gray-400 text-sm">
            No suspended members. Suspend someone from the register instead of removing them if you expect they may come back.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {suspendedMembers.map((m) => (
              <div key={m.id} className="bg-white border rounded-xl p-5 shadow-sm flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <p className="font-semibold text-gray-800">{formatSurnameFirst(m)}</p>
                  <div className="flex gap-2 mt-1 flex-wrap text-xs text-gray-400">
                    {m.phone && <span>+{m.phone}</span>}
                    {m.suspendedReason && <span className="italic">"{m.suspendedReason}"</span>}
                  </div>
                </div>
                <button
                  onClick={() => reinstateMember(m.id)}
                  className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors shrink-0"
                >
                  Reinstate
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST VIEW (default)
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 flex flex-col gap-6">
      <UpgradeLimitModal open={showUpgradeModal} limit={memberLimit} onClose={() => setShowUpgradeModal(false)} />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-800">Membership Management</h1>
          <p className="text-gray-500 text-sm mt-1">
            {appUser?.role === "cell_leader"
              ? `Viewing your cell: ${appUser.assignedCellRegion || "assigned cell"}`
              : "Register, import, and manage your congregation."}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {appUser?.role !== "cell_leader" && <>
          {appUser?.role !== "branch_admin" && (
          <button onClick={openConfigure}
            className="px-4 py-2 text-sm font-semibold text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Configure Lists
          </button>
          )}
          <button onClick={() => setView("import")}
            className="px-4 py-2 text-sm font-semibold text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Import Members
          </button>

          {/* ── Export button (CSV/XLSX) ── */}
          {/* Column headers use Brevo's expected attribute names so the file
              can be imported into Brevo directly without remapping. */}
          <ExportMemberButton
            data={filteredMembers.map(m => {
              const a = (m as any).address || {};
              const addrParts = [a.line1, a.line2, a.suburb, a.town, a.postalCode].filter(Boolean);
              // Derive first/last from dedicated fields; fall back to splitting fullName
              const parts = (m.fullName || "").trim().split(/\s+/);
              return {
                FIRSTNAME: m.firstName || parts[0] || "",
                LASTNAME: m.lastName || parts.slice(1).join(" ") || "",
                email: m.email || "",
                SMS: m.phone || "",
                ADDRESS: addrParts.join(", "),
                ROLE: m.role || "",
                MEMBERSHIP_TYPE: m.membershipType || "",
                GENDER: m.gender || "",
                DATE_OF_BIRTH: m.dob || "",
                BRANCH: m.branch || "",
                CELL_GROUP: m.cellRegion || "",
                MINISTRY_GROUP: m.ministryGroup || "",
                MARITAL_STATUS: m.maritalStatus || "",
              };
            })}
            filename="members-brevo"
            columns={[
              { key: "FIRSTNAME",       label: "FIRSTNAME" },
              { key: "LASTNAME",        label: "LASTNAME" },
              { key: "email",           label: "email" },
              { key: "SMS",             label: "SMS" },
              { key: "ADDRESS",         label: "ADDRESS" },
              { key: "ROLE",            label: "ROLE" },
              { key: "MEMBERSHIP_TYPE", label: "MEMBERSHIP_TYPE" },
              { key: "GENDER",          label: "GENDER" },
              { key: "DATE_OF_BIRTH",   label: "DATE_OF_BIRTH" },
              { key: "BRANCH",          label: "BRANCH" },
              { key: "CELL_GROUP",      label: "CELL_GROUP" },
              { key: "MINISTRY_GROUP",  label: "MINISTRY_GROUP" },
              { key: "MARITAL_STATUS",  label: "MARITAL_STATUS" },
            ]}
          />

          <button
            onClick={() => { setView("pending"); loadPending(); }}
            className="px-4 py-2 text-sm font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors flex items-center gap-1.5"
          >
            Pending Approvals
            {pendingRequests.length > 0 && (
              <span className="bg-amber-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">{pendingRequests.length}</span>
            )}
          </button>
          <button
            onClick={() => setView("suspended")}
            className="px-4 py-2 text-sm font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors flex items-center gap-1.5"
          >
            Suspended
            {suspendedMembers.length > 0 && (
              <span className="bg-slate-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">{suspendedMembers.length}</span>
            )}
          </button>
          <button
            onClick={() => setShowJoinLink(true)}
            className="px-4 py-2 text-sm font-semibold text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Share Join Link
          </button>
          {/* Bulk Portal Invite */}
          {(appUser?.role === "owner" || appUser?.role === "admin") && (
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={bulkInviteMembers}
                disabled={bulkInviting}
                className="px-3 py-2 bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold rounded-lg hover:bg-emerald-100 transition disabled:opacity-50"
              >
                {bulkInviting ? "Sending invites..." : "Invite All to Portal"}
              </button>
              {bulkInviteResult && (
                <p className="text-[10px] text-gray-500">
                  {bulkInviteResult.invited} sent, {bulkInviteResult.skipped} skipped, {bulkInviteResult.failed} failed
                </p>
              )}
            </div>
          )}
          <button onClick={() => { if (atMemberLimit) { setShowUpgradeModal(true); return; } reset(); setView("form"); }}
            className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
            + Add Member
          </button>
          </>}
        </div>
      </div>

      {feedback && (
        <div className={`p-3 rounded-lg text-sm font-medium border ${feedback.ok ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {feedback.text}
        </div>
      )}


      {/* ── Search bar ── */}
      <div className="relative">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={memberSearch}
          onChange={(e) => setMemberSearch(e.target.value)}
          placeholder="Search members by name, email, or phone..."
          className="w-full border border-gray-200 rounded-xl pl-9 pr-9 py-2.5 text-sm text-gray-700 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {memberSearch && (
          <button
            onClick={() => setMemberSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs font-bold"
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {/* ── Filter panel ── */}
      <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between gap-4">
          <button
            onClick={() => setShowFilters((v) => !v)}
            className="flex items-center gap-2 text-sm font-semibold text-gray-600 hover:text-gray-900 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M3 4h18M7 8h10M10 12h4" strokeLinecap="round"/>
            </svg>
            {showFilters ? "Hide Filters" : "Filter Members"}
            {activeFilters > 0 && (
              <span className="bg-blue-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                {activeFilters}
              </span>
            )}
          </button>
          {activeFilters > 0 && (
            <button
              onClick={() => {
                setFilterMinistryGroup(""); setFilterMaritalStatus("");
                setFilterBranch(""); setFilterCellRegion(""); setFilterBornAgain("");
                setFilterWaterBaptized(""); setFilterMembershipType("");
              }}
              className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
            >
              Clear all filters
            </button>
          )}
        </div>

        {showFilters && (
          <div className="px-5 pb-4 border-t border-gray-100 pt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
            {/* Ministry Group */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1">
                Ministry Group
                <InfoTooltip text="The broader ministry a member belongs to, e.g. Youth, Worship, Ushering." why="Use this to filter rosters when planning ministry-specific communication or events." />
              </label>
              <select
                value={filterMinistryGroup}
                onChange={(e) => setFilterMinistryGroup(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All</option>
                {config.ministryGroups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>

            {/* Marital Status */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Marital Status</label>
              <select
                value={filterMaritalStatus}
                onChange={(e) => setFilterMaritalStatus(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All</option>
                {["Single", "Married", "Divorced", "Widowed", "Separated"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* Branch */}
            {config.branches.length > 0 && (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1">
                  Branch
                  <InfoTooltip text="The church campus or site a member is attached to." why="Lets branch pastors pull their own list without seeing the whole church." />
                </label>
                <select
                  value={filterBranch}
                  onChange={(e) => setFilterBranch(e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All</option>
                  {config.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}

            {/* Cell Group */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1">
                Cell Group
                <InfoTooltip text="The small group a member is attached to." why="Helps cell leaders pull their own list without seeing the whole church." />
              </label>
              <select
                value={filterCellRegion}
                onChange={(e) => setFilterCellRegion(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All</option>
                {cellGroupsForBranch(config.cellRegions, config.cellGroupBranch || {}, filterBranch).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>

            {/* Born Again */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Born Again?</label>
              <select
                value={filterBornAgain}
                onChange={(e) => setFilterBornAgain(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All</option>
                {["Yes", "No", "Not Sure"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>

            {/* Water Baptized */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Water Baptized?</label>
              <select
                value={filterWaterBaptized}
                onChange={(e) => setFilterWaterBaptized(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All</option>
                {["Yes", "No", "Not Yet"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>

            {/* Type of Membership */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1">
                Type of Membership
                <InfoTooltip text="How this person relates to the church, e.g. Full Member, Associate, Visitor Turned Member." why="Some reports and tier limits count only certain membership types, so this affects your numbers." />
              </label>
              <select
                value={filterMembershipType}
                onChange={(e) => setFilterMembershipType(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All</option>
                {config.membershipTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b bg-gray-50">
          <p className="text-sm font-bold text-gray-700">Active Register — {filteredMembers.length}{(activeFilters > 0 || memberSearch) ? ` of ${members.length}` : ""} member{filteredMembers.length !== 1 ? "s" : ""}</p>
        </div>
        {filteredMembers.length === 0 ? (
          <div className="p-10 text-center text-gray-400 text-sm">
            {members.length === 0 ? (<>No members yet. Use <strong>+ Add Member</strong> to register your first member, or <strong>Import Members</strong> to import from your website.</>) : (<>No members match {memberSearch ? "your search" : "the current filters"}. <button onClick={() => { setMemberSearch(""); setFilterMinistryGroup(""); setFilterMaritalStatus(""); setFilterCellRegion(""); setFilterBornAgain(""); setFilterWaterBaptized(""); setFilterMembershipType(""); }} className="text-blue-600 underline font-medium">Clear {memberSearch ? "search" : "filters"}</button></>)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider border-b">
                <tr>
                  <th className="px-5 py-3 font-semibold">Name</th>
                  <th className="px-5 py-3 font-semibold">Contact</th>
                  <th className="px-5 py-3 font-semibold">Role / Membership</th>
                  <th className="px-5 py-3 font-semibold">Consent</th>
                  <th className="px-5 py-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredMembers.map(m => {
                  const days = daysUntilBirthday(m.dob);
                  return (
                    <tr key={m.id} className="hover:bg-gray-50/70 transition-colors">
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link href={`/dashboard/roster/${m.id}`} onClick={() => sessionStorage.setItem("rosterScrollY", String(window.scrollY))} className="font-medium text-emerald-600 hover:text-emerald-700 hover:underline cursor-pointer">
                            {formatSurnameFirst(m)}
                          </Link>
                          {days !== null && days <= 10 && (
                            <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-medium">
                              {days === 0 ? "🎂 Today!" : `🎂 ${days}d`}
                            </span>
                          )}
                        </div>
                        <div className="flex gap-1.5 mt-1 flex-wrap">
                          {m.householdRole && m.householdRole !== "primary" && (
                            <span className="text-[10px] bg-purple-50 text-purple-600 border border-purple-100 px-1.5 py-0.5 rounded capitalize">{m.householdRole}</span>
                          )}
                          {m.householdId && (
                            <button
                              type="button"
                              onClick={() => setFamilyModalId(m.householdId!)}
                              title="View the whole family"
                              className="text-[10px] bg-teal-50 text-teal-700 border border-teal-100 px-1.5 py-0.5 rounded hover:bg-teal-100 transition-colors"
                            >
                              🏠 {householdMap.get(m.householdId)?.familyName ? `${householdMap.get(m.householdId)!.familyName} Family` : "Family"}
                            </button>
                          )}
                          {m.source === "website_import" && (
                            <span className="text-[10px] bg-indigo-50 text-indigo-600 border border-indigo-100 px-1.5 py-0.5 rounded">Website</span>
                          )}
                          {m.maritalStatus && (
                            <span className="text-[10px] text-gray-400">{m.maritalStatus}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <p className="font-mono text-xs text-gray-600">{m.phone ? `+${m.phone}` : "—"}</p>
                        {m.dob && <p className="text-xs text-gray-400 mt-0.5">DOB: {m.dob}</p>}
                        {m.email && <p className="text-xs text-gray-400 truncate max-w-[160px]">{m.email}</p>}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-col gap-1">
                          <span className={`text-xs px-2 py-0.5 rounded font-medium w-fit ${
                            m.role === "Pastor" ? "bg-purple-100 text-purple-800" :
                            m.role === "Treasurer" ? "bg-amber-100 text-amber-800" :
                            m.role === "Youth Leader" ? "bg-green-100 text-green-800" :
                            "bg-gray-100 text-gray-600"
                          }`}>{m.role}</span>
                          {m.membershipType && <span className="text-xs text-gray-500">{m.membershipType}</span>}
                          {m.churchRole && <span className="text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-100 px-1.5 py-0.5 rounded w-fit">{m.churchRole}</span>}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        {m.consentedToPrivacyPolicy
                          ? <span className="text-[10px] bg-green-50 text-green-700 border border-green-200 px-1.5 py-0.5 rounded font-medium">✓ POPIA</span>
                          : <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded font-medium">! No consent</span>
                        }
                      </td>
                      <td className="px-5 py-4 text-right">
                        {appUser?.role !== "cell_leader" && (
                          <div className="flex items-center justify-end gap-3 flex-wrap">
                            {/* Portal invite status + button */}
                            {m.email && (
                              m.portalStatus === "active" ? (
                                <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded font-medium">Portal Active</span>
                              ) : m.portalStatus === "invited" ? (
                                <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded font-medium">Invite Sent</span>
                              ) : (
                                <button
                                  onClick={() => inviteMemberToPortal(m.id)}
                                  disabled={invitingMemberId === m.id}
                                  className="text-[10px] bg-gray-50 text-gray-600 border border-gray-200 px-1.5 py-0.5 rounded font-medium hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200 transition disabled:opacity-50"
                                >
                                  {invitingMemberId === m.id ? "Inviting..." : "Invite to Portal"}
                                </button>
                              )
                            )}
                            {inviteResult?.id === m.id && (
                              <span className={`text-[10px] ${inviteResult.ok ? "text-emerald-600" : "text-red-500"}`}>
                                {inviteResult.msg}
                              </span>
                            )}
                            <button onClick={() => openEdit(m)} className="text-blue-600 hover:text-blue-800 text-xs font-medium">Edit</button>
                            <button
                              onClick={() => { setLinkFamilyMember(m); setLinkFamilySearch(""); setLinkFamilyTargetId(""); setLinkFamilyRole("child"); }}
                              className="text-teal-600 hover:text-teal-800 text-xs font-medium"
                            >
                              Link to Family
                            </button>
                            <button onClick={() => openSuspend(m)} className="text-amber-600 hover:text-amber-800 text-xs font-medium">Suspend</button>
                            <button onClick={() => handleDelete(m.id)} className="text-red-500 hover:text-red-700 text-xs font-medium">Remove</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Join Link Modal */}
      {showJoinLink && appUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 flex flex-col gap-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-800">Share Membership Form</h3>
                <p className="text-sm text-gray-500 mt-0.5">Send this link to prospective members so they can fill in their own form.</p>
              </div>
              <button onClick={() => setShowJoinLink(false)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
            </div>
            {(() => {
              const joinUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/join/${appUser.tenantId}`;
              return (
                <>
                  <p className="text-xs text-gray-600 break-all bg-gray-50 border rounded p-3 select-all">{joinUrl}</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => navigator.clipboard.writeText(joinUrl)}
                      className="flex-1 text-sm font-medium py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      Copy Link
                    </button>
                    <button
                      onClick={() => setShowJoinLink(false)}
                      className="flex-1 text-sm font-medium py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                    >
                      Done
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 text-center">
                    Submissions appear under Pending Approvals for you to review before adding to the register.
                  </p>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Suspend Member Modal */}
      {suspendModalMember && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-800">Suspend Membership</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  {formatSurnameFirst(suspendModalMember)} will come off the active register and attendance, and will not count toward your member limit. Their record is kept, not deleted, so you can reinstate them any time from the Suspended tab.
                </p>
              </div>
              <button onClick={() => setSuspendModalMember(null)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none shrink-0">&times;</button>
            </div>
            <F label="Reason (optional)">
              <textarea
                value={suspendReason}
                onChange={e => setSuspendReason(e.target.value)}
                placeholder="e.g. Unreachable since March, moved churches..."
                rows={3}
                className={inp}
              />
            </F>
            <div className="flex gap-3">
              <button
                onClick={confirmSuspend}
                disabled={suspending}
                className="flex-1 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white font-bold py-2.5 rounded-lg transition-colors text-sm"
              >
                {suspending ? "Suspending..." : "Suspend Membership"}
              </button>
              <button
                onClick={() => setSuspendModalMember(null)}
                className="px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Link to Family Modal */}
      {linkFamilyMember && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-800">Link to Family</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Connect {formatSurnameFirst(linkFamilyMember)} to another member already in the register, for cases where they were added separately but belong to the same family.
                </p>
              </div>
              <button onClick={() => setLinkFamilyMember(null)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none shrink-0">&times;</button>
            </div>
            <F label="Search for the family member to link with" req>
              <input
                value={linkFamilySearch}
                onChange={e => { setLinkFamilySearch(e.target.value); setLinkFamilyTargetId(""); }}
                placeholder="Type a name..."
                className={inp}
              />
            </F>
            {linkFamilySearch.trim() && !linkFamilyTargetId && (
              <div className="border rounded-lg bg-white max-h-48 overflow-y-auto divide-y divide-gray-50">
                {members.filter(m => m.id !== linkFamilyMember.id && m.status !== "suspended" && (m.fullName || `${m.firstName || ""} ${m.lastName || ""}`).toLowerCase().includes(linkFamilySearch.trim().toLowerCase())).slice(0, 20).map(m => (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => { setLinkFamilyTargetId(m.id); setLinkFamilySearch(m.fullName || `${m.firstName || ""} ${m.lastName || ""}`.trim()); }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-teal-50 transition-colors"
                  >
                    {m.fullName || `${m.firstName || ""} ${m.lastName || ""}`.trim()}
                    {m.phone && <span className="text-xs text-gray-400 ml-2">+{m.phone}</span>}
                  </button>
                ))}
                {members.filter(m => m.id !== linkFamilyMember.id && m.status !== "suspended" && (m.fullName || `${m.firstName || ""} ${m.lastName || ""}`).toLowerCase().includes(linkFamilySearch.trim().toLowerCase())).length === 0 && (
                  <p className="px-3 py-2 text-xs text-gray-400 italic">No matching member found.</p>
                )}
              </div>
            )}
            {linkFamilyTargetId && (
              <F label={`${formatSurnameFirst(linkFamilyMember)} is the target's...`} req>
                <select value={linkFamilyRole} onChange={e => setLinkFamilyRole(e.target.value as any)} className={sel} required>
                  <option value="child">Child</option>
                  <option value="spouse">Spouse</option>
                  <option value="parent">Parent</option>
                  <option value="other">Other relative</option>
                </select>
              </F>
            )}
            <div className="flex gap-3">
              <button
                onClick={confirmLinkFamily}
                disabled={linkingFamily || !linkFamilyTargetId}
                className="flex-1 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-300 text-white font-bold py-2.5 rounded-lg transition-colors text-sm"
              >
                {linkingFamily ? "Linking..." : "Link to Family"}
              </button>
              <button
                onClick={() => setLinkFamilyMember(null)}
                className="px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Family View Modal */}
      {familyModalId && (() => {
        const hh = householdMap.get(familyModalId as string);
        const famMembers = members.filter(m => m.householdId === familyModalId);
        const order: Record<string, number> = { primary: 0, spouse: 1, child: 2 };
        famMembers.sort((a, b) => (order[a.householdRole || ""] ?? 3) - (order[b.householdRole || ""] ?? 3));
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 flex flex-col gap-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xl">🏠</span>
                  <h3 className="text-lg font-bold text-gray-800">{hh?.familyName ? `${hh.familyName} Family` : "Family"}</h3>
                </div>
                <button onClick={() => setFamilyModalId(null)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none shrink-0">&times;</button>
              </div>
              <div className="flex flex-col divide-y divide-gray-50 border rounded-lg">
                {famMembers.length === 0 ? (
                  <p className="p-4 text-sm text-gray-400 italic">No members found for this family.</p>
                ) : famMembers.map(m => (
                  <div key={m.id} className="flex items-center justify-between px-4 py-2.5 gap-2">
                    <div>
                      <Link href={`/dashboard/roster/${m.id}`} onClick={() => setFamilyModalId(null)} className="text-sm font-medium text-emerald-600 hover:underline">
                        {formatSurnameFirst(m)}
                      </Link>
                      <p className="text-[10px] text-gray-400 capitalize">{m.householdRole || "member"}</p>
                    </div>
                    {m.status === "suspended" && (
                      <span className="text-[10px] bg-slate-100 text-slate-500 border border-slate-200 px-1.5 py-0.5 rounded shrink-0">Suspended</span>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-3">
                <Link
                  href={`/dashboard/attendance?family=${familyModalId}`}
                  className="flex-1 text-center bg-teal-600 hover:bg-teal-700 text-white font-bold py-2.5 rounded-lg transition-colors text-sm"
                >
                  Family Check-in
                </Link>
                <button
                  onClick={() => setFamilyModalId(null)}
                  className="px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
