// Shared pastoral care interaction types.
//
// Used by the Pastoral Care queue (owner/admin) and by the cell-leader
// "Cell Group Pastoral Note" submit form, so both offer the same options.

export type CareType =
  | "hospital_visit"
  | "home_visit"
  | "phone_call"
  | "counseling"
  | "prayer"
  | "bereavement"
  | "other";

export const CARE_TYPES: { value: CareType; label: string; icon: string }[] = [
  { value: "hospital_visit", label: "Hospital Visit", icon: "🏥" },
  { value: "home_visit", label: "Home Visit", icon: "🏠" },
  { value: "phone_call", label: "Phone Call", icon: "📞" },
  { value: "counseling", label: "Counseling Session", icon: "💬" },
  { value: "prayer", label: "Prayer Meeting", icon: "🙏" },
  { value: "bereavement", label: "Bereavement Visit", icon: "🕊️" },
  { value: "other", label: "Other", icon: "📝" },
];

export function getCareInfo(type: CareType) {
  return CARE_TYPES.find((t) => t.value === type) ?? CARE_TYPES[CARE_TYPES.length - 1];
}
