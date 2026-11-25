'use client';

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, Pencil, Plus } from 'lucide-react';
import api from '@/lib/api';
import type { Category, Product } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

const NO_CATEGORY = '__none__';

function errorText(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error || fallback;
}

export default function OrganizeMenu({ categories, products, onChanged }: {
  categories: Category[];
  products: Product[];
  onChanged: () => Promise<void> | void;
}) {
  const fmt = useFormatCurrency();
  const byId = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories]);
  const ordered = useMemo(() => [...categories].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)), [categories]);
  const roots = ordered.filter(c => !c.parent_id || !byId.has(c.parent_id));
  const childrenOf = (id: string) => ordered.filter(c => c.parent_id === id);
  const directCount = (id: string) => products.filter(p => String(p.category_id ?? '') === id).length;
  const totalCount = (id: string) => directCount(id) + childrenOf(id).reduce((sum, child) => sum + directCount(child.id), 0);
  const uncategorized = products.filter(p => !p.category_id || !byId.has(String(p.category_id)));
  const pathOf = (c: Category) => (c.parent_id && byId.get(c.parent_id) ? `${byId.get(c.parent_id)!.name} › ${c.name}` : c.name);

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selectedCat, setSelectedCat] = useState<string>(() => roots[0]?.id ?? NO_CATEGORY);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const current = selectedCat === NO_CATEGORY ? null : byId.get(selectedCat) ?? null;
  const items = (current ? products.filter(p => String(p.category_id ?? '') === current.id) : uncategorized)
    .slice().sort((a, b) => a.name.localeCompare(b.name));
  const moveTargets = ordered.filter(c => c.is_active && c.id !== current?.id)
    .map(c => ({ id: c.id, label: pathOf(c) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const pick = (id: string) => { setSelectedCat(id); setChecked(new Set()); setTarget(''); setRenaming(null); };
  const refresh = async () => { await onChanged(); };

  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    try { await work(); await refresh(); } catch (error) { toast.error(errorText(error, fallback)); } finally { setBusy(false); }
  };

  const moveChecked = () => run(async () => {
    const ids = [...checked];
    let moved = 0;
    for (const id of ids) {
      await api.put(`/products/${id}`, { category_id: target });
      moved += 1;
    }
    toast.success(`${moved} item${moved === 1 ? '' : 's'} moved to ${pathOf(byId.get(target)!)}`);
    setChecked(new Set());
    setTarget('');
  }, 'Some items could not be moved. Refresh and check.');

  const saveName = (cat: Category) => run(async () => {
    const name = nameDraft.trim();
    if (!name || name === cat.name) { setRenaming(null); return; }
    await api.put(`/categories/${cat.id}`, { name });
    toast.success(`Renamed to ${name}`);
    setRenaming(null);
  }, 'Could not rename');

  const toggleHidden = (cat: Category) => {
    if (cat.is_active && (totalCount(cat.id) > 0 || childrenOf(cat.id).some(c => c.is_active))) {
      toast.error('Move its items and subcategories out first, then hide it');
      return;
    }
    void run(async () => {
      await api.put(`/categories/${cat.id}`, { is_active: !cat.is_active });
      toast.success(cat.is_active ? `${cat.name} hidden` : `${cat.name} shown again`);
    }, 'Could not change');
  };

  const setColour = (cat: Category, color: string) => run(async () => {
    await api.put(`/categories/${cat.id}`, { color });
  }, 'Could not change colour');

  const addSub = (parent: Category | null) => run(async () => {
    const name = newName.trim();
    if (!name) return;
    const lastOrder = ordered.reduce((max, c) => Math.max(max, c.sort_order), 0);
    await api.post('/categories', { name, parent_id: parent?.id ?? null, is_active: true, sort_order: lastOrder + 1 });
    toast.success(parent ? `${parent.name} › ${name} added` : `${name} added`);
    setNewName('');
    setAddingUnder(null);
    if (parent) setOpen(o => ({ ...o, [parent.id]: true }));
  }, 'Could not add');

  const shift = (cat: Category, direction: -1 | 1) => {
    const siblings = ordered.filter(c => (c.parent_id && byId.has(c.parent_id) ? c.parent_id : null) === (cat.parent_id && byId.has(cat.parent_id) ? cat.parent_id : null));
    const index = siblings.findIndex(c => c.id === cat.id);
    const other = siblings[index + direction];
    if (!other) return;
    const ids = ordered.map(c => c.id);
    const a = ids.indexOf(cat.id);
    const b = ids.indexOf(other.id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    void run(async () => { await api.put('/categories/reorder', { ids }); }, 'Could not change order');
  };

  const rowClass = (active: boolean, selected: boolean) =>
    `flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-sm ${selected ? 'bg-brand/15 text-brand font-semibold' : 'hover:bg-muted'} ${active ? '' : 'text-muted-foreground'}`;

  const orderButtons = (cat: Category) => (
    <span className="ms-auto flex shrink-0 items-center">
      <span className="me-1 text-xs text-muted-foreground tabular-nums">{cat.parent_id ? directCount(cat.id) : totalCount(cat.id)}</span>
      <button type="button" aria-label={`Move ${cat.name} up`} disabled={busy} onClick={(e) => { e.stopPropagation(); shift(cat, -1); }} className="rounded p-1 hover:bg-muted"><ArrowUp size={14} /></button>
      <button type="button" aria-label={`Move ${cat.name} down`} disabled={busy} onClick={(e) => { e.stopPropagation(); shift(cat, 1); }} className="rounded p-1 hover:bg-muted"><ArrowDown size={14} /></button>
    </span>
  );

  const addRow = (parent: Category | null) => addingUnder === (parent?.id ?? NO_CATEGORY) ? (
    <form className={`flex items-center gap-1 py-1 ${parent ? 'ps-7' : ''}`} onSubmit={(e) => { e.preventDefault(); void addSub(parent); }}>
      <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={parent ? 'New subcategory' : 'New category'} aria-label={parent ? `New subcategory under ${parent.name}` : 'New category name'}
        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
      <Button type="submit" size="sm" disabled={busy || !newName.trim()}>Add</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => { setAddingUnder(null); setNewName(''); }}>Cancel</Button>
    </form>
  ) : (
    <button type="button" onClick={() => { setAddingUnder(parent?.id ?? NO_CATEGORY); setNewName(''); }}
      className={`flex items-center gap-1.5 py-1.5 text-sm text-brand hover:underline ${parent ? 'ps-7' : ''}`}>
      <Plus size={14} /> {parent ? 'Add subcategory' : 'Add category'}
    </button>
  );

  return (
    <div data-testid="organize-menu" className="grid gap-4 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <div className="rounded-xl border border-border bg-card p-3 text-foreground">
        <p className="mb-2 text-sm font-semibold">Categories</p>
        {roots.map(cat => {
          const kids = childrenOf(cat.id);
          const expanded = open[cat.id] ?? cat.id === current?.parent_id;
          return (
            <div key={cat.id}>
              <div className={rowClass(cat.is_active, selectedCat === cat.id)}>
                <button type="button" aria-label={expanded ? `Close ${cat.name}` : `Open ${cat.name}`} onClick={() => setOpen(o => ({ ...o, [cat.id]: !expanded }))} className="rounded p-0.5 hover:bg-muted">
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: cat.color || '#888780' }} />
                <button type="button" onClick={() => { pick(cat.id); setOpen(o => ({ ...o, [cat.id]: true })); }} className="min-w-0 flex-1 truncate text-start">
                  {cat.name}{!cat.is_active && ' (hidden)'}
                </button>
                {orderButtons(cat)}
              </div>
              {expanded && (
                <div>
                  {kids.map(kid => (
                    <div key={kid.id} className={`${rowClass(kid.is_active, selectedCat === kid.id)} ps-7`}>
                      {!kid.is_active && <EyeOff size={13} className="shrink-0" />}
                      <button type="button" onClick={() => pick(kid.id)} className="min-w-0 flex-1 truncate text-start">
                        {kid.name}{!kid.is_active && ' (hidden)'}
                      </button>
                      {orderButtons(kid)}
                    </div>
                  ))}
                  {addRow(cat)}
                </div>
              )}
            </div>
          );
        })}
        {uncategorized.length > 0 && (
          <button type="button" onClick={() => pick(NO_CATEGORY)} className={rowClass(true, selectedCat === NO_CATEGORY)}>
            <span className="min-w-0 flex-1 truncate">No category</span>
            <span className="text-xs text-muted-foreground">{uncategorized.length}</span>
          </button>
        )}
        <div className="mt-2 border-t border-border pt-1">{addRow(null)}</div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-foreground">
        <div className="flex flex-wrap items-center gap-2">
          {current && renaming === current.id ? (
            <form className="flex flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); void saveName(current); }}>
              <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} aria-label="New name"
                className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-base font-semibold" />
              <Button type="submit" size="sm" disabled={busy}>Save</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setRenaming(null)}>Cancel</Button>
            </form>
          ) : (
            <h2 className="me-auto text-lg font-semibold">{current ? pathOf(current) : 'No category'}{current && !current.is_active ? ' (hidden)' : ''}</h2>
          )}
          {current && renaming !== current.id && (
            <>
              <Button size="sm" variant="outline" onClick={() => { setRenaming(current.id); setNameDraft(current.name); }}><Pencil size={14} /> Rename</Button>
              <Button size="sm" variant="outline" onClick={() => toggleHidden(current)} disabled={busy}>
                {current.is_active ? <><EyeOff size={14} /> Hide</> : <><Eye size={14} /> Show</>}
              </Button>
              <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <span className="size-4 rounded-full border border-border" style={{ backgroundColor: current.color || '#888780' }} />
                Colour
                <input type="color" className="sr-only" value={current.color || '#888780'} onChange={(e) => void setColour(current, e.target.value)} />
              </label>
            </>
          )}
        </div>

        {current && !current.parent_id && childrenOf(current.id).length > 0 && (
          <p className="text-sm text-muted-foreground">Items placed directly in {current.name}, not in a subcategory. Open a subcategory on the left to see its items.</p>
        )}

        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-2">
            <label className="flex items-center gap-2 px-1 text-sm">
              <input type="checkbox" aria-label="Select all items" checked={checked.size === items.length}
                onChange={(e) => setChecked(e.target.checked ? new Set(items.map(p => p.id)) : new Set())} />
              {checked.size > 0 ? `${checked.size} selected` : 'Select all'}
            </label>
            <span className="ms-auto flex flex-wrap items-center gap-2">
              <select aria-label="Move selected items to" value={target} onChange={(e) => setTarget(e.target.value)} disabled={checked.size === 0}
                className="max-w-64 rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
                <option value="">Move to…</option>
                {moveTargets.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <Button size="sm" onClick={() => void moveChecked()} disabled={busy || checked.size === 0 || !target}><ArrowRight size={14} /> Move</Button>
            </span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No items here</p>}
          {items.map(p => (
            <label key={p.id} data-testid="organize-item" className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-sm hover:bg-muted/50">
              <input type="checkbox" aria-label={`Select ${p.name}`} checked={checked.has(p.id)}
                onChange={(e) => setChecked(s => { const next = new Set(s); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next; })} />
              <span className={`min-w-0 flex-1 truncate ${p.is_active ? '' : 'text-muted-foreground line-through'}`}>{p.name}</span>
              <span className="shrink-0 tabular-nums">{fmt(Number(p.price))}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
