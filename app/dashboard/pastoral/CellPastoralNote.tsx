"use client";

import { useState, useEffect } from "react";
import { db } from "../../../lib/firebase";
import { useAppUser } from "../../../lib/useAppUser";
import { CARE_TYPES, type CareType } from "../../../lib/careTypes";
import { collection, addDoc, getDocs, query, where, serverTimestamp } from "firebase/firestore";

// ────────────────────────────────────────────────────────────────────────────
// CELL GROUP PASTORAL NOTE — submit form (cell leaders)
//
// A cell leader flags a care need for one of their group members: pick the
// member, pick a care type, write the note. It writes into the same care_logs
// collection the pastoral team works from, tagged source "cell_group" and with
// the leader's name, so owner/admin see it in their queue. Cell leaders can
// only CREATE here; they never read or manage the queue.
// ────────────────────────────────────────────────────────────────────────────

type Member = { id: string; name: string };

const todayStr = () => new Date().toISOString().split("T")[0];

export default function CellPastoralNote() {
  const { appUser, tenantId, loading: userLoading } = useAppUser();
  const region = appUser?.assignedCellRegion || "";
  const leaderName = appUser?.displayName || appUser?.email || "Cell Leader";

  const [members, setMembers] = useState<Member[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [showDrop, setShowDrop] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [selectedMemberName, setSelectedMemberName] = useState("");

  const [careType, setCareType] = useState<CareType>("home_visit");
  const [date, setDate] = useState(todayStr());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saveErr, setSaveErr] = useState("");

  // Load this leader's own cell-group members for the picker.
  useEffect(() => {
    if (!tenantId || !region) return;
    getDocs(
      query(collection(db, "members"), where("tenantId", "==", tenantId), where("cellRegion", "==", region))
    )
      .then((snap) => {
        const list = snap.docs
          .map((d) => {
            const data = d.data();
            const name = data.fullName || `${data.firstName || ""} ${data.lastName || ""}`.trim();
            return { id: d.id, name };
          })
          .filter((m) => m.name)
          .sort((a, b) => a.name.localeCompare(b.name));
        setMembers(list);
      })
      .catch((err) => console.error("Failed to load members:", err));
  }, [tenantId, region]);

  const memberResults = memberSearch.trim()
    ? members.filter((m) => m.name.toLowerCase().includes(memberSearch.toLowerCase())).slice(0, 8)
    : [];

  function selectMember(m: Member) {
    setSelectedMemberId(m.id);
    setSelectedMemberName(m.name);
    setMemberSearch("");
    setShowDrop(false);
  }

  async function handleSave() {
    setSaveErr("");
    setSaveMsg("");
    if (!tenantId || !region) return;
    if (!selectedMemberId) {
      setSaveErr("Please select a member from your group.");
      return;
    }
    if (!notes.trim()) {
      setSaveErr("Please add a note about this member.");
      return;
    }
    setSaving(true);
    try {
      await addDoc(collection(db, "care_logs"), {
        tenantId,
        memberId: selectedMemberId,
        memberName: selectedMemberName,
        type: careType,
        date,
        notes: notes.trim(),
        assignedTo: leaderName,
        status: "open",
        // Tags that let the pastoral team see this came from a cell group.
        source: "cell_group",
        submittedByName: leaderName,
        cellRegion: region,
        createdAt: serverTimestamp(),
      });
      setSaveMsg(`Note submitted for ${selectedMemberName}. Your pastoral team will see it.`);
      setSelectedMemberId("");
      setSelectedMemberName("");
      setNotes("");
      setDate(todayStr());
      setCareType("home_visit");
      setTimeout(() => setSaveMsg(""), 5000);
    } catch (err) {
      console.error(err);
      setSaveErr("Could not submit. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (userLoading) {
    return (
      <div className="p-10 flex items-center gap-2">
        <div className="w-5 h-5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Pastoral Care</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Flag a care need for someone in your cell group. Your pastoral team picks it up from here.
        </p>
        {region ? (
          <p className="text-xs text-gray-400 mt-1">
            Submitting for <span className="font-semibold text-gray-600">{region}</span>
          </p>
        ) : (
          <p className="text-sm text-red-500 mt-3">
            You are not assigned to a cell group yet, so there are no members to flag. Ask your church admin to assign your group.
          </p>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        {/* Member picker */}
        <div className="relative">
          <label className="block text-sm font-medium text-gray-700 mb-1">Member</label>
          {selectedMemberId ? (
            <div className="flex items-center justify-between border border-emerald-200 bg-emerald-50 rounded-lg px-3 py-2">
              <span className="text-sm font-medium text-emerald-800">{selectedMemberName}</span>
              <button
                onClick={() => { setSelectedMemberId(""); setSelectedMemberName(""); }}
                className="text-xs text-emerald-600 hover:text-emerald-800 font-semibold"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={memberSearch}
                onChange={(e) => { setMemberSearch(e.target.value); setShowDrop(true); }}
                onFocus={() => setShowDrop(true)}
                placeholder={region ? "Search your group members..." : "No group assigned"}
                disabled={!region}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-gray-50"
              />
              {showDrop && memberResults.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                  {memberResults.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => selectMember(m)}
                      className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-emerald-50"
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
              {showDrop && memberSearch.trim() && memberResults.length === 0 && (
                <p className="text-xs text-gray-400 mt-1">No members match that search.</p>
              )}
            </>
          )}
        </div>

        {/* Care type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Type of care</label>
          <div className="grid grid-cols-2 gap-2">
            {CARE_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setCareType(t.value)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all ${
                  careType === t.value
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                    : "border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                <span>{t.icon}</span>
                <span className="text-xs font-medium">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Date */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
          <input
            type="date"
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value)}
            disabled={!region}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-gray-50"
          />
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What is going on with this member, and what care is needed?"
            disabled={!region}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none disabled:bg-gray-50"
          />
        </div>

        {saveErr && <p className="text-sm text-red-600">{saveErr}</p>}
        {saveMsg && <p className="text-sm text-emerald-600">{saveMsg}</p>}

        <button
          onClick={handleSave}
          disabled={saving || !region}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors"
        >
          {saving ? "Submitting…" : "Submit Note"}
        </button>
      </div>

      <p className="text-xs text-gray-400 mt-4">
        These notes go straight to your pastoral team. For privacy, cell leaders cannot see the full care history.
      </p>
    </div>
  );
}
