'use client';

/**
 * BackStreet: set up the Special button on the till. Pick the category for kitchen specials and
 * the one for bar specials; tickets print where that category goes, and reports count them there.
 */
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Sparkles } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import type { SpecialItemsConfig } from '@/lib/special-items';

type CategoryOption = { id: string; name: string; parent_id?: string | null; is_active?: boolean | number };

export function SpecialItemsCard() {
  const [config, setConfig] = useState<SpecialItemsConfig | null>(null);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [kitchen, setKitchen] = useState('');
  const [bar, setBar] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([api.get<SpecialItemsConfig>('/special-items'), api.get('/categories')])
      .then(([cfg, cats]) => {
        if (!active) return;
        setConfig(cfg.data);
        setKitchen(cfg.data.kitchen?.categoryId ?? '');
        setBar(cfg.data.bar?.categoryId ?? '');
        const list = (cats.data.categories ?? cats.data ?? []) as CategoryOption[];
        setCategories(list.filter((c) => c.is_active !== false && c.is_active !== 0).sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => { if (active) setConfig(null); });
    return () => { active = false; };
  }, []);

  if (!config) return null;

  const changed = kitchen !== (config.kitchen?.categoryId ?? '') || bar !== (config.bar?.categoryId ?? '');

  const save = async () => {
    setBusy(true);
    try {
      const { data } = await api.put<SpecialItemsConfig>('/special-items', { kitchen_category_id: kitchen || null, bar_category_id: bar || null });
      setConfig({ ...data, can_add: config.can_add });
      toast.success(data.enabled ? 'Special button is on' : 'Special button is off');
    } catch (error) {
      toast.error((error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const select = (id: string, value: string, onChange: (v: string) => void, label: string) => (
    <label className="block" htmlFor={id}>
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
        <option value="">Off</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );

  return (
    <div className="bg-card rounded-xl border border-border p-6 mt-6" data-testid="special-items-card">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={20} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">Special items</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Adds a Special button on the till: the cashier types what it is and the price. Pick the category each one
        belongs to. The ticket prints where that category goes, and reports count it there. Who may add specials is
        set in Staff → permissions (orders · special item).
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {select('special-kitchen', kitchen, setKitchen, 'Kitchen specials go in')}
        {select('special-bar', bar, setBar, 'Bar specials go in')}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button type="button" size="sm" disabled={!changed || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
        <span className="text-sm text-muted-foreground">{config.enabled ? 'The Special button is on.' : 'The Special button is off.'}</span>
      </div>
    </div>
  );
}
