'use client';

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Search, SlidersHorizontal, Star, UtensilsCrossed, Martini, Wine, Beer, Coffee } from 'lucide-react';
import type { Category, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { nameToColor } from '@/lib/image-utils';
import { genericMenuPhoto } from '@/lib/generic-menu-photos';
import TagBadge from './DietaryBadge';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import { parseDbTimestamp } from '@/lib/utils';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { resolveScannedProduct } from '@/lib/scale-barcode';

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string; activeBg: string; activeText: string }> = {
  red: { bg: 'bg-red-50 dark:bg-red-950/40', text: 'text-red-700 dark:text-red-300', border: 'border-red-200 dark:border-red-800/40', activeBg: 'bg-red-500', activeText: 'text-white' },
  orange: { bg: 'bg-orange-50 dark:bg-orange-950/40', text: 'text-orange-700 dark:text-orange-300', border: 'border-orange-200 dark:border-orange-800/40', activeBg: 'bg-orange-500', activeText: 'text-white' },
  amber: { bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-700 dark:text-amber-300', border: 'border-amber-200 dark:border-amber-800/40', activeBg: 'bg-amber-500', activeText: 'text-white' },
  yellow: { bg: 'bg-yellow-50 dark:bg-yellow-950/40', text: 'text-yellow-700 dark:text-yellow-300', border: 'border-yellow-200 dark:border-yellow-800/40', activeBg: 'bg-yellow-500', activeText: 'text-white' },
  lime: { bg: 'bg-lime-50 dark:bg-lime-950/40', text: 'text-lime-700 dark:text-lime-300', border: 'border-lime-200 dark:border-lime-800/40', activeBg: 'bg-lime-500', activeText: 'text-white' },
  green: { bg: 'bg-green-50 dark:bg-green-950/40', text: 'text-green-700 dark:text-green-300', border: 'border-green-200 dark:border-green-800/40', activeBg: 'bg-green-500', activeText: 'text-white' },
  emerald: { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-700 dark:text-emerald-300', border: 'border-emerald-200 dark:border-emerald-800/40', activeBg: 'bg-emerald-500', activeText: 'text-white' },
  teal: { bg: 'bg-teal-50 dark:bg-teal-950/40', text: 'text-teal-700 dark:text-teal-300', border: 'border-teal-200 dark:border-teal-800/40', activeBg: 'bg-teal-500', activeText: 'text-white' },
  cyan: { bg: 'bg-cyan-50 dark:bg-cyan-950/40', text: 'text-cyan-700 dark:text-cyan-300', border: 'border-cyan-200 dark:border-cyan-800/40', activeBg: 'bg-cyan-500', activeText: 'text-white' },
  sky: { bg: 'bg-sky-50 dark:bg-sky-950/40', text: 'text-sky-700 dark:text-sky-300', border: 'border-sky-200 dark:border-sky-800/40', activeBg: 'bg-sky-500', activeText: 'text-white' },
  blue: { bg: 'bg-blue-50 dark:bg-blue-950/40', text: 'text-blue-700 dark:text-blue-300', border: 'border-blue-200 dark:border-blue-800/40', activeBg: 'bg-blue-500', activeText: 'text-white' },
  indigo: { bg: 'bg-indigo-50 dark:bg-indigo-950/40', text: 'text-indigo-700 dark:text-indigo-300', border: 'border-indigo-200 dark:border-indigo-800/40', activeBg: 'bg-indigo-500', activeText: 'text-white' },
  violet: { bg: 'bg-violet-50 dark:bg-violet-950/40', text: 'text-violet-700 dark:text-violet-300', border: 'border-violet-200 dark:border-violet-800/40', activeBg: 'bg-violet-500', activeText: 'text-white' },
  purple: { bg: 'bg-purple-50 dark:bg-purple-950/40', text: 'text-purple-700 dark:text-purple-300', border: 'border-purple-200 dark:border-purple-800/40', activeBg: 'bg-purple-500', activeText: 'text-white' },
  fuchsia: { bg: 'bg-fuchsia-50 dark:bg-fuchsia-950/40', text: 'text-fuchsia-700 dark:text-fuchsia-300', border: 'border-fuchsia-200 dark:border-fuchsia-800/40', activeBg: 'bg-fuchsia-500', activeText: 'text-white' },
  pink: { bg: 'bg-pink-50 dark:bg-pink-950/40', text: 'text-pink-700 dark:text-pink-300', border: 'border-pink-200 dark:border-pink-800/40', activeBg: 'bg-pink-500', activeText: 'text-white' },
  rose: { bg: 'bg-rose-50 dark:bg-rose-950/40', text: 'text-rose-700 dark:text-rose-300', border: 'border-rose-200 dark:border-rose-800/40', activeBg: 'bg-rose-500', activeText: 'text-white' },
};

function getCategoryColorClasses(color: string | null | undefined) {
  if (!color) return null;
  return CATEGORY_COLORS[color.toLowerCase()] || null;
}

interface Props {
  categories: Category[];
  products: Product[];
  selectedCategory: string | null;
  setSelectedCategory: (id: string | null) => void;
  search: string;
  setSearch: (s: string) => void;
  currency: string;
  onProductClick: (product: Product) => void;
  sidebarOpen?: boolean;
  canArrange?: boolean;
  onOrderSaved?: () => Promise<void>;
}

export default function ProductGrid({
  categories, products, selectedCategory, setSelectedCategory,
  search, setSearch, onProductClick, sidebarOpen = true, canArrange = false, onOrderSaved,
}: Props) {
  const cart = useCartStore();
  const [arranging, setArranging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const { showProductImages } = usePosSettingsStore();
  const [showMenuPhotos, setShowMenuPhotos] = useState(false);
  const t = useTranslations('pos');
  const fmt = useFormatCurrency();
  const cartQuantities = useMemo(() => {
    const quantities = new Map<Product['id'], number>();
    for (const item of cart.items) {
      quantities.set(item.product.id, (quantities.get(item.product.id) || 0) + item.quantity);
    }
    return quantities;
  }, [cart.items]);

  // UI-only grouping: preserve original categories, products, and database.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [favorites] = useState<string[]>([]);
  // Bundled illustrations load locally, including when Flo is offline.
  const groupLabels = ['Favorites', 'Food', 'Cocktails', 'Spirits', 'Beer & Wine', 'Non-Alcoholic'] as const;
  const groups = useMemo(() => {
    const result = new Map<string, Category[]>();
    groupLabels.forEach((label) => result.set(label, []));
    // Some imported menus place burgers inside a broad Food category.
    // Expose Burgers as a virtual submenu without changing stored category IDs.
    for (const cat of categories) {
      const name = cat.name.toLowerCase();
      const group = /^spirits(?:\s|$|[—–-])/.test(name) ? 'Spirits'
        : name.includes('cocktail') ? 'Cocktails'
        : /beer|wine/.test(name) ? 'Beer & Wine'
        : /coffee|juice|water|soft drink|tea|smoothie/.test(name) ? 'Non-Alcoholic'
        : 'Food';
      result.get(group)!.push(cat);
    }
    return result;
  }, [categories]);
  const activeGroup = openGroup && groups.has(openGroup) ? openGroup : null;
  const children = activeGroup ? groups.get(activeGroup) ?? [] : [];
  const burgerProducts = useMemo(() => products.filter((p) => /burger/i.test(p.name)), [products]);
  const hasBurgerCategory = (groups.get('Food') ?? []).some((cat) => /burger/i.test(cat.name));
  const showVirtualBurgers = activeGroup === 'Food' && burgerProducts.length > 0 && !hasBurgerCategory;
  const burgerFilterSelected = selectedCategory === '__virtual_burgers__';
  const filtered = products.filter((p) => {
    // The landing screen is navigation only; show products after selecting a group.
    if (!activeGroup && !search.trim()) return false;
    const matchCat = burgerFilterSelected ? /burger/i.test(p.name)
      : selectedCategory ? p.category_id === selectedCategory
      : activeGroup === 'Favorites' ? favorites.includes(String(p.id))
      : activeGroup ? children.some((cat) => cat.id === p.category_id) : true;
    return matchCat && (!search || p.name.toLowerCase().includes(search.toLowerCase()));
  });
  const ordered = [...filtered].sort((a,b) => (a.sort_order ?? 0)-(b.sort_order ?? 0) || a.name.localeCompare(b.name));
  const displayed = arranging ? [...ordered].sort((a,b) => ids.indexOf(String(a.id))-ids.indexOf(String(b.id))) : ordered;
  const saveOrder = async () => {
    setSaving(true);
    try {
      const base = Math.max(0,...products.map(p => p.sort_order || 0)) + 1;
      for (let i=0;i<ids.length;i++) await api.put('/products/'+ids[i], {sort_order:base+i});
      await onOrderSaved?.();
      setArranging(false);
      toast.success('Menu order saved');
    } catch { toast.error('Could not save order. Refresh and retry.'); }
    finally { setSaving(false); }
  };
  // VeloxPOS category-pill styling; retain FloPOS group IDs and filtering.
  const groupEmoji: Record<(typeof groupLabels)[number], string> = {
    Favorites: '⭐', Food: '🍔', Cocktails: '🍹', Spirits: '🥃',
    'Beer & Wine': '🍺', 'Non-Alcoholic': '☕',
  };

  return (
    <div data-testid="pos-product-grid" className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <div className="shrink-0 mb-4">
        {canArrange && selectedCategory && <div className="mb-2 flex justify-end gap-2">
          {arranging ? <>
            <span className="mr-auto text-xs">Drag pictures to reorder</span>
            <button type="button" disabled={saving} onClick={() => setArranging(false)}>Cancel</button>
            <button type="button" disabled={saving} onClick={() => void saveOrder()} className="rounded bg-brand px-3 py-1 text-white">Save Order</button>
          </> : <button type="button" onClick={() => {setIds(ordered.map(p=>String(p.id)));setArranging(true);}} className="rounded border px-3 py-1">Arrange Menu</button>}
        </div>}
        <div className="relative mb-4">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // Typed or pasted barcode, not just a scanner — a dedicated
              // action into this field works regardless of typing speed.
              const trimmed = search.trim();
              if (!trimmed) return;
              const match = resolveScannedProduct(trimmed, products);
              if (match) {
                if (match.scaleBarcode) cart.addItem(match.product, match.quantity);
                else onProductClick(match.product);
                setSearch('');
              }
            }}
            placeholder={t('searchProducts')}
            className="w-full ps-10 pe-4 py-3 bg-card border border-border rounded-2xl focus:border-brand focus:ring-2 focus:ring-brand/10 outline-none transition-colors text-sm shadow-sm"
          />
        </div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Menu</span>
          {showProductImages && <button type="button" onClick={() => setShowMenuPhotos(v => !v)}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">
            {showMenuPhotos ? 'Compact cards' : 'Show photos'}
          </button>}
        </div>
        {/* Preview layout A: compact horizontal categories and contextual subcategories. */}
        <nav aria-label="Menu categories" className="flex shrink-0 items-center gap-2 overflow-x-auto rounded-none border-b border-slate-800/80 bg-[#0f172a] px-4 py-3">
          {groupLabels.map(label => {
            const selected = activeGroup === label;
            return <button key={label} type="button"
              onClick={() => { setOpenGroup(label); setSelectedCategory(null); setArranging(false); }}
              aria-pressed={selected}
              className={`shrink-0 whitespace-nowrap rounded-xl border px-4 py-2 text-xs font-bold transition-all ${selected ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300' : 'border-slate-800 bg-[#1e293b] text-slate-300 hover:bg-[#334155]'}`}>
              <span aria-hidden="true">{groupEmoji[label]}</span> {label}
            </button>;
          })}
        </nav>
        {activeGroup && activeGroup !== 'Favorites' && (
          <nav aria-label="Menu subcategories" className="flex gap-2 overflow-x-auto py-2">
            <button type="button" onClick={() => setSelectedCategory(null)}
              className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold ${!selectedCategory ? 'border-brand bg-brand/10 text-brand' : 'border-border bg-card'}`}>All {activeGroup}</button>
            {[
              ...(showVirtualBurgers ? [{ id: '__virtual_burgers__', name: 'Burgers' }] : []),
              ...children.map(cat => ({ id: cat.id, name: activeGroup === 'Cocktails' ? cat.name.replace(/\\s+Cocktails?$/i, '') : cat.name.replace(/^Spirits\s*[—–-]\s*/i, '') })),
            ].map(cat => <button key={cat.id} type="button" onClick={() => setSelectedCategory(cat.id)}
              className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold ${selectedCategory === cat.id ? 'border-brand bg-brand/10 text-brand' : 'border-border bg-card hover:bg-muted'}`}>{cat.name}</button>)}
          </nav>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
        {activeGroup === 'Favorites' && <h2 className="text-xl font-bold tracking-tight mb-3">Favorites</h2>}
        {!activeGroup && !search.trim() && (
          <p className="text-sm text-muted-foreground py-4 text-center">Select a menu category above to browse products.</p>
        )}
        {(!!activeGroup || !!search.trim()) && <div className={`grid gap-3 ${
          sidebarOpen 
            ? 'grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' 
            : 'grid-cols-2 lg:grid-cols-4 xl:grid-cols-5'
        }`}>
          {displayed.map((product) => {
            const inCartQty = cartQuantities.get(product.id) || 0;
            

            return (
              <button
                key={product.id}
                data-testid="pos-product-card"
                type="button"
                draggable={arranging}
                onDragStart={e => {setDragId(String(product.id));e.dataTransfer.effectAllowed='move';}}
                onDragOver={e => {if(arranging)e.preventDefault();}}
                onDrop={e => {e.preventDefault();if(!dragId)return;setIds(old=>{const next=[...old],a=next.indexOf(dragId),b=next.indexOf(String(product.id));if(a<0||b<0)return old;next.splice(a,1);next.splice(b,0,dragId);return next;});setDragId(null);}}
                onDragEnd={() => setDragId(null)}
                onClick={() => {if(!arranging)onProductClick(product);}}
                className="group flex flex-col justify-between bg-[#0f172a] text-slate-100 rounded-2xl p-3.5 border border-slate-800/80 border-l-4 hover:border-slate-700 hover:bg-[#162032] hover:scale-[1.02] active:scale-[0.97] shadow-sm hover:shadow-md transition-all duration-150 text-start relative cursor-pointer overflow-hidden touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                style={{ borderLeftColor: activeGroup === 'Cocktails' ? '#06b6d4' : activeGroup === 'Spirits' ? '#a855f7' : activeGroup === 'Food' ? '#f97316' : activeGroup === 'Beer & Wine' ? '#f59e0b' : activeGroup === 'Non-Alcoholic' ? '#10b981' : ['#f59e0b','#06b6d4','#10b981','#a855f7','#f97316'][String(product.category_id || product.id).split('').reduce((n,ch)=>n+ch.charCodeAt(0),0) % 5] }}
              >
                <div className="mb-2 flex items-start justify-between gap-1">
                  <div>
                    {!!product.track_inventory && product.stock_quantity <= 0 ? (
                      <span className="rounded-full border border-rose-800 bg-slate-800 px-2 py-0.5 text-[9px] font-black uppercase text-rose-400">{t('outOfStock')}</span>
                    ) : !!product.track_inventory && product.stock_quantity <= (product.low_stock_threshold || 0) ? (
                      <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[9px] font-black uppercase text-emerald-400">{t('lowStock')}</span>
                    ) : product.tags && product.tags.length > 0 ? (
                      <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[9px] font-black uppercase text-emerald-400">{product.tags[0]}</span>
                    ) : null}
                  </div>
                  {!!product.track_inventory && (
                    <span className="shrink-0 rounded border border-slate-800 bg-[#090d16] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{Number(product.stock_quantity)} left</span>
                  )}
                  {inCartQty > 0 && <span className="rounded-md bg-emerald-700 px-1.5 py-0.5 text-[10px] font-bold text-white">{inCartQty} in order</span>}
                </div>

                {showProductImages && showMenuPhotos && (
                  <div className="w-full aspect-[5/3] rounded-lg mb-1.5 relative overflow-hidden">
                    {/* Always-visible background tile — no flash when image loads */}
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ backgroundColor: nameToColor(product.name) }}
                    >
                      <span className="text-lg font-semibold text-white/80">
                        {product.name.substring(0, 2).toUpperCase()}
                      </span>
                    </div>

                    {/* Image overlays the tile when available */}
                    {(product.has_image || genericMenuPhoto(product.name)) && (
                      <img
                        src={product.has_image ? `${api.defaults.baseURL}/products/${product.id}/image?t=${product.updated_at ? parseDbTimestamp(product.updated_at).getTime() : 0}` : genericMenuPhoto(product.name)!}
                        alt={product.name}
                        className="absolute inset-0 w-full h-full object-cover rounded-lg"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}

                    {product.tags && product.tags.length > 0 && (
                      <span className="absolute bottom-1.5 end-1.5 z-10">
                        <TagBadge tag={product.tags[0]} />
                      </span>
                    )}
                  </div>
                )}

                <h3 className="font-bold text-sm text-slate-100 group-hover:text-emerald-400 transition-colors leading-snug">{product.name}</h3>
                <div className="flex items-center justify-between mt-4 pt-2 border-t border-slate-800/60">
                  <p className="font-mono text-base font-extrabold text-slate-200">{fmt(Number(product.price))}</p>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#1e293b] text-slate-400 group-hover:bg-emerald-500 group-hover:text-white transition-colors" aria-hidden="true"><Plus size={16} /></span>
                </div>
                            </button>
            );
          })}
        </div>}
      </div>
    </div>
  );
}
