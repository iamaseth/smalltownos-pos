'use client';

import { Minus, Plus } from 'lucide-react';

interface Props {
  people: number;
  onPeopleChange: (people: number) => void;
  shareLabel: string;
  onFill: () => void;
}

export default function SplitEvenlyRow({ people, onPeopleChange, shareLabel, onFill }: Props) {
  const step = 'flex size-9 items-center justify-center rounded-lg border border-border hover:bg-muted';
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-muted-foreground">Split equally</p>
        <p className="truncate text-sm font-bold tabular-nums">{people} {people === 1 ? 'person' : 'people'} · {shareLabel} each</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" aria-label="Fewer people" className={step} onClick={() => onPeopleChange(Math.max(1, people - 1))}><Minus size={14} /></button>
        <button type="button" aria-label="More people" className={step} onClick={() => onPeopleChange(Math.min(20, people + 1))}><Plus size={14} /></button>
        <button type="button" onClick={onFill} className="rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:border-brand hover:text-brand">Use share</button>
      </div>
    </div>
  );
}
