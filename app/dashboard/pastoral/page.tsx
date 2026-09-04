'use client';

// hub: app/dashboard/pastoral/page.tsx
//
// Pastoral Care Log — log visits, phone calls, counseling sessions, and other
// care interactions against members. Restricted to owner and admin roles.
// Active Cases tab shows open items; History tab shows all with filters.

import { useState, useEffect } from 'react';
import { db } from '../../../lib/firebase';
import { useAppUser } from '../../../lib/useAppUser';
import InfoTooltip from '../../components/InfoTooltip';
import {
  collection, addDoc, updateDoc, getDocs,
  query, where, orderBy, doc, serverTimestamp,
} from 'firebase/firestore';
import { CARE_TYPES, type CareType, getCareInfo } from '../../../lib/careTypes';
import CellPastoralNote from './CellPastoralNote';

// --- Types ---

type CareLog = {
  id: string;
  memberId: string;
  memberName: string;
  type: CareType;
  date: string;
  notes: string;
  assignedTo: string;
  status: 'open' | 'closed';
  createdAt: unknown;
};

type Member = { id: string; name: string };
type PageTab = 'active' | 'log' | 'history';

// --- Helpers ---

const todayStr = () => new Date().toISOString().split('T')[0];

// --- Page ---

// Cell leaders reach the same Pastoral Care nav item but only get the submit
// form, never the queue (they cannot read care_logs). Everyone else gets the
// full queue below.
export default function PastoralCarePage() {
  const { appUser, loading: userLoading } = useAppUser();
  if (userLoading) {
    return (
      <div className="p-10 flex items-center gap-2">
        <div className="w-5 h-5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }
  if (appUser?.role === 'cell_leader') return <CellPastoralNote />;
  return <PastoralCareQueue />;
}

function PastoralCareQueue() {
  const { appUser, loading: userLoading } = useAppUser();
  const [tab, setTab] = useState<PageTab>('active');

  // Member picker state
  const [members, setMembers] = useState<Member[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberResults, setMemberResults] = useState<Member[]>([]);
  const [showDrop, setShowDrop] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [selectedMemberName, setSelectedMemberName] = useState('');

  // Log form state
  const [date, setDate] = useState(todayStr());
  const [careType, setCareType] = useState<CareType>('home_visit');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');

  // Logs state
  const [logs, setLogs] = useState<CareLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<CareType | 'all'>('all');

  // Load members for picker
  useEffect(() => {
    if (!appUser?.tenantId) return;
    getDocs(query(collection(db, 'members'), where('tenantId', '==', appUser.tenantId)))
      .then(snap => {
        const list = snap.docs.map(d => {
          const data = d.data();
          const name = data.fullName || `${data.firstName || ''} ${data.lastName || ''}`.trim();
          return { id: d.id, name };
        }).filter(m => m.name).sort((a, b) => a.name.localeCompare(b.name));
        setMembers(list);
      }).catch(console.error);
  }, [appUser]);

  // Load care logs
  const loadLogs = async () => {
    if (!appUser?.tenantId) return;
    setLogsLoading(true);
    setLogsError('');
    try {
      const snap = await getDocs(
        query(
          collection(db, 'care_logs'),
          where('tenantId', '==', appUser.tenantId),
          orderBy('date', 'desc'),
        )
      );
      setLogs(snap.docs.map(d => ({ id: d.id, ...d.data() } as CareLog)));
    } catch (err) {
      console.error('Failed to load care logs:', err);
      // A permission-denied here usually means this account isn't an owner or
      // admin (pastoral notes are restricted); anything else is most likely a
      // transient Firestore/index issue, so we say so rather than showing a
      // silent, empty-looking list.
      const code = (err as { code?: string })?.code;
      setLogsError(
        code === 'permission-denied'
          ? "You don't have access to pastoral care records. This tab is limited to owner and admin roles."
          : 'Could not load care records right now. Please refresh the page, and let support know if this keeps happening.'
      );
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    if (appUser?.tenantId) loadLogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUser]);

  // Member search
  const handleMemberSearch = (q: string) => {
    setMemberSearch(q);
    setShowDrop(true);
    setMemberResults(
      q.trim()
        ? members.filter(m => m.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
        : []
    );
  };

  const selectMember = (m: Member) => {
    setSelectedMemberId(m.id);
    setSelectedMemberName(m.name);
    setMemberSearch('');
    setShowDrop(false);
    setMemberResults([]);
  };

  const clearMember = () => {
    setSelectedMemberId('');
    setSelectedMemberName('');
  };

  // Save care log
  const handleSave = async () => {
    setSaveErr('');
    if (!selectedMemberId) { setSaveErr('Please select a member.'); return; }
    if (!notes.trim()) { setSaveErr('Please add notes about this interaction.'); return; }
    setSaving(true);
    try {
      await addDoc(collection(db, 'care_logs'), {
        tenantId: appUser!.tenantId,
        memberId: selectedMemberId,
        memberName: selectedMemberName,
        type: careType,
        date,
        notes: notes.trim(),
        assignedTo: appUser!.displayName || (appUser as unknown as { name?: string })?.name || 'Unknown',
        status: 'open',
        createdAt: serverTimestamp(),
      });
      setSaveMsg(`Care log saved for ${selectedMemberName}.`);
      setTimeout(() => setSaveMsg(''), 4000);
      clearMember();
      setNotes('');
      setDate(todayStr());
      await loadLogs();
      setTab('active');
    } catch (err) {
      console.error(err);
      setSaveErr('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Toggle open / closed status
  const toggleStatus = async (log: CareLog) => {
    const newStatus: 'open' | 'closed' = log.status === 'open' ? 'closed' : 'open';
    try {
      await updateDoc(doc(db, 'care_logs', log.id), { status: newStatus });
      setLogs(prev => prev.map(l => l.id === log.id ? { ...l, status: newStatus } : l));
    } catch (err) {
      console.error(err);
    }
  };

  // Derived
  const activeLogs = logs.filter(l => l.status === 'open');
  const historyLogs = logs.filter(l => {
    const nameMatch = !historySearch || l.memberName.toLowerCase().includes(historySearch.toLowerCase());
    const typeMatch = typeFilter === 'all' || l.type === typeFilter;
    return nameMatch && typeMatch;
  });

  if (userLoading) return (
    <div className="p-10 flex items-center gap-2">
      <div className="w-5 h-5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
      <p className="text-gray-600">Loading...</p>
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Pastoral Care</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Log visits, calls, and counseling sessions. No member falls through the cracks.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-end gap-1 mb-6 border-b border-gray-200">
        {([
          { key: 'active',  label: `Active Cases (${activeLogs.length})` },
          { key: 'log',     label: '+ New Entry' },
          { key: 'history', label: 'History' },
        ] as { key: PageTab; label: string }[]).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition ${
              tab === t.key
                ? 'bg-white border border-b-white border-gray-200 text-emerald-700 -mb-px'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Active Cases ── */}
      {tab === 'active' && (
        <div>
          {logsError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4">
              {logsError}
            </p>
          )}
          {logsLoading ? (
            <div className="flex items-center gap-2 p-8">
              <div className="w-5 h-5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500">Loading...</p>
            </div>
          ) : logsError ? null : activeLogs.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-14 text-center">
              <p className="text-4xl mb-3">✅</p>
              <p className="text-sm font-semibold text-gray-700">No open cases</p>
              <p className="text-xs text-gray-400 mt-1 mb-4">
                All clear, or nothing has been logged yet.
              </p>
              <button
                onClick={() => setTab('log')}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg transition"
              >
                Log New Entry
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {activeLogs.map(log => {
                const info = getCareInfo(log.type);
                return (
                  <div key={log.id} className="bg-white border border-gray-200 rounded-xl p-5">
                    <div className="flex items-start gap-4">
                      <span className="text-2xl mt-0.5 shrink-0">{info.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="font-bold text-gray-900">{log.memberName}</span>
                          <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                            {info.label}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mb-2">
                          {log.date} · Logged by {log.assignedTo}
                        </p>
                        <p className="text-sm text-gray-700 leading-relaxed">{log.notes}</p>
                      </div>
                      <button
                        onClick={() => toggleStatus(log)}
                        className="shrink-0 text-xs font-semibold text-gray-500 hover:text-emerald-700 border border-gray-200 hover:border-emerald-300 px-3 py-1.5 rounded-lg transition"
                      >
                        Mark Resolved
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── New Entry ── */}
      {tab === 'log' && (
        <div className="max-w-lg">
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">New Care Entry</h2>

            {/* Member picker */}
            <div className="relative">
              <label className="block text-xs font-semibold text-gray-600 mb-1">Member *</label>
              {selectedMemberId ? (
                <div className="flex items-center justify-between border border-emerald-300 bg-emerald-50 rounded-lg px-3 py-2">
                  <span className="text-sm font-medium text-emerald-800">{selectedMemberName}</span>
                  <button
                    type="button"
                    onClick={clearMember}
                    className="text-xs text-emerald-500 hover:text-red-500 font-semibold ml-2"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <input
                  type="text"
                  value={memberSearch}
                  onChange={e => handleMemberSearch(e.target.value)}
                  onFocus={() => { if (memberSearch) setShowDrop(true); }}
                  onBlur={() => setTimeout(() => setShowDrop(false), 200)}
                  placeholder="Search member name..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              )}
              {showDrop && memberResults.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {memberResults.map(m => (
                    <button
                      key={m.id}
                      type="button"
                      onMouseDown={() => selectMember(m)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-emerald-50 text-gray-800"
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Date + type */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={e => setDate(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="flex items-center gap-1 text-xs font-semibold text-gray-600 mb-1">
                  Type
                  <InfoTooltip text="The kind of care interaction this was, for example a visit, phone call, or counseling session." why="Sorting care by type lets you see patterns later, like how many home visits your team did in a month, without opening every single record." />
                </label>
                <select
                  value={careType}
                  onChange={e => setCareType(e.target.value as CareType)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  {CARE_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="flex items-center gap-1 text-xs font-semibold text-gray-600 mb-1">
                Notes *
                <InfoTooltip text="What happened and any follow-up needed from this care interaction." why="Pastoral notes are sensitive and only owners and admins can see them. Write enough for continuity of care, but remember the person may one day ask what was recorded." />
              </label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={4}
                placeholder="What was discussed? What is the member going through? Any follow-up needed?"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
              />
              <p className="text-xs text-gray-400 mt-1">
                These notes are private and visible to admin and owner roles only.
              </p>
            </div>

            {saveErr && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {saveErr}
              </p>
            )}
            {saveMsg && (
              <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                {saveMsg}
              </p>
            )}

            <button
              onClick={handleSave}
              disabled={saving || !selectedMemberId || !notes.trim()}
              className="w-full py-2.5 rounded-lg text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white transition disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Care Log'}
            </button>
          </div>
        </div>
      )}

      {/* ── History ── */}
      {tab === 'history' && (
        <div className="space-y-4">
          {logsError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              {logsError}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <input
              value={historySearch}
              onChange={e => setHistorySearch(e.target.value)}
              placeholder="Search member..."
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value as CareType | 'all')}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="all">All Types</option>
              {CARE_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {logsError ? null : historyLogs.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
              <p className="text-sm text-gray-400">No records match your filter.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {historyLogs.map(log => {
                const info = getCareInfo(log.type);
                return (
                  <div
                    key={log.id}
                    className={`bg-white border rounded-xl p-4 transition ${
                      log.status === 'closed' ? 'border-gray-100 opacity-70' : 'border-gray-200'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-xl mt-0.5 shrink-0">{info.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm text-gray-900">{log.memberName}</span>
                          <span className="text-xs text-gray-400">{info.label}</span>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                            log.status === 'closed'
                              ? 'bg-gray-100 text-gray-500'
                              : 'bg-amber-50 text-amber-700'
                          }`}>
                            {log.status === 'closed' ? 'Resolved' : 'Open'}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{log.date} · {log.assignedTo}</p>
                        <p className="text-sm text-gray-600 mt-1 line-clamp-2">{log.notes}</p>
                      </div>
                      <button
                        onClick={() => toggleStatus(log)}
                        className="shrink-0 text-xs font-semibold text-gray-400 hover:text-emerald-600 transition"
                      >
                        {log.status === 'closed' ? 'Reopen' : 'Resolve'}
                      </button>
                    </div>
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
