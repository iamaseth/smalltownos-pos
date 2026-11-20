'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import api from '@/lib/api';

type ShiftStatus = 'draft' | 'published' | 'cancelled';
type View = 'day' | 'week' | 'month';
type Layout = 'shift' | 'person';
interface Shift {
  id: string; staff_id: string; staff_name: string; role: string; work_date: string;
  shift_type_id: string | null; starts_at: string; ends_at: string; status: ShiftStatus;
}
interface ShiftType { id: string; label: string; start_time: string; end_time: string }
interface StaffMember { id: string; name: string; role: string; schedule_only: number; target_days_per_week: number | null; job_label: string | null }
interface ScheduleData { shifts: Shift[]; shift_types: ShiftType[]; staff: StaffMember[]; timezone: string; can_manage: boolean }

const COLORS = [
  'bg-sky-100 border-sky-300 text-sky-950', 'bg-violet-100 border-violet-300 text-violet-950',
  'bg-emerald-100 border-emerald-300 text-emerald-950', 'bg-amber-100 border-amber-300 text-amber-950',
  'bg-rose-100 border-rose-300 text-rose-950', 'bg-cyan-100 border-cyan-300 text-cyan-950',
  'bg-fuchsia-100 border-fuchsia-300 text-fuchsia-950', 'bg-lime-100 border-lime-300 text-lime-950',
  'bg-indigo-100 border-indigo-300 text-indigo-950', 'bg-orange-100 border-orange-300 text-orange-950',
  'bg-slate-100 border-slate-300 text-slate-950', 'bg-pink-100 border-pink-300 text-pink-950',
];
const DOTS = ['bg-sky-400', 'bg-violet-400', 'bg-emerald-400', 'bg-amber-400', 'bg-rose-400', 'bg-cyan-400',
  'bg-fuchsia-400', 'bg-lime-400', 'bg-indigo-400', 'bg-orange-400', 'bg-slate-400', 'bg-pink-400'];
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', server: 'Server', chef: 'Kitchen' };
const roleLabel = (role: string) => ROLE_LABEL[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
const jobOf = (p: { role: string; job_label?: string | null } | undefined, role = 'server') => p?.job_label || roleLabel(p?.role ?? role);

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}
function todayIn(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return parts.slice(0, 10);
  } catch { return new Date().toISOString().slice(0, 10); }
}
function dayLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...options });
}
function localTime(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(`${iso.replace(' ', 'T')}Z`));
  } catch { return iso.slice(11, 16); }
}
interface Ctx {
  canManage: boolean; busy: boolean; selected: string | null; openChip: string | null; setOpenChip: (id: string | null) => void;
  timezone: string; types: ShiftType[]; shifts: Shift[]; colorIndex: Map<string, number>; dropCell: string | null; jobs: Map<string, string>;
  update: (shift: Shift, changes: Record<string, unknown>, message?: string) => Promise<void>;
  place: (staffId: string, workDate: string, typeId: string) => Promise<void>;
  dropProps: (cellKey: string, workDate: string, typeId: string | null, staffId?: string) => Record<string, unknown>;
}
function errorText(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

export default function StaffSchedulePage() {
  const [timezone, setTimezone] = useState('Asia/Phnom_Penh');
  const [anchor, setAnchor] = useState(() => todayIn('Asia/Phnom_Penh'));
  const [view, setView] = useState<View>('week');
  const [layout, setLayout] = useState<Layout>('shift');
  const [data, setData] = useState<ScheduleData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [menu, setMenu] = useState<'copy' | 'times' | 'targets' | null>(null);
  const [dropCell, setDropCell] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const weekStart = mondayOf(anchor);
  const range = useMemo(() => {
    if (view === 'day') return { from: anchor, to: anchor };
    if (view === 'week') return { from: weekStart, to: addDays(weekStart, 6) };
    const first = `${anchor.slice(0, 7)}-01`;
    const start = mondayOf(first);
    return { from: start, to: addDays(start, 41) };
  }, [view, anchor, weekStart]);

  const params = useMemo(() => ({
    from: view === 'month' || range.from < weekStart ? range.from : weekStart,
    to: view === 'month' || range.to > addDays(weekStart, 6) ? range.to : addDays(weekStart, 6),
  }), [range, view, weekStart]);
  const apply = (next: ScheduleData) => { setData(next); setTimezone(next.timezone || 'Asia/Phnom_Penh'); };
  const load = useCallback(async () => {
    try {
      const res = await api.get('/schedule', { params });
      setData(res.data);
      setTimezone(res.data.timezone || 'Asia/Phnom_Penh');
    } catch (error) { toast.error(errorText(error, 'Could not load the staff schedule')); }
  }, [params]);
  useEffect(() => {
    let active = true;
    api.get('/schedule', { params })
      .then((res) => { if (active) apply(res.data); })
      .catch((error) => toast.error(errorText(error, 'Could not load the staff schedule')));
    return () => { active = false; };
  }, [params]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const canManage = data?.can_manage === true;
  const staff = useMemo(() => data?.staff ?? [], [data]);
  const jobs = useMemo(() => new Map(staff.map((p) => [p.id, jobOf(p)])), [staff]);
  const types = data?.shift_types ?? [];
  const shifts = useMemo(() => data?.shifts ?? [], [data]);
  const colorIndex = useMemo(() => new Map(staff.map((p, i) => [p.id, i % COLORS.length])), [staff]);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const inWeek = (s: Shift) => s.work_date >= weekStart && s.work_date <= addDays(weekStart, 6);
  const daysFor = (id: string) => new Set(shifts.filter((s) => s.staff_id === id && inWeek(s)).map((s) => s.work_date)).size;
  const weekShifts = shifts.filter(inWeek);
  const drafts = weekShifts.filter((s) => s.status === 'draft').length;
  const belowTarget = staff.filter((p) => p.target_days_per_week != null && daysFor(p.id) < p.target_days_per_week).length;
  const today = todayIn(timezone);
  const name = (id: string) => staff.find((p) => p.id === id)?.name ?? 'Staff';

  const place = (staffId: string, workDate: string, typeId: string) => run(async () => {
    try {
      await api.post('/schedule', { staff_id: staffId, work_date: workDate, shift_type_id: typeId });
      toast.success(`${name(staffId)} added (draft)`);
      await load();
    } catch (error) { toast.error(errorText(error, 'Could not add the shift')); }
  });
  const update = (shift: Shift, changes: Record<string, unknown>, message?: string) => run(async () => {
    try {
      await api.patch(`/schedule/${shift.id}`, changes);
      if (message) toast.success(message);
      setOpenChip(null);
      await load();
    } catch (error) { toast.error(errorText(error, 'Could not update the shift')); }
  });
  const copyWeek = (staffId?: string) => run(async () => {
    try {
      const res = await api.post('/schedule/copy-week', { week_start: weekStart, staff_id: staffId });
      toast.success(`Copied ${res.data.copied} shifts as drafts${res.data.skipped ? `, skipped ${res.data.skipped} already booked` : ''}`);
      setMenu(null);
      await load();
    } catch (error) { toast.error(errorText(error, 'Could not copy last week')); }
  });
  const publishWeek = () => run(async () => {
    try {
      const res = await api.post('/schedule/publish-week', { week_start: weekStart });
      toast.success(res.data.published ? `Published ${res.data.published} shifts` : 'Nothing to publish');
      await load();
    } catch (error) { toast.error(errorText(error, 'Could not publish the week')); }
  });

  const onDrop = (event: React.DragEvent, workDate: string, typeId: string | null, staffId?: string) => {
    event.preventDefault();
    setDropCell(null);
    if (!canManage) return;
    const [kind, id] = event.dataTransfer.getData('text/plain').split(':');
    if (kind === 'staff' && typeId) void place(id, workDate, typeId);
    if (kind === 'shift') {
      const shift = shifts.find((s) => s.id === id);
      if (!shift) return;
      const changes: Record<string, unknown> = {};
      if (shift.work_date !== workDate) changes.work_date = workDate;
      if (typeId && shift.shift_type_id !== typeId) changes.shift_type_id = typeId;
      if (staffId && shift.staff_id !== staffId) changes.staff_id = staffId;
      if (Object.keys(changes).length) void update(shift, changes, 'Moved — publish again so staff see it');
    }
  };
  const dropProps = (cellKey: string, workDate: string, typeId: string | null, staffId?: string) => canManage ? {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (dropCell !== cellKey) setDropCell(cellKey); },
    onDragLeave: () => setDropCell((current) => (current === cellKey ? null : current)),
    onDrop: (e: React.DragEvent) => onDrop(e, workDate, typeId, staffId),
  } : {};

  const ctx: Ctx = {
    canManage, busy, selected, openChip, setOpenChip, timezone, types, shifts, colorIndex, dropCell, jobs,
    update, place, dropProps,
  };

  const title = view === 'day' ? dayLabel(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : view === 'week' ? `${dayLabel(weekStart, { day: 'numeric', month: 'short' })} – ${dayLabel(addDays(weekStart, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`
      : dayLabel(`${anchor.slice(0, 7)}-01`, { month: 'long', year: 'numeric' });
  const move = (n: number) => {
    if (view === 'day') setAnchor(addDays(anchor, n));
    else if (view === 'week') setAnchor(addDays(anchor, 7 * n));
    else { const [y, m] = anchor.split('-').map(Number); setAnchor(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10)); }
  };
  const tabClass = (on: boolean) => `rounded-md px-3 py-1 text-sm ${on ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground'}`;
  const btn = 'rounded-lg border bg-background px-3 py-1.5 text-sm disabled:opacity-50';

  if (!data) return <div className="p-6 text-muted-foreground">Loading schedule…</div>;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-3 p-1" onClick={() => { setMenu(null); setPicker(null); }}>
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Staff schedule</h1>
          <p className="text-sm text-muted-foreground">
            {canManage ? 'Drag a person onto a shift — or tap the person, then tap the shift. Drag shifts to move them.' : 'Planned shifts for the team.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className="rounded-full border px-2.5 py-1">{weekShifts.length} shifts this week</span>
          {belowTarget > 0 && <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-amber-800">{belowTarget} staff below their days</span>}
          {drafts > 0 && <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-amber-800">{drafts} drafts not published</span>}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border p-2.5">
        <span className="mr-1 text-xs text-muted-foreground">Staff</span>
        {staff.map((p) => {
          const days = daysFor(p.id);
          return (
            <button key={p.id} type="button" draggable={canManage}
              onDragStart={(e) => e.dataTransfer.setData('text/plain', `staff:${p.id}`)}
              onClick={(e) => { e.stopPropagation(); if (canManage) setSelected(selected === p.id ? null : p.id); }}
              className={`rounded-lg border px-3 py-1.5 text-left ${COLORS[colorIndex.get(p.id) ?? 0]} ${selected === p.id ? 'ring-2 ring-foreground ring-offset-1' : ''}`}>
              <span className="block text-sm font-semibold">{p.name}</span>
              <span className="text-[11px]">{jobOf(p)} · {p.target_days_per_week == null ? `${days} days` : `${days}/${p.target_days_per_week} days`}</span>
            </button>
          );
        })}
        {canManage && <AddPerson onAdded={load} />}
        {staff.length === 0 && !canManage && <span className="text-sm text-muted-foreground">No staff yet.</span>}
      </div>
      {selected && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900">
          Tap a shift to place {name(selected)}. Tap {name(selected)} again to stop.
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button type="button" className={btn} onClick={() => move(-1)} aria-label="Previous">‹</button>
          <button type="button" className={btn} onClick={() => { setAnchor(today); setView('day'); }}>Today</button>
          <button type="button" className={btn} onClick={() => move(1)} aria-label="Next">›</button>
          <b className="ml-2 text-sm">{title}</b>
        </div>
        <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {canManage && (
            <>
              <div className="relative">
                <button type="button" className={btn} disabled={busy} onClick={() => setMenu(menu === 'copy' ? null : 'copy')}>Copy last week ▾</button>
                {menu === 'copy' && (
                  <div className="absolute right-0 z-30 mt-1 w-56 rounded-lg border bg-background p-1.5 shadow-xl">
                    <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => void copyWeek()}>Copy everyone</button>
                    <div className="px-2 pt-2 text-[11px] text-muted-foreground">Or copy one person</div>
                    <div className="max-h-56 overflow-y-auto">
                      {staff.map((p) => <button key={p.id} type="button" className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => void copyWeek(p.id)}>{p.name}</button>)}
                    </div>
                  </div>
                )}
              </div>
              <div className="relative">
                <button type="button" className={btn} onClick={() => setMenu(menu === 'times' ? null : 'times')}>Shift times ▾</button>
                {menu === 'times' && <ShiftTimesMenu types={types} onSaved={load} />}
              </div>
              <div className="relative">
                <button type="button" className={btn} onClick={() => setMenu(menu === 'targets' ? null : 'targets')}>Staff days &amp; jobs ▾</button>
                {menu === 'targets' && <TargetsMenu staff={staff} onSaved={load} />}
              </div>
              <button type="button" className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || drafts === 0} onClick={() => void publishWeek()}>Publish week</button>
            </>
          )}
          <div className="inline-flex rounded-lg bg-muted p-0.5">
            <button type="button" className={tabClass(layout === 'shift')} onClick={() => { setLayout('shift'); }}>By shift</button>
            <button type="button" className={tabClass(layout === 'person')} onClick={() => { setLayout('person'); setView('week'); }}>By person</button>
          </div>
          <div className="inline-flex rounded-lg bg-muted p-0.5">
            {(['day', 'week', 'month'] as View[]).map((v) => <button key={v} type="button" className={tabClass(view === v)} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
          </div>
        </div>
      </div>

      {view === 'week' && layout === 'shift' && (
        <div className="overflow-x-auto rounded-xl border">
          <div className="min-w-[980px]">
            <div className="grid grid-cols-[130px_repeat(7,minmax(120px,1fr))] border-b bg-muted/40">
              <div className="border-r p-2 text-xs font-semibold">Shift</div>
              {weekDays.map((d) => (
                <div key={d} className={`border-r p-2 text-center last:border-r-0 ${d === today ? 'bg-emerald-50' : ''}`}>
                  <div className="text-xs text-muted-foreground">{dayLabel(d, { weekday: 'short' })}</div>
                  <div className="font-bold">{dayLabel(d, { day: 'numeric' })}</div>
                </div>
              ))}
            </div>
            {types.map((t) => (
              <div key={t.id} className="grid grid-cols-[130px_repeat(7,minmax(120px,1fr))] border-b last:border-b-0">
                <div className="border-r bg-muted/20 p-2"><div className="text-sm font-semibold">{t.label}</div><div className="text-[11px] text-muted-foreground">{t.start_time}–{t.end_time}</div></div>
                {weekDays.map((d) => <div key={d} className="border-r last:border-r-0"><ShiftCell workDate={d} type={t} ctx={ctx} /></div>)}
              </div>
            ))}
          </div>
        </div>
      )}

      {view === 'week' && layout === 'person' && (
        <div className="overflow-x-auto rounded-xl border">
          <div className="min-w-[980px]">
            <div className="grid grid-cols-[150px_repeat(7,minmax(115px,1fr))] border-b bg-muted/40">
              <div className="border-r p-2 text-xs font-semibold">Staff</div>
              {weekDays.map((d) => (
                <div key={d} className={`border-r p-2 text-center last:border-r-0 ${d === today ? 'bg-emerald-50' : ''}`}>
                  <div className="text-xs text-muted-foreground">{dayLabel(d, { weekday: 'short' })}</div>
                  <div className="font-bold">{dayLabel(d, { day: 'numeric' })}</div>
                </div>
              ))}
            </div>
            {staff.map((p) => (
              <div key={p.id} className="grid grid-cols-[150px_repeat(7,minmax(115px,1fr))] border-b">
                <div className="flex items-center gap-2 border-r px-2.5 py-2">
                  <i className={`inline-block size-2.5 rounded-full ${DOTS[colorIndex.get(p.id) ?? 0]}`} />
                  <div><div className="text-sm font-semibold">{p.name}</div>
                    <div className="text-[11px] text-muted-foreground">{jobOf(p)} · {p.target_days_per_week == null ? `${daysFor(p.id)} days` : `${daysFor(p.id)}/${p.target_days_per_week} days`}</div></div>
                </div>
                {weekDays.map((d) => {
                  const cellKey = `${p.id}|${d}`;
                  const list = shifts.filter((s) => s.staff_id === p.id && s.work_date === d);
                  return (
                    <div key={d} {...dropProps(cellKey, d, null, p.id)}
                      onClick={(e) => { e.stopPropagation(); if (canManage) setPicker(picker === cellKey ? null : cellKey); }}
                      className={`relative flex min-h-14 flex-col gap-1 border-r p-1.5 last:border-r-0 ${canManage ? 'cursor-pointer hover:bg-muted/40' : ''} ${dropCell === cellKey ? 'bg-emerald-50 outline-2 outline-dashed outline-emerald-400 -outline-offset-4' : ''}`}>
                      {list.map((s) => <Chip key={s.id} shift={s} mode="person" ctx={ctx} />)}
                      {!list.length && canManage && <span className="m-auto text-base text-muted-foreground/40">+</span>}
                      {picker === cellKey && (
                        <div className="absolute inset-x-1 top-1 z-20 rounded-lg border bg-background p-1 shadow-xl" onClick={(e) => e.stopPropagation()}>
                          {types.map((t) => (
                            <button key={t.id} type="button" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted"
                              onClick={() => { setPicker(null); void place(p.id, d, t.id); }}>{t.label} {t.start_time}–{t.end_time}</button>
                          ))}
                          <button type="button" className="block w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted" onClick={() => setPicker(null)}>Cancel</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            <div className="grid grid-cols-[150px_repeat(7,minmax(115px,1fr))] bg-muted/40 text-[11px] text-muted-foreground">
              <div className="border-r px-2.5 py-1.5">On shift</div>
              {weekDays.map((d) => <div key={d} className="border-r py-1.5 text-center last:border-r-0"><b className="text-foreground">{shifts.filter((s) => s.work_date === d).length}</b> people</div>)}
            </div>
          </div>
        </div>
      )}

      {view === 'day' && (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {types.map((t) => (
            <div key={t.id} className="overflow-hidden rounded-xl border">
              <div className="border-b bg-muted/30 px-2.5 py-2"><b className="text-sm">{t.label}</b> <span className="text-xs text-muted-foreground">{t.start_time}–{t.end_time}</span></div>
              <ShiftCell workDate={anchor} type={t} tall ctx={ctx} />
            </div>
          ))}
        </div>
      )}

      {view === 'month' && (
        <div className="overflow-x-auto rounded-xl border">
          <div className="grid min-w-[700px] grid-cols-7">
            {Array.from({ length: 42 }, (_, i) => addDays(range.from, i)).map((d) => {
              const list = shifts.filter((s) => s.work_date === d);
              const other = d.slice(0, 7) !== anchor.slice(0, 7);
              return (
                <button key={d} type="button" onClick={() => { setAnchor(d); setView('day'); }}
                  className={`min-h-20 border-b border-r p-1.5 text-left text-xs ${other ? 'bg-muted/30 text-muted-foreground/60' : ''} ${d === today ? 'bg-emerald-50' : ''}`}>
                  <b>{dayLabel(d, { day: 'numeric' })}</b>
                  {list.length > 0 && <div className="text-[11px] text-muted-foreground">{list.length} on shift</div>}
                  <div className="mt-1 flex flex-wrap gap-0.5">{list.map((s) => <i key={s.id} title={s.staff_name} className={`inline-block size-2 rounded-full ${DOTS[colorIndex.get(s.staff_id) ?? 0]}`} />)}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Dashed = draft (managers only). Solid ✓ = published. Moving or changing a published shift makes it a draft again until you publish.
        Planned shifts only — clock-in and hours come later.
      </p>
    </div>
  );
}

function Chip({ shift, mode, ctx }: { shift: Shift; mode: Layout; ctx: Ctx }) {
const { canManage, busy, selected, openChip, setOpenChip, timezone, types, colorIndex, update, jobs } = ctx;
  const type = types.find((t) => t.id === shift.shift_type_id);
  const start = localTime(shift.starts_at, timezone);
  const end = localTime(shift.ends_at, timezone);
  const custom = !type || type.start_time !== start || type.end_time !== end;
  const open = openChip === shift.id;
  const [times, setTimes] = useState({ start, end });
  return (
    <div draggable={canManage} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', `shift:${shift.id}`); }}
      onClick={(e) => { e.stopPropagation(); if (!selected) setOpenChip(open ? null : shift.id); }}
      className={`rounded-md border px-1.5 py-1 text-xs ${COLORS[colorIndex.get(shift.staff_id) ?? 0]} ${shift.status === 'draft' ? 'border-dashed' : ''} ${canManage ? 'cursor-grab' : ''}`}>
      <div className="flex items-center gap-1.5">
        <span className="font-semibold">{mode === 'person' ? (type?.label ?? 'Shift') : shift.staff_name}</span>
        <span className="opacity-70">{mode === 'person' || custom ? `${start}–${end}` : (jobs.get(shift.staff_id) ?? roleLabel(shift.role)).charAt(0)}</span>
        <span className="ml-auto rounded border border-current bg-white/70 px-1 text-[9px]">{shift.status === 'draft' ? 'draft' : '✓'}</span>
      </div>
      {open && canManage && (
        <div className="mt-1.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-[auto_1fr] items-center gap-1">
            <span className="text-[10px]">From</span>
            <input type="time" value={times.start} onChange={(e) => setTimes({ ...times, start: e.target.value })} className="min-w-0 rounded border bg-white px-1 py-0.5" aria-label="Start time" />
            <span className="text-[10px]">To</span>
            <input type="time" value={times.end} onChange={(e) => setTimes({ ...times, end: e.target.value })} className="min-w-0 rounded border bg-white px-1 py-0.5" aria-label="End time" />
          </div>
          <div className="flex flex-wrap gap-1">
            <button type="button" disabled={busy} className="rounded border bg-white px-1.5 py-0.5" onClick={() => void update(shift, { start_time: times.start, end_time: times.end }, 'Times changed')}>Save times</button>
            {shift.status === 'draft' && <button type="button" disabled={busy} className="rounded border bg-white px-1.5 py-0.5" onClick={() => void update(shift, { status: 'published' }, 'Published')}>Publish</button>}
            <button type="button" disabled={busy} className="rounded border bg-white px-1.5 py-0.5 text-red-700" onClick={() => void update(shift, { status: 'cancelled' }, 'Removed')}>Remove</button>
          </div>
        </div>
      )}
    </div>
  );
}

function roleSummary(list: Shift[], jobs: Map<string, string>): string {
  const counts = new Map<string, number>();
  list.forEach((s) => { const job = jobs.get(s.staff_id) ?? roleLabel(s.role); counts.set(job, (counts.get(job) ?? 0) + 1); });
  return Array.from(counts.entries()).map(([role, n]) => `${n} ${role.toLowerCase()}`).join(' · ');
}

function ShiftCell({ workDate, type, tall, ctx }: { workDate: string; type: ShiftType; tall?: boolean; ctx: Ctx }) {
const { canManage, selected, shifts, colorIndex, dropCell, place, dropProps, jobs } = ctx;
  const cellKey = `${workDate}|${type.id}`;
  const list = shifts.filter((s) => s.work_date === workDate && s.shift_type_id === type.id)
    .sort((a, b) => (colorIndex.get(a.staff_id) ?? 0) - (colorIndex.get(b.staff_id) ?? 0));
  return (
    <div {...dropProps(cellKey, workDate, type.id)}
      onClick={() => { if (selected && canManage) void place(selected, workDate, type.id); }}
      className={`flex flex-col gap-1 p-1.5 ${tall ? 'min-h-44' : 'min-h-24'} ${dropCell === cellKey ? 'bg-emerald-50 outline-2 outline-dashed outline-emerald-400 -outline-offset-4' : ''} ${selected ? 'cursor-copy hover:bg-emerald-50/60' : ''}`}>
      {list.length > 0 && (
        <div className="text-[10px] leading-tight text-muted-foreground"><b className="text-foreground">{list.length} on</b> · {roleSummary(list, jobs)}</div>
      )}
      {list.map((s) => <Chip key={s.id} shift={s} mode="shift" ctx={ctx} />)}
      {!list.length && <span className="m-auto text-[11px] text-muted-foreground/50">{canManage ? 'Drop staff here' : '—'}</span>}
    </div>
  );
}


function ShiftTimesMenu({ types, onSaved }: { types: ShiftType[]; onSaved: () => Promise<void> }) {
  const [edits, setEdits] = useState<Record<string, { start_time: string; end_time: string }>>(
    () => Object.fromEntries(types.map((t) => [t.id, { start_time: t.start_time, end_time: t.end_time }])),
  );
  const save = async (id: string) => {
    try {
      await api.put(`/schedule/shift-types/${id}`, edits[id]);
      toast.success('Shift times saved');
      await onSaved();
    } catch (error) { toast.error(errorText(error, 'Could not save the shift times')); }
  };
  return (
    <div className="absolute right-0 z-30 mt-1 w-72 space-y-1.5 rounded-lg border bg-background p-2.5 shadow-xl">
      {types.map((t) => (
        <div key={t.id} className="flex items-center gap-1.5 text-sm">
          <b className="w-16">{t.label}</b>
          <input type="time" value={edits[t.id]?.start_time ?? ''} aria-label={`${t.label} start`} className="w-[5.5rem] rounded border px-1 py-0.5"
            onChange={(e) => setEdits({ ...edits, [t.id]: { ...edits[t.id], start_time: e.target.value } })} />
          <input type="time" value={edits[t.id]?.end_time ?? ''} aria-label={`${t.label} end`} className="w-[5.5rem] rounded border px-1 py-0.5"
            onChange={(e) => setEdits({ ...edits, [t.id]: { ...edits[t.id], end_time: e.target.value } })} />
          <button type="button" className="rounded border px-1.5 py-0.5 text-xs" onClick={() => void save(t.id)}>Save</button>
        </div>
      ))}
      <p className="pt-1 text-[11px] text-muted-foreground">New shifts use these times. Existing shifts keep their times.</p>
    </div>
  );
}

function TargetsMenu({ staff, onSaved }: { staff: StaffMember[]; onSaved: () => Promise<void> }) {
  const [labels, setLabels] = useState<Record<string, string>>(() => Object.fromEntries(staff.map((p) => [p.id, p.job_label ?? ''])));
  const save = async (fn: () => Promise<unknown>, message?: string) => {
    try {
      await fn();
      if (message) toast.success(message);
      await onSaved();
    } catch (error) { toast.error(errorText(error, 'Could not save')); }
  };
  return (
    <div className="absolute right-0 z-30 mt-1 max-h-96 w-[22rem] overflow-y-auto rounded-lg border bg-background p-2.5 shadow-xl">
      <p className="mb-1.5 text-[11px] text-muted-foreground">Days a week each person should work, and the job shown on the schedule.</p>
      {staff.map((p) => (
        <div key={p.id} className="flex items-center gap-1.5 py-0.5 text-sm">
          <span className="w-20 truncate" title={p.name}>{p.name}</span>
          <input value={labels[p.id] ?? ''} placeholder={roleLabel(p.role)} maxLength={30} aria-label={`${p.name} job`}
            onChange={(e) => setLabels({ ...labels, [p.id]: e.target.value })}
            onBlur={() => { if ((labels[p.id] ?? '') !== (p.job_label ?? '')) void save(() => api.put(`/schedule/people/${p.id}`, { job_label: labels[p.id] || null })); }}
            className="w-24 min-w-0 rounded border px-1.5 py-0.5" />
          <select className="rounded border px-1 py-0.5 text-sm" value={p.target_days_per_week ?? ''} aria-label={`${p.name} days per week`}
            onChange={(e) => void save(() => api.put(`/schedule/targets/${p.id}`, { target_days_per_week: e.target.value === '' ? null : Number(e.target.value) }))}>
            <option value="">–</option>
            {Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>{i} days</option>)}
          </select>
          {p.schedule_only === 1 && (
            <button type="button" className="ml-auto text-xs text-red-700 underline" title="Remove from the schedule staff list"
              onClick={() => void save(() => api.put(`/schedule/people/${p.id}`, { active: false }), `${p.name} removed`)}>Remove</button>
          )}
        </div>
      ))}
    </div>
  );
}

function AddPerson({ onAdded }: { onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', job: '' });
  const add = async () => {
    try {
      await api.post('/schedule/people', { name: form.name, job_label: form.job || null });
      toast.success(`${form.name} added — no POS login`);
      setForm({ name: '', job: '' });
      setOpen(false);
      await onAdded();
    } catch (error) { toast.error(errorText(error, 'Could not add the person')); }
  };
  if (!open) {
    return (
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="rounded-lg border border-dashed px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted">
        <span className="block font-semibold">+ Add person</span><span className="text-[11px]">schedule only, no login</span>
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed p-1.5" onClick={(e) => e.stopPropagation()}>
      <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" maxLength={60}
        className="w-28 rounded border px-2 py-1 text-sm" aria-label="New person name" />
      <input value={form.job} onChange={(e) => setForm({ ...form, job: e.target.value })} placeholder="Job (e.g. Security)" maxLength={30}
        className="w-36 rounded border px-2 py-1 text-sm" aria-label="New person job" />
      <button type="button" disabled={!form.name.trim()} onClick={() => void add()} className="rounded bg-emerald-600 px-2.5 py-1 text-sm font-semibold text-white disabled:opacity-50">Add</button>
      <button type="button" onClick={() => setOpen(false)} className="px-1.5 text-sm text-muted-foreground">Cancel</button>
    </div>
  );
}
