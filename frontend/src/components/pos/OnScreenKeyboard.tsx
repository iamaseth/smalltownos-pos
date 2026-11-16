'use client';

import { useEffect, useRef, useState } from 'react';
import { Delete, GripHorizontal, X } from 'lucide-react';

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];
const POSITION_KEY = 'pos-keyboard-position';
const WIDTH = 340;
const MARGIN = 8;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}

type Position = { x: number; y: number };

const keyClass = 'flex h-9 min-w-0 flex-1 items-center justify-center rounded-md border border-[#1e293b] bg-[#182234] text-sm font-semibold uppercase text-slate-100 active:scale-95 active:bg-blue-600 select-none touch-manipulation';

function clamp(pos: Position, height: number): Position {
  const maxX = Math.max(MARGIN, window.innerWidth - WIDTH - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN);
  return { x: Math.min(Math.max(MARGIN, pos.x), maxX), y: Math.min(Math.max(MARGIN, pos.y), maxY) };
}

export default function OnScreenKeyboard({ value, onChange, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const height = panelRef.current?.offsetHeight ?? 260;
      let saved: Position | null = null;
      try {
        const raw = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
        if (raw && typeof raw.x === 'number' && typeof raw.y === 'number') saved = raw;
      } catch {}
      setPosition(clamp(saved ?? { x: window.innerWidth - WIDTH - 340, y: window.innerHeight - height - 24 }, height));
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const height = panelRef.current?.offsetHeight ?? 260;
    setPosition(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }, height));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    try { if (position) localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch {}
  };

  // Keys must not take focus from the search input.
  const press = (action: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
    onClick: action,
  });

  return (
    <div ref={panelRef} role="group" aria-label="On-screen keyboard"
      style={{ width: WIDTH, left: position?.x ?? MARGIN, top: position?.y ?? MARGIN, visibility: position ? 'visible' : 'hidden' }}
      className="fixed z-50 space-y-1 rounded-xl border border-[#334155] bg-[#0f1729] p-1.5 shadow-2xl shadow-black/60">
      <div className="flex items-center justify-between">
        <div onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
          aria-label="Drag to move keyboard" className="flex h-7 flex-1 cursor-grab touch-none items-center justify-center text-slate-500 active:cursor-grabbing"><GripHorizontal size={18} /></div>
        <button type="button" aria-label="Close keyboard" className="flex h-7 w-8 items-center justify-center rounded-md text-slate-400 hover:text-white" {...press(onClose)}><X size={16} /></button>
      </div>
      {ROWS.map((row, index) => (
        <div key={index} className="flex gap-1" style={{ paddingInline: index === 2 ? '4%' : index === 3 ? '8%' : 0 }}>
          {row.map(key => (
            <button key={key} type="button" className={keyClass} {...press(() => onChange(value + key))}>{key}</button>
          ))}
          {index === 3 && (
            <button type="button" aria-label="Backspace" className={`${keyClass} flex-[1.5]`} {...press(() => onChange(value.slice(0, -1)))}><Delete size={16} /></button>
          )}
        </div>
      ))}
      <div className="flex gap-1">
        <button type="button" className={`${keyClass} flex-[1.5] normal-case`} {...press(() => onChange(''))}>Clear</button>
        <button type="button" className={`${keyClass} flex-[4] normal-case`} {...press(() => onChange(value + ' '))}>Space</button>
        <button type="button" className={`${keyClass} flex-[1.5] !bg-blue-600 normal-case`} {...press(onClose)}>Done</button>
      </div>
    </div>
  );
}
