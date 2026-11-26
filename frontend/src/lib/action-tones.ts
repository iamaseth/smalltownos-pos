import type { CSSProperties } from 'react';

/**
 * Button colours for POS actions: the same colour for the same action on every screen.
 * Kept in its own small file so any screen can use them without loading the floor plan.
 */
export type ActionTone = 'move' | 'change' | 'discount' | 'add' | 'note' | 'free' | 'rush' | 'print' | 'remove';

const TONES: Record<ActionTone, { bg: string; border: string; text: string }> = {
  move: { bg: '#0C447C', border: '#378ADD', text: '#ffffff' },
  change: { bg: '#0C447C', border: '#378ADD', text: '#ffffff' },
  discount: { bg: '#3C3489', border: '#7F77DD', text: '#ffffff' },
  add: { bg: '#085041', border: '#1D9E75', text: '#ffffff' },
  note: { bg: '#633806', border: '#EF9F27', text: '#ffffff' },
  free: { bg: '#72243E', border: '#D4537E', text: '#ffffff' },
  rush: { bg: '#712B13', border: '#D85A30', text: '#ffffff' },
  print: { bg: '#444441', border: '#888780', text: '#ffffff' },
  remove: { bg: '#501313', border: '#E24B4A', text: '#F7C1C1' },
};

export function toneStyle(tone: ActionTone, enabled = true): CSSProperties | undefined {
  if (!enabled) return undefined;
  const t = TONES[tone];
  return { backgroundColor: t.bg, borderColor: t.border, color: t.text };
}
