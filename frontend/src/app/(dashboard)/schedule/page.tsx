'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Copy, LoaderCircle, Send, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import api from '@/lib/api';
import { tenantCan } from '@/lib/permissions';
import { useAuthStore } from '@/store/auth';
import type { Staff } from '@/lib/types';

type ShiftStatus = 'draft' | 'published' | 'cancelled';
type ScheduledShift = {
  id: string;
  staff_id: string;
  staff_name: string;
  role: string;
  starts_at: string;
  ends_at: string;
  status: ShiftStatus;
};
type ShiftPreset = { id: string; label: string; start: string; end: string };

const PRESETS: ShiftPreset[] = [
  { id: 'opening', label: 'Opening', start: '14:00', end: '20:00' },
  { id: 'main', label: 'Main', start: '16:00', end: '23:00' },
  { id: 'closing', label: 'Closing', start: '18:00', end: '01:00' },
  { id: 'full', label: 'Full', start: '14:00', end: '01:00' },
];
function mondayOf(date: Date): Date {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function addDays(date: Date, count: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + count);
  return result;
}

function localIso(date: Date, time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0);
  return result.toISOString();
}

function weekLabel(start: Date, end: Date): string {
  const first = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const last = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${first} – ${last}`;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function StaffSchedulePage() {
  const { currentTenant } = useAuthStore();
  const canManage = tenantCan(currentTenant, 'staff.operational.manage');
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [staff, setStaff] = useState<Staff[]>([]);
  const [shifts, setShifts] = useState<ScheduledShift[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);
  const range = useMemo(() => ({ from: weekStart.toISOString(), to: weekEnd.toISOString() }), [weekStart, weekEnd]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [staffResponse, shiftResponse] = await Promise.all([
        api.get('/staff?active=true'),
        api.get('/schedule', { params: range }),
      ]);
      setStaff((staffResponse.data.staff || []).filter((member: Staff) => member.is_active));
      setShifts(shiftResponse.data.shifts || []);
    } catch {
      toast.error('Could not load the staff schedule');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  const shiftsFor = (day: Date, preset: ShiftPreset) => shifts.filter((shift) => {
    const endDay = preset.end <= preset.start ? addDays(day, 1) : day;
    return shift.starts_at === localIso(day, preset.start) && shift.ends_at === localIso(endDay, preset.end);
  });

  async function addShift(day: Date, preset: ShiftPreset) {
    const cell = `${dateKey(day)}-${preset.id}`;
    const staffId = selectedStaff[cell];
    if (!staffId) { toast.error('Choose a staff member first'); return; }
    let endDay = day;
    if (preset.end <= preset.start) endDay = addDays(day, 1);
    setSaving(true);
    try {
      await api.post('/schedule', {
        staff_id: staffId,
        starts_at: localIso(day, preset.start),
        ends_at: localIso(endDay, preset.end),
      });
      toast.success('Shift added as a draft');
      setSelectedStaff((current) => ({ ...current, [cell]: '' }));
      await load();
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Could not add this shift');
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(shift: ScheduledShift, status: ShiftStatus) {
    setSaving(true);
    try {
      await api.patch(`/schedule/${shift.id}`, { status });
      await load();
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Could not update this shift');
    } finally {
      setSaving(false);
    }
  }

  async function copyPreviousWeek() {
    setSaving(true);
    try {
      const response = await api.post('/schedule/copy-week', { week_start: weekStart.toISOString() });
      const { copied = 0, skipped = 0 } = response.data;
      toast.success(`Copied ${copied} shifts as drafts${skipped ? `; skipped ${skipped} overlapping` : ''}`);
      await load();
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Could not copy last week');
    } finally {
      setSaving(false);
    }
  }

  const activeShifts = shifts.filter((shift) => shift.status !== 'cancelled');

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><CalendarDays className="size-6" /> Staff schedule</h1>
          <p className="mt-1 text-sm text-muted-foreground">Plan expected shifts for the team. Scheduling does not record clock-in or attendance.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" aria-label="Previous week" onClick={() => setWeekStart((date) => addDays(date, -7))}><ChevronLeft className="size-4" /></Button>
            <Button size="sm" variant="outline" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</Button>
            <Button size="sm" variant="outline" aria-label="Next week" onClick={() => setWeekStart((date) => addDays(date, 7))}><ChevronRight className="size-4" /></Button>
          </div>
          <span className="min-w-36 text-sm font-semibold">{weekLabel(weekStart, addDays(weekEnd, -1))}</span>
          {canManage && <Button size="sm" variant="outline" disabled={saving} onClick={() => void copyPreviousWeek()}><Copy className="mr-1 size-4" /> Copy last week</Button>}
        </div>
      </header>

      <div className="flex flex-wrap gap-2 text-sm">
        <span className="rounded-full border px-3 py-1">{activeShifts.length} scheduled shifts</span>
        <span className="rounded-full border px-3 py-1">{staff.length} active staff</span>
        {!canManage && <span className="rounded-full border px-3 py-1 text-muted-foreground">View only</span>}
      </div>

      {loading ? (
        <div className="flex min-h-56 items-center justify-center text-muted-foreground"><LoaderCircle className="mr-2 size-5 animate-spin" /> Loading schedule</div>
      ) : (
        <Card className="overflow-x-auto p-0">
          <div className="min-w-[1040px]">
            <div className="grid grid-cols-[140px_repeat(7,minmax(128px,1fr))] border-b bg-muted/40">
              <div className="border-r p-3 text-sm font-semibold">Shift</div>
              {weekDays.map((day) => <div key={day.toISOString()} className="border-r p-2 text-center last:border-r-0">
                <div className="text-xs text-muted-foreground">{day.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                <div className="font-bold">{day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
              </div>)}
            </div>
            {PRESETS.map((preset) => <div key={preset.id} className="grid grid-cols-[140px_repeat(7,minmax(128px,1fr))] border-b last:border-b-0">
              <div className="border-r bg-muted/20 p-3"><div className="text-sm font-semibold">{preset.label}</div><div className="text-xs text-muted-foreground">{preset.start}–{preset.end}</div></div>
              {weekDays.map((day) => {
                const cell = `${dateKey(day)}-${preset.id}`;
                const cellShifts = shiftsFor(day, preset);
                return <div key={cell} className="min-h-32 space-y-2 border-r p-2 last:border-r-0">
                  {cellShifts.map((shift) => <div key={shift.id} className={`rounded-md border p-2 ${shift.status === 'cancelled' ? 'opacity-50' : 'bg-card'}`}>
                    <div className="truncate text-sm font-semibold">{shift.staff_name}</div>
                    <div className="text-xs text-muted-foreground">{shift.role} · {timeLabel(shift.starts_at)}–{timeLabel(shift.ends_at)}</div>
                    <div className="mt-1 flex items-center justify-between gap-1">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${shift.status === 'published' ? 'bg-green-100 text-green-800' : shift.status === 'cancelled' ? 'bg-muted text-muted-foreground' : 'bg-amber-100 text-amber-800'}`}>{shift.status}</span>
                      {canManage && shift.status !== 'cancelled' && <div className="flex gap-1">
                        {shift.status === 'draft' && <Button size="icon" variant="ghost" className="size-7" title="Publish shift" disabled={saving} onClick={() => void updateStatus(shift, 'published')}><Send className="size-3.5" /></Button>}
                        <Button size="icon" variant="ghost" className="size-7" title="Cancel shift" disabled={saving} onClick={() => void updateStatus(shift, 'cancelled')}><XCircle className="size-3.5" /></Button>
                      </div>}
                    </div>
                  </div>)}
                  {canManage && <div className="flex gap-1">
                    <select className="min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" aria-label={`Staff for ${preset.label} ${day.toDateString()}`} value={selectedStaff[cell] || ''} onChange={(event) => setSelectedStaff((current) => ({ ...current, [cell]: event.target.value }))}>
                      <option value="">Add staff…</option>
                      {staff.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.role}</option>)}
                    </select>
                    <Button size="sm" className="px-2" disabled={saving || !selectedStaff[cell]} aria-label={`Add shift for ${preset.label} ${day.toDateString()}`} onClick={() => void addShift(day, preset)}>+</Button>
                  </div>}
                  {!cellShifts.length && !canManage && <div className="pt-2 text-center text-xs text-muted-foreground">No shifts</div>}
                </div>;
              })}
            </div>)}
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">Managers can edit draft shifts. Publishing marks a planned shift as official; clock-in, attendance, and payroll hours are not included.</p>
    </div>
  );
}
