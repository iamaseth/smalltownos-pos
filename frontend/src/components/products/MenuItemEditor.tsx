'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { genericMenuPhoto } from '@/lib/generic-menu-photos';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import toast from 'react-hot-toast';
import { Plus, X, Sparkles, Camera, SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useConfirm } from '@/hooks/use-confirm';
import ImageUploader from '@/components/products/ImageUploader';
import { compressImage } from '@/lib/image-utils';

export const SUPPLY_UNITS = ['each', 'g', 'kg', 'ml', 'l'] as const;
export type SupplyUnit = (typeof SUPPLY_UNITS)[number];

export interface MenuSupply {
  id: string;
  name: string;
  base_unit: SupplyUnit;
  stock_quantity: number;
  unit_cost: number | null;
  group_name: string | null;
}

export interface RecipeItem {
  group_name: string | null;
  supply_id: string;
  supply_name: string;
  base_unit: SupplyUnit;
  quantity: number;
  unit: SupplyUnit;
  quantity_in_base: number;
}

export interface Recipe {
  id: string;
  product_id: string;
  product_name: string | null;
  yield_quantity: number;
  is_active: number;
  items: RecipeItem[];
  selling_price: number | null;
  cost_per_serving: number | null;
  cost_complete: boolean;
  missing_cost_supplies: string[];
  margin: number | null;
  margin_percent: number | null;
}

export interface MenuProduct {
  id: string;
  name: string;
  price?: number;
  category_id?: string | null;
  has_image?: boolean;
  updated_at?: string;
  is_active?: number | boolean;
  sku?: string | null;
  barcode?: string | null;
  description?: string | null;
  tax_category_id?: string | null;
}

export interface MenuCategory {
  id: string;
  name: string;
}

interface DishForm {
  name: string;
  category_id: string;
  price: string;
  image: string | null;
  imageTouched: boolean;
  is_active: boolean;
  sku: string;
  barcode: string;
  description: string;
  tax_category_id: string;
}

interface LineForm {
  supply_id: string;
  group_name: string;
  quantity: string;
  unit: SupplyUnit;
}

const emptyDish: DishForm = { name: '', category_id: '', price: '', image: null, imageTouched: false, is_active: false, sku: '', barcode: '', description: '', tax_category_id: '' };

const nextSku = (products: MenuProduct[]): string | null => {
  const groups = new Map<string, { count: number; max: number; width: number }>();
  for (const p of products) {
    const m = typeof p.sku === 'string' ? p.sku.match(/^(.*?)(\d+)$/) : null;
    if (!m) continue;
    const g = groups.get(m[1]) ?? { count: 0, max: 0, width: m[2].length };
    g.count += 1;
    g.max = Math.max(g.max, Number(m[2]));
    g.width = Math.max(g.width, m[2].length);
    groups.set(m[1], g);
  }
  let best: [string, { count: number; max: number; width: number }] | null = null;
  for (const entry of groups) if (!best || entry[1].count > best[1].count) best = entry;
  return best ? `${best[0]}${String(best[1].max + 1).padStart(best[1].width, '0')}` : null;
};

const dishFromProduct = (p: MenuProduct | undefined): DishForm => (p
  ? { name: p.name, category_id: p.category_id ?? '', price: p.price === undefined ? '' : String(p.price), image: p.has_image ? 'EXISTING' : null, imageTouched: false, is_active: p.is_active === true || p.is_active === 1, sku: p.sku ?? '', barcode: p.barcode ?? '', description: p.description ?? '', tax_category_id: p.tax_category_id ?? '' }
  : emptyDish);

const toBase = (qty: number, unit: SupplyUnit, base: SupplyUnit): number | null => {
  const f: Record<SupplyUnit, [string, number]> = { each: ['c', 1], g: ['w', 1], kg: ['w', 1000], ml: ['v', 1], l: ['v', 1000] };
  return f[unit][0] === f[base][0] ? (qty * f[unit][1]) / f[base][1] : null;
};

const requestError = (err: unknown): string | undefined => (err instanceof Error && 'response' in err
  ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
  : undefined);

export interface MenuItemEditorProps {
  productId: string;
  recipe: Recipe | null;
  products: MenuProduct[];
  categories: MenuCategory[];
  supplies: MenuSupply[];
  taxCategories: { id: string; label: string }[];
  canEditProduct: boolean;
  canEditRecipe: boolean;
  onClose: () => void;
  onSaved: () => void;
  onOpenAdvanced?: (productId: string) => void;
}

export default function MenuItemEditor({
  productId, recipe, products, categories, supplies, taxCategories,
  canEditProduct, canEditRecipe, onClose, onSaved, onOpenAdvanced,
}: MenuItemEditorProps) {
  const t = useTranslations('inventory');
  const tCommon = useTranslations('common');
  const fmtNum = useFormatNumber();
  const { confirm, ConfirmDialog } = useConfirm();

  const isNew = productId === 'new';
  const [form, setForm] = useState<{ yield_quantity: string; dish: DishForm; items: LineForm[] }>(() => ({
    yield_quantity: recipe ? String(recipe.yield_quantity) : '1',
    dish: dishFromProduct(products.find((p) => p.id === productId)),
    items: recipe
      ? recipe.items.map((item) => ({ supply_id: item.supply_id, group_name: item.group_name ?? '', quantity: String(item.quantity), unit: item.unit }))
      : [],
  }));
  const [aiBusy, setAiBusy] = useState(false);
  const [showPhotoPicker, setShowPhotoPicker] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [aiPhotos, setAiPhotos] = useState<{ image_url: string; thumb: string; title: string }[]>([]);
  const [aiMissing, setAiMissing] = useState<string[]>([]);
  const [targetFoodCost, setTargetFoodCost] = useState(() => {
    try { return window.localStorage.getItem('recipeTargetFoodCostPct') || '30'; } catch { return '30'; }
  });
  const updateTargetFoodCost = (value: string) => {
    setTargetFoodCost(value);
    try { window.localStorage.setItem('recipeTargetFoodCostPct', value); } catch { /* optional convenience */ }
  };

  const groupNames = [...new Set(supplies.map((s) => s.group_name).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b));
  const setDish = (patch: Partial<DishForm>) => setForm((prev) => ({ ...prev, dish: { ...prev.dish, ...patch } }));

  const lineSupply = (item: { supply_id: string; group_name: string }): MenuSupply | undefined => {
    if (!item.group_name) return supplies.find((s) => s.id === item.supply_id);
    const members = supplies.filter((s) => s.group_name === item.group_name);
    const resolved = recipe?.items.find((r) => r.group_name === item.group_name);
    return members.find((s) => s.id === resolved?.supply_id) ?? members.find((s) => Number(s.stock_quantity) > 0) ?? members[0];
  };
  const lines = form.items.map((item) => {
    const supply = lineSupply(item);
    const qty = Number(item.quantity);
    const base = supply && Number.isFinite(qty) ? toBase(qty, item.unit, supply.base_unit) : null;
    const cost = supply && base !== null && supply.unit_cost !== null ? base * Number(supply.unit_cost) : null;
    return { supply, cost };
  });
  const yieldQty = Number(form.yield_quantity) > 0 ? Number(form.yield_quantity) : 1;
  const complete = lines.length > 0 && lines.every((l) => l.cost !== null);
  const costPerServing = lines.reduce((sum, l) => sum + (l.cost ?? 0), 0) / yieldQty;
  const dishPrice = form.dish.price === '' ? undefined : Number(form.dish.price);
  const price = dishPrice !== undefined && Number.isFinite(dishPrice) ? dishPrice : undefined;
  const targetPct = Number(targetFoodCost);
  const suggested = complete && targetPct > 0 && targetPct < 100
    ? Math.ceil((costPerServing / (targetPct / 100)) * 4) / 4
    : null;
  const foodCostPct = complete && typeof price === 'number' && price > 0 ? (costPerServing / price) * 100 : null;
  const margin = complete && typeof price === 'number' ? price - costPerServing : null;

  const handleAiHelp = async () => {
    const name = form.dish.name.trim();
    if (!name) { toast.error(t('aiNeedName')); return; }
    const category = categories.find((c) => c.id === form.dish.category_id)?.name ?? '';
    setAiBusy(true);
    setAiPhotos([]);
    setAiMissing([]);
    try {
      const [recipeRes, photoRes] = await Promise.allSettled([
        api.post('/recipes/ai/suggest', { name, category }),
        api.post('/recipes/ai/photos', { query: `${name} ${category}`.trim() }),
      ]);
      if (recipeRes.status === 'fulfilled') {
        const suggestion = recipeRes.value.data as {
          yield_quantity: number;
          items: { supply_id: string | null; group_name: string | null; quantity: number; unit: SupplyUnit }[];
          not_in_inventory: { name: string }[];
        };
        const existing = new Set(form.items.map((i) => (i.group_name ? `group:${i.group_name}` : i.supply_id)));
        const added = suggestion.items
          .filter((i) => !existing.has(i.group_name ? `group:${i.group_name}` : String(i.supply_id)))
          .map((i) => ({ supply_id: i.supply_id ?? '', group_name: i.group_name ?? '', quantity: String(i.quantity), unit: i.unit }));
        if (added.length > 0) {
          setForm((prev) => ({
            ...prev,
            yield_quantity: prev.items.length === 0 ? String(suggestion.yield_quantity) : prev.yield_quantity,
            items: [...prev.items, ...added],
          }));
          toast.success(t('aiAdded', { count: added.length }));
        }
        setAiMissing(suggestion.not_in_inventory.map((i) => i.name));
      } else {
        toast.error(requestError(recipeRes.reason) || t('saveFailed'));
      }
      if (photoRes.status === 'fulfilled') {
        const found = (photoRes.value.data.photos || []) as { image_url: string; thumbnail_url: string; title: string }[];
        const loaded = await Promise.allSettled(found.map((p) => api.post('/products/fetch-url', { url: p.thumbnail_url })));
        const usable = found.flatMap((p, index) => {
          const result = loaded[index];
          return result.status === 'fulfilled' && result.value.data.data
            ? [{ image_url: p.image_url, thumb: String(result.value.data.data), title: p.title }]
            : [];
        });
        setAiPhotos(usable);
        if (usable.length > 0) setShowPhotoPicker(true);
      } else if (recipeRes.status === 'fulfilled') {
        toast.error(requestError(photoRes.reason) || t('saveFailed'));
      }
    } finally {
      setAiBusy(false);
    }
  };

  const handlePickAiPhoto = async (photo: { image_url: string; thumb: string }) => {
    setAiBusy(true);
    try {
      let dataUri = photo.thumb;
      try {
        const full = await api.post('/products/fetch-url', { url: photo.image_url });
        if (full.data.data) dataUri = String(full.data.data);
      } catch { /* the thumbnail is the fallback */ }
      const blob = await (await fetch(dataUri)).blob();
      const compressed = await compressImage(new File([blob], 'photo', { type: blob.type || 'image/jpeg' }));
      if (compressed) {
        setDish({ image: compressed, imageTouched: true });
        setAiPhotos([]);
        setShowPhotoPicker(false);
      } else {
        toast.error(t('saveFailed'));
      }
    } finally {
      setAiBusy(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const dish = form.dish;
      const cleanPrice = Math.round(Number(dish.price) * 100) / 100;
      let id = productId;
      if (isNew) {
        const created = await api.post('/products', {
          name: dish.name.trim(),
          category_id: dish.category_id || null,
          price: cleanPrice,
          is_active: dish.is_active,
          sku: dish.sku.trim() || nextSku(products),
          barcode: dish.barcode.trim() || null,
          description: dish.description.trim() || null,
          tax_category_id: dish.tax_category_id || null,
          ...(dish.imageTouched ? { image_url: dish.image } : {}),
        });
        id = String(created.data.product.id);
      } else if (canEditProduct) {
        const current = products.find((p) => p.id === productId);
        const patch: Record<string, unknown> = {};
        if (current) {
          if (dish.name.trim() && dish.name.trim() !== current.name) patch.name = dish.name.trim();
          if ((dish.category_id || null) !== (current.category_id ?? null)) patch.category_id = dish.category_id || null;
          if (dish.price !== '' && cleanPrice !== Number(current.price)) patch.price = cleanPrice;
          if (dish.sku.trim() !== (current.sku ?? '')) patch.sku = dish.sku.trim() || null;
          if (dish.barcode.trim() !== (current.barcode ?? '')) patch.barcode = dish.barcode.trim() || null;
          if (dish.description.trim() !== (current.description ?? '')) patch.description = dish.description.trim() || null;
          if (dish.tax_category_id !== (current.tax_category_id ?? '')) patch.tax_category_id = dish.tax_category_id || null;
          if (dish.is_active !== (current.is_active === true || current.is_active === 1)) patch.is_active = dish.is_active;
        }
        if (dish.imageTouched) patch.image_url = dish.image;
        if (Object.keys(patch).length > 0) await api.put(`/products/${productId}`, patch);
      }
      if (canEditRecipe) {
        if (form.items.length > 0) {
          await api.put(`/recipes/product/${id}`, {
            yield_quantity: Number(form.yield_quantity),
            is_active: recipe ? recipe.is_active === 1 : false,
            items: form.items.map((item) => (item.group_name
              ? { group_name: item.group_name, quantity: Number(item.quantity), unit: item.unit }
              : { supply_id: item.supply_id, quantity: Number(item.quantity), unit: item.unit })),
          });
        } else if (recipe) {
          if (!await confirm(t('confirmDeleteRecipe', { name: dish.name }), { destructive: true, confirmLabel: tCommon('delete') })) return;
          await api.delete(`/recipes/product/${id}`);
        }
      }
      toast.success(tCommon('save'));
      onSaved();
    } catch (err: unknown) {
      toast.error(requestError(err) || t('saveFailed'));
    }
  };

  const photoSrc = form.dish.image === 'EXISTING'
    ? (isNew ? null : `${api.defaults.baseURL}/products/${productId}/image`)
    : form.dish.image;
  const tilePhoto = photoSrc ?? genericMenuPhoto(form.dish.name);
  const compactField = 'w-full px-3 py-1.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card disabled:opacity-60';
  const statLabel = 'text-xs font-medium text-muted-foreground';
  const addLine = () => setForm({
    ...form,
    items: [...form.items, { supply_id: supplies[0]?.id || '', group_name: '', quantity: '1', unit: (supplies[0]?.base_unit || 'each') as SupplyUnit }],
  });
  const draft = recipe !== null && recipe.is_active !== 1;
  const canSave = isNew ? canEditProduct : (canEditProduct || canEditRecipe);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-card rounded-2xl w-full max-w-6xl h-[96vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-xl font-bold truncate">
              {form.dish.name.trim() || (isNew ? t('addRecipe') : t('editRecipe'))}
            </h2>
            {draft && <Badge variant="secondary">{t('draft')}</Badge>}
          </div>
          <div className="flex items-center gap-4 shrink-0">
            {canEditRecipe && canEditProduct && (
              <Button type="button" variant="outline" size="sm" disabled={aiBusy} onClick={handleAiHelp}>
                <Sparkles size={16} className="me-1" /> {aiBusy ? '…' : t('aiHelp')}
              </Button>
            )}
            <button type="button" role="switch" aria-checked={form.dish.is_active} disabled={!canEditProduct}
              onClick={() => setDish({ is_active: !form.dish.is_active })}
              className="flex items-center gap-2 disabled:opacity-60">
              <span className={`relative inline-block h-7 w-12 rounded-full transition-colors ${form.dish.is_active ? 'bg-green-600' : 'bg-gray-500'}`}>
                <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${form.dish.is_active ? 'start-[1.5rem]' : 'start-0.5'}`} />
              </span>
              <span className={`text-sm font-semibold ${form.dish.is_active ? 'text-green-600' : 'text-muted-foreground'}`}>
                {form.dish.is_active ? t('onPos') : t('offPos')}
              </span>
            </button>
            <button type="button" onClick={onClose}><X size={24} className="text-gray-400" /></button>
          </div>
        </div>

        {(aiMissing.length > 0 || aiPhotos.length > 0) && (
          <div className="px-5 py-2 text-xs border-b border-border bg-muted">
            {aiMissing.length > 0 && <span className="text-amber-600">{t('aiNotInInventory', { names: aiMissing.join(', ') })} </span>}
            <span className="text-muted-foreground">{t('aiDraftNote')}</span>
          </div>
        )}

        <form id="menu-item-form" onSubmit={handleSave}
          className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden grid gap-4 p-4 lg:grid-cols-[1fr_20rem]">
          <div className="flex flex-col gap-3 min-h-0">
            <div className="flex items-end gap-3">
              <button type="button" disabled={!canEditProduct} onClick={() => setShowPhotoPicker(true)} title={t('dishPhoto')}
                className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-dashed border-border bg-muted hover:ring-2 hover:ring-brand">
                {tilePhoto
                  ? <img src={tilePhoto} alt="" className="h-full w-full object-cover" />
                  : <Camera size={24} className="mx-auto text-muted-foreground" />}
                {aiPhotos.length > 0 && <span className="absolute bottom-0 end-0 rounded-tl-md bg-brand px-1 text-[10px] text-white">{aiPhotos.length}</span>}
              </button>
              <div className="flex-1 min-w-0">
                <label className={statLabel}>{t('dishName')}</label>
                <input type="text" value={form.dish.name} onChange={(e) => setDish({ name: e.target.value })}
                  className={compactField} disabled={!canEditProduct} required />
              </div>
              <div className="w-44">
                <label className={statLabel}>{t('dishCategory')}</label>
                <select value={form.dish.category_id} onChange={(e) => setDish({ category_id: e.target.value })}
                  className={compactField} disabled={!canEditProduct} required={isNew}>
                  <option value="">{t('chooseCategory')}</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              {canEditRecipe && (
                <div className="w-20">
                  <label className={statLabel}>{t('yield')}</label>
                  <input type="number" step="any" min="0.00000001" value={form.yield_quantity}
                    onChange={(e) => setForm({ ...form, yield_quantity: e.target.value })}
                    className={compactField} required={form.items.length > 0} />
                </div>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => setShowDetails(true)}>
                <SlidersHorizontal size={14} className="me-1" /> {t('moreDetails')}
              </Button>
            </div>

            {canEditRecipe && (
              <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-border">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <h3 className="text-sm font-semibold">{t('sectionIngredients')}</h3>
                  <Button type="button" variant="outline" size="sm" onClick={addLine}>
                    <Plus size={14} /> {t('addComponent')}
                  </Button>
                </div>
                {form.items.length > 0 && (
                  <div className="hidden sm:grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem_6rem_2rem] gap-2 px-3 pt-2 text-[11px] uppercase text-muted-foreground">
                    <span>{t('recipeIngredient')}</span><span>{t('recipeAmount')}</span><span>{t('baseUnit')}</span>
                    <span className="text-end">{t('recipeLineCost')}</span><span className="text-end">{t('recipeInStock')}</span><span />
                  </div>
                )}
                <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1.5">
                  {form.items.length === 0 && (
                    <p className="text-sm text-muted-foreground py-4 text-center">{t('noRecipeHint')}</p>
                  )}
                  {form.items.map((item, index) => {
                    const line = lines[index];
                    return (
                      <div key={index} className="grid grid-cols-2 sm:grid-cols-[1fr_5.5rem_4.5rem_4.5rem_6rem_2rem] gap-2 items-center">
                        <select value={item.group_name ? `group:${item.group_name}` : item.supply_id}
                          onChange={(e) => {
                            const items = [...form.items];
                            const picked = e.target.value;
                            const groupName = picked.startsWith('group:') ? picked.slice(6) : '';
                            const targetSupply = groupName
                              ? supplies.find((s) => s.group_name === groupName)
                              : supplies.find((s) => s.id === picked);
                            items[index] = {
                              ...items[index],
                              supply_id: groupName ? (targetSupply?.id || '') : picked,
                              group_name: groupName,
                              unit: (targetSupply?.base_unit || 'each') as SupplyUnit,
                            };
                            setForm({ ...form, items });
                          }}
                          className={`${compactField} col-span-2 sm:col-span-1 min-w-0`}>
                          <option value="">{t('supply')}</option>
                          {groupNames.length > 0 && (
                            <optgroup label={t('anyInGroup')}>
                              {groupNames.map((g) => <option key={g} value={`group:${g}`}>{g}</option>)}
                            </optgroup>
                          )}
                          <optgroup label={t('singleItems')}>
                            {supplies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </optgroup>
                        </select>
                        <input type="number" step="any" min="0.00000001" placeholder={t('quantity')} value={item.quantity}
                          onChange={(e) => {
                            const items = [...form.items];
                            items[index] = { ...items[index], quantity: e.target.value };
                            setForm({ ...form, items });
                          }}
                          className={compactField} required />
                        <select value={item.unit}
                          onChange={(e) => {
                            const items = [...form.items];
                            items[index] = { ...items[index], unit: e.target.value as SupplyUnit };
                            setForm({ ...form, items });
                          }}
                          className={compactField}>
                          {SUPPLY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                        <span className={`text-end text-sm ${line.cost === null ? 'text-amber-600' : ''}`}>
                          {line.cost === null ? '—' : fmtNum(Math.round(line.cost * 100) / 100)}
                        </span>
                        <span className={`text-end text-xs ${line.supply && Number(line.supply.stock_quantity) <= 0 ? 'text-red-600' : 'text-muted-foreground'}`}>
                          {line.supply ? `${fmtNum(Number(line.supply.stock_quantity))} ${line.supply.base_unit}` : '—'}
                        </span>
                        <Button type="button" variant="ghost" size="icon-sm"
                          onClick={() => setForm({ ...form, items: form.items.filter((_, i) => i !== index) })}>
                          <X size={14} />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-border p-4 min-h-0 overflow-y-auto">
            <h3 className="text-sm font-semibold">{t('sectionPricing')}</h3>
            {canEditRecipe && (
              <>
                <div className="flex items-baseline justify-between">
                  <span className={statLabel}>{t('recipeCostPerServing')}</span>
                  <span className="text-xl font-bold">{lines.length === 0 ? '—' : fmtNum(Math.round(costPerServing * 100) / 100)}</span>
                </div>
                <div className="grid grid-cols-[5rem_1fr] gap-3 items-end">
                  <div>
                    <label className={statLabel}>{t('targetFoodCost')}</label>
                    <input type="number" step="any" min="1" max="99" value={targetFoodCost}
                      onChange={(e) => updateTargetFoodCost(e.target.value)} className={compactField} />
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={suggested === null || !canEditProduct}
                    onClick={() => suggested !== null && setDish({ price: String(suggested) })}>
                    {t('suggestedPrice')}: {suggested === null ? '—' : fmtNum(suggested)}
                  </Button>
                </div>
              </>
            )}
            <div className="rounded-xl bg-muted p-3">
              <label className="block text-sm font-semibold mb-1">{t('actualPrice')}</label>
              <input type="number" step="any" min="0" value={form.dish.price}
                onChange={(e) => setDish({ price: e.target.value })} disabled={!canEditProduct}
                className="w-full px-3 py-2 text-2xl font-bold border-2 border-brand rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card disabled:opacity-60" required />
            </div>
            {canEditRecipe && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className={statLabel}>{t('profitPerServing')}</p>
                  <p className="text-xl font-bold">{margin === null ? '—' : fmtNum(Math.round(margin * 100) / 100)}</p>
                  {margin !== null && typeof price === 'number' && price > 0 && (
                    <p className="text-xs text-muted-foreground">{fmtNum(Math.round((margin / price) * 1000) / 10)}%</p>
                  )}
                </div>
                <div>
                  <p className={statLabel}>{t('foodCostLabel')}</p>
                  <p className="text-xl font-bold">{foodCostPct === null ? '—' : `${fmtNum(Math.round(foodCostPct * 10) / 10)}%`}</p>
                </div>
              </div>
            )}
            <Button type="submit" size="lg" className="mt-auto w-full text-base" disabled={!canSave}>{tCommon('save')}</Button>
          </div>
        </form>
      </div>

      {showDetails && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4" onClick={() => setShowDetails(false)}>
          <div className="bg-card rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">{t('moreDetails')}</h3>
              <button type="button" onClick={() => setShowDetails(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={statLabel}>{t('dishSku')}</label>
                <input type="text" value={form.dish.sku} onChange={(e) => setDish({ sku: e.target.value })} disabled={!canEditProduct}
                  placeholder={isNew && nextSku(products) ? t('skuAuto', { sku: nextSku(products) ?? '' }) : ''} className={compactField} />
              </div>
              <div>
                <label className={statLabel}>{t('dishBarcode')}</label>
                <input type="text" value={form.dish.barcode} onChange={(e) => setDish({ barcode: e.target.value })} disabled={!canEditProduct} className={compactField} />
              </div>
            </div>
            <div>
              <label className={statLabel}>{t('dishDescription')}</label>
              <textarea rows={3} value={form.dish.description} onChange={(e) => setDish({ description: e.target.value })} disabled={!canEditProduct} className={compactField} />
            </div>
            {taxCategories.length > 0 && (
              <div>
                <label className={statLabel}>{t('dishTaxCategory')}</label>
                <select value={form.dish.tax_category_id} onChange={(e) => setDish({ tax_category_id: e.target.value })} disabled={!canEditProduct} className={compactField}>
                  <option value="">{t('taxStoreDefault')}</option>
                  {taxCategories.map((tc) => <option key={tc.id} value={tc.id}>{tc.label}</option>)}
                </select>
              </div>
            )}
            {onOpenAdvanced && !isNew && canEditProduct && (
              <Button type="button" variant="outline" className="w-full" onClick={() => onOpenAdvanced(productId)}>
                {t('advancedSettings')}
              </Button>
            )}
            <Button type="button" className="w-full" onClick={() => setShowDetails(false)}>{t('detailsDone')}</Button>
          </div>
        </div>
      )}

      {showPhotoPicker && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4" onClick={() => setShowPhotoPicker(false)}>
          <div className="bg-card rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">{t('dishPhoto')}</h3>
              <button type="button" onClick={() => setShowPhotoPicker(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            {aiPhotos.length > 0 && (
              <div>
                <p className={statLabel}>{t('aiPickPhoto')}</p>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  {aiPhotos.map((photo) => (
                    <button key={photo.image_url} type="button" disabled={aiBusy} onClick={() => handlePickAiPhoto(photo)}
                      className="aspect-square overflow-hidden rounded-lg border border-border hover:ring-2 hover:ring-brand" title={photo.title}>
                      <img src={photo.thumb} alt={photo.title} className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <ImageUploader
              value={form.dish.image}
              onChange={(val) => { setDish({ image: val, imageTouched: true }); if (val) setShowPhotoPicker(false); }}
              productId={isNew ? undefined : productId}
            />
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}
