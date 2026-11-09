'use client';

import { Delete } from 'lucide-react';

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

interface Props {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}

const keyClass = 'flex h-12 min-w-0 flex-1 items-center justify-center rounded-lg border border-[#1e293b] bg-[#182234] text-base font-semibold uppercase text-slate-100 active:scale-95 active:bg-blue-600 select-none touch-manipulation';

export default function OnScreenKeyboard({ value, onChange, onClose }: Props) {
  // Keys must not take focus from the search input.
  const press = (action: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
    onClick: action,
  });

  return (
    <div role="group" aria-label="On-screen keyboard" className="shrink-0 space-y-1.5 border-t border-[#1e293b] bg-[#0f1729] p-2">
      {ROWS.map((row, index) => (
        <div key={index} className="flex gap-1.5" style={{ paddingInline: index === 2 ? '4%' : index === 3 ? '10%' : 0 }}>
          {row.map(key => (
            <button key={key} type="button" className={keyClass} {...press(() => onChange(value + key))}>{key}</button>
          ))}
          {index === 3 && (
            <button type="button" aria-label="Backspace" className={`${keyClass} flex-[1.5]`} {...press(() => onChange(value.slice(0, -1)))}><Delete size={20} /></button>
          )}
        </div>
      ))}
      <div className="flex gap-1.5">
        <button type="button" className={`${keyClass} flex-[1.5] normal-case`} {...press(() => onChange(''))}>Clear</button>
        <button type="button" className={`${keyClass} flex-[5] normal-case`} {...press(() => onChange(value + ' '))}>Space</button>
        <button type="button" className={`${keyClass} flex-[1.5] !bg-blue-600 normal-case`} {...press(onClose)}>Done</button>
      </div>
    </div>
  );
}
