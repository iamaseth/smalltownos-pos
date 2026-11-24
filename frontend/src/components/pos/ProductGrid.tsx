'use client';

import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import toast from 'react-hot-toast';
import { Search, Keyboard, Star, Zap, LayoutGrid } from 'lucide-react';
import type { Category, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { nameToColor } from '@/lib/image-utils';
import TagBadge from './DietaryBadge';
import OnScreenKeyboard from './OnScreenKeyboard';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import { parseDbTimestamp } from '@/lib/utils';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { resolveScannedProduct } from '@/lib/scale-barcode';

// Fast, offline menu search. No product/database changes or network calls.
const SEARCH_ALIASES: Record<string, string[]> = {
  coke: ['coca cola', 'coca-cola', 'cola'],
  cola: ['coca cola', 'coca-cola', 'coke'],
  fries: ['french fries', 'chips'],
  chips: ['french fries', 'fries'],
  soda: ['soft drink', 'cola'],
  softdrink: ['soft drink', 'soda'],
  burger: ['hamburger', 'cheeseburger'],
  marg: ['margarita'],
};
const normalizeMenuText = (value: string) =>
  value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function oneEditAway(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + Number(i < a.length || j < b.length) <= 1;
}
function menuSearchScore(name: string, rawQuery: string): number {
  const query = normalizeMenuText(rawQuery);
  if (!query) return 1;
  const title = normalizeMenuText(name);
  if (title === query) return 100;
  if (title.startsWith(query)) return 90;
  if (title.split(' ').some(word => word.startsWith(query))) return 80;
  if (title.includes(query)) return 70;
  const aliases = SEARCH_ALIASES[query] ?? [];
  if (aliases.some(alias => title.includes(normalizeMenuText(alias)))) return 60;
  // Fuzzy matching only for meaningful words, avoiding noise for 1-3 letters.
  if (query.length >= 4 && title.split(' ').some(word =>
    word.length >= 4 && oneEditAway(query, word))) return 40;
  return 0;
}

// Display-only grouping for existing Spirits products. Unrecognized products stay in Other.
const SPIRIT_GROUPS = ['Whiskey', 'Gin', 'Rum', 'Vodka', 'Liqueurs', 'Other'] as const;
function spiritGroup(name: string): typeof SPIRIT_GROUPS[number] {
  const n = name.toLowerCase();
  if (/whisk(e)?y|bourbon|scotch|jack daniel|chivas|ballantine|glenfiddich|jameson|jim beam|johnnie walker|fireball/.test(n)) return 'Whiskey';
  if (/gin|beefeater|hendrick|tanqueray|bombay|gordon/.test(n)) return 'Gin';
  if (/rum|bacardi|havana club|captain morgan|malibu/.test(n)) return 'Rum';
  if (/vodka|absolut|belvedere|smirnoff|grey goose|stolichnaya/.test(n)) return 'Vodka';
  if (/liqueur|amaretto|baileys|campari|aperol|frangelico|grand marnier|jäger|jager|sambuca|kahlua|cointreau|triple sec|limoncello|schnapps/.test(n)) return 'Liqueurs';
  return 'Other';
}

const FAVORITES_KEY = 'pos-favorite-products';

const subscribeCoarsePointer = (callback: () => void) => {
  const query = window.matchMedia('(pointer: coarse)');
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
};
const getCoarsePointer = () => window.matchMedia('(pointer: coarse)').matches;


interface Props {
  categories: Category[];
  products: Product[];
  selectedCategory: string | null;
  setSelectedCategory: (id: string | null) => void;
  search: string;
  setSearch: (s: string) => void;
  currency: string;
  onProductClick: (product: Product) => void;
  onQuickAdd: (product: Product) => void;
  searchSlot?: HTMLElement | null;
  canArrange?: boolean;
  onOrderSaved?: () => Promise<void>;
}

const LONG_PRESS_MS = 500;

export default function ProductGrid({
  categories, products, selectedCategory, setSelectedCategory,
  search, setSearch, onProductClick, onQuickAdd, canArrange = false, onOrderSaved, searchSlot = null,
}: Props) {
  const cart = useCartStore();
  const searchInputRef = useRef<HTMLInputElement>(null);
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

  const [favorites, setFavorites] = useState<string[]>([]);
  const [editingFavorites, setEditingFavorites] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const startPress = (product: Product) => {
    longPressed.current = false;
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => { longPressed.current = true; onProductClick(product); }, LONG_PRESS_MS);
  };
  const cancelPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const tapProduct = (product: Product) => {
    cancelPress();
    if (longPressed.current) { longPressed.current = false; return; }
    if (editingFavorites) { toggleFavorite(String(product.id)); return; }
    onQuickAdd(product);
  };
  const toggleFavorite = (id: string) => setFavorites(prev => {
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch {}
    return next;
  });
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedSubcategory, setSelectedSubcategory] = useState<string | null>(null);
  const visibleCategories = useMemo(
    () => categories.filter(cat => cat.is_active !== false && !cat.parent_id).sort((a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)),
    [categories]
  );
  const categoryColor = (value: string | null) => {
    const palette: Record<string, string> = {
      amber: '#D97706', green: '#16A34A', blue: '#2563EB',
      red: '#DC2626', pink: '#DB2777', orange: '#EA580C',
      purple: '#9333EA', teal: '#0D9488', yellow: '#CA8A04',
    };
    const color = (value || '').toLowerCase().trim();
    return palette[color] ?? (/^#[0-9a-f]{6}$/i.test(color) ? color : '#334155');
  };
  const categoryById = useMemo(() => new Map(categories.map(category => [category.id, category])), [categories]);
  const childIdsByParent = useMemo(() => {
    const children = new Map<string, string[]>();
    for (const category of categories) {
      if (!category.parent_id) continue;
      const ids = children.get(category.parent_id) || [];
      ids.push(category.id);
      children.set(category.parent_id, ids);
    }
    return children;
  }, [categories]);
  const categoryTreeIds = (parentId: string): Set<string> => {
    const ids = new Set<string>([parentId]);
    const pending = [parentId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const childId of childIdsByParent.get(current) || []) {
        if (ids.has(childId)) continue;
        ids.add(childId);
        pending.push(childId);
      }
    }
    return ids;
  };
  const hasActiveCategoryPath = (categoryId: string | null): boolean => {
    let currentId = categoryId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const current = categoryById.get(currentId);
      if (!current) return true;
      if (current.is_active === false) return false;
      currentId = current.parent_id;
    }
    return true;
  };
  const selectedMainCategory = visibleCategories.find(c => c.id === selectedCategory);
  const childCategories = categories.filter(c => c.is_active !== false && c.parent_id === selectedCategory)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
  const spiritVirtualGroups = selectedMainCategory?.name.toLowerCase() === 'spirits' && childCategories.length === 0;
  const subcategoryNames = spiritVirtualGroups ? [...SPIRIT_GROUPS] : childCategories.map(c => c.name);
  const subcategoryId = childCategories.find(c => c.name === selectedSubcategory)?.id;
  const selectedCategoryTree = selectedCategory ? categoryTreeIds(selectedCategory) : null;
  const selectedSubcategoryTree = subcategoryId ? categoryTreeIds(subcategoryId) : null;
  const filtered = products.filter((p) => {
    if (!hasActiveCategoryPath(p.category_id)) return false;
    const matchCat = favoritesOnly ? favorites.includes(String(p.id))
      : selectedCategory ? selectedCategoryTree?.has(String(p.category_id)) === true : true;
    const matchSub = !selectedSubcategory ? true
      : spiritVirtualGroups ? spiritGroup(p.name) === selectedSubcategory
      : selectedSubcategoryTree?.has(String(p.category_id)) === true;
    return matchCat && matchSub && menuSearchScore(p.name, search) > 0;
  });
  const ordered = [...filtered].sort((a,b) => {
    if (search.trim()) {
      const difference = menuSearchScore(b.name, search) - menuSearchScore(a.name, search);
      if (difference) return difference;
    }
    return (a.sort_order ?? 0)-(b.sort_order ?? 0) || a.name.localeCompare(b.name);
  });
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
  // Category buttons are driven by the active category records.
  const [catalogView, setCatalogView] = useState<'photo' | 'compact'>('photo');
  const isTouch = useSyncExternalStore(subscribeCoarsePointer, getCoarsePointer, () => false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const gridScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
        if (Array.isArray(saved) && saved.length) {
          setFavorites(saved.map(String));
          setFavoritesOnly(true);
        }
      } catch {}
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const handleTyping = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement &&
          target.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="alertdialog"]')) return;
      // The cashier may have clicked a category, product, or empty part of the
      // register; all should support typing without requiring a search click.
      // Do not steal keystrokes from other app screens or modal dialogs.
      if (!document.querySelector('[data-testid="pos-product-grid"]')) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (event.key === 'Escape') {
        if (search) { event.preventDefault(); setSearch(''); }
        return;
      }
      if (event.key.length !== 1 || !/^[\p{L}\p{N} ]$/u.test(event.key)) return;
      event.preventDefault();
      setSearch(search + event.key);
      searchInputRef.current?.focus();
    };
    document.addEventListener('keydown', handleTyping);
    return () => document.removeEventListener('keydown', handleTyping);
  }, [search, setSearch]);

  const searchBlock = (
    <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            inputMode={isTouch ? 'none' : undefined}
            onFocus={() => { if (isTouch) setKeyboardOpen(true); }}
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
            placeholder="Search products…"
            className="w-full ps-10 pe-10 py-2 bg-[#131d31] border border-[#1e293b] rounded-xl focus:border-brand focus:ring-2 focus:ring-brand/10 outline-none transition-colors text-sm shadow-sm"
          />
          {search && <button type="button" aria-label="Clear product search" onClick={() => setSearch('')} className="absolute end-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-blue-300 hover:text-white">Clear</button>}
        </div>
        <button type="button" aria-label={keyboardOpen ? 'Hide on-screen keyboard' : 'Show on-screen keyboard'} aria-pressed={keyboardOpen}
          onClick={() => setKeyboardOpen(v => !v)}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#1e293b] ${keyboardOpen ? 'bg-blue-600 text-white' : 'bg-[#131d31] text-slate-300 hover:bg-[#182234]'}`}><Keyboard size={20} /></button>
    </div>
  );

  return (
    <div data-testid="pos-product-grid" className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <div className="shrink-0 mb-2 px-3 pt-2">
        {!searchSlot && <div className="mb-2">{searchBlock}</div>}
        <div className="hidden">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Menu</span>
          {showProductImages && <button type="button" onClick={() => setShowMenuPhotos(v => !v)}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">
            {showMenuPhotos ? 'Compact cards' : 'Show photos'}
          </button>}
        </div>
        <nav aria-label="Menu categories" className="flex gap-2 overflow-x-auto py-1 mb-1">
          <button type="button" aria-pressed={favoritesOnly}
            onClick={() => { setFavoritesOnly(!favoritesOnly); setSelectedCategory(null); setSelectedSubcategory(null); setSearch(''); setArranging(false); }}
            className={`h-10 shrink-0 rounded-xl border border-white/10 px-3.5 text-xs font-bold text-white ${favoritesOnly ? 'ring-2 ring-white' : ''}`}
            style={{ backgroundColor: '#CA8A04' }}><Star size={16} className="inline me-1" />FAV</button>
          {visibleCategories.map(cat => {
            const selected = !favoritesOnly && selectedCategory === cat.id;
            return <button key={cat.id} type="button" aria-pressed={selected}
              onClick={() => {
                setFavoritesOnly(false);
                setSelectedCategory(selected ? null : cat.id);
                setSelectedSubcategory(null);
                setSearch('');
                setArranging(false);
              }}
              className={`h-10 shrink-0 rounded-xl border border-white/10 px-3.5 text-xs font-bold text-white transition-[filter,transform] active:scale-95 ${selected ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-[#0b0f17]' : 'hover:brightness-110'}`}
              style={{ backgroundColor: categoryColor(cat.color) }}><span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="text-base leading-none">{cat.icon || '▦'}</span>{cat.name}</span></button>;
          })}
        </nav>
        {selectedCategory && subcategoryNames.length > 0 && !favoritesOnly && (
          <nav aria-label="Menu subcategories" className="flex gap-2 overflow-x-auto py-1">
            {['All', ...subcategoryNames].map(name => {
              const active = name === 'All' ? !selectedSubcategory : selectedSubcategory === name;
              return <button key={name} type="button" aria-pressed={active}
                onClick={() => { setSelectedSubcategory(name === 'All' ? null : name); setArranging(false); }}
                className={`h-9 shrink-0 rounded-lg border px-3 text-xs font-semibold ${active ? 'border-blue-500 bg-blue-600 text-white' : 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'}`}>
                {name}
              </button>;
            })}
          </nav>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
      <div ref={gridScrollRef} className="min-w-0 flex-1 overflow-y-auto pb-20 md:pb-0 px-3">
        {favoritesOnly && !search.trim() && displayed.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">No favorites yet. Tap ★ Favorites, then tap products to pin them here.</p>
        )}
        
        {<>
          <div className="flex items-center justify-between mb-2 gap-2">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold text-white tracking-tight">{selectedCategory && !search.trim() ? categories.find(c => c.id === selectedCategory)?.name || 'Items' : favoritesOnly ? 'Favorites' : 'All Products'}</h2>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-purple-950/60 border border-purple-500/40 text-purple-300">{displayed.length}</span>
              {!arranging && <span className="hidden lg:inline text-xs font-semibold text-slate-400">{editingFavorites ? 'Tap products to pin or unpin' : 'Tap to add · hold for options'}</span>}
            </div>
            <div className="flex items-center gap-2">
            {!arranging && (
              <button type="button" aria-pressed={editingFavorites} onClick={() => setEditingFavorites((on) => !on)}
                className={`h-10 rounded-xl border px-3 text-xs font-semibold ${editingFavorites ? 'border-amber-400 bg-amber-400 text-black' : 'border-[#1e293b] bg-[#131d31] text-slate-300 hover:bg-[#182234]'}`}>
                {editingFavorites ? 'Done' : '★ Favorites'}
              </button>
            )}
            {canArrange && (arranging ? (
              <>
                <button type="button" disabled={saving} onClick={() => setArranging(false)} className="h-10 rounded-xl border border-[#1e293b] bg-[#131d31] px-3 text-xs font-semibold text-slate-300 hover:bg-[#182234]">Cancel</button>
                <button type="button" disabled={saving} onClick={saveOrder} className="h-10 rounded-xl bg-emerald-600 px-3 text-xs font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save order'}</button>
              </>
            ) : (
              <button type="button" onClick={() => { setIds(ordered.map(p => String(p.id))); setArranging(true); }} className="h-10 rounded-xl border border-[#1e293b] bg-[#131d31] px-3 text-xs font-semibold text-slate-300 hover:bg-[#182234]">Arrange</button>
            ))}
            <div className="flex items-center bg-[#131d31] p-1 rounded-xl border border-[#1e293b] gap-1 shadow-sm">
              <button type="button" onClick={() => setCatalogView('photo')} className={`px-3 py-1.5 rounded-lg font-semibold text-xs ${catalogView === 'photo' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#182234]'}`}><LayoutGrid size={12} className="inline-block me-1.5 align-[-2px]" />Photo View</button>
              <button type="button" onClick={() => setCatalogView('compact')} className={`px-3 py-1.5 rounded-lg font-semibold text-xs ${catalogView === 'compact' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#182234]'}`}><Zap size={12} className="inline-block me-1.5 align-[-2px] text-amber-300 fill-amber-300" />Quick-Tap Grid</button>
            </div>
            </div>
          </div>
          <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 ${catalogView === 'photo' ? 'gap-2' : 'gap-1.5'} pb-8`}>
          {displayed.map((product) => {
            const inCartQty = cartQuantities.get(product.id) || 0;
            const categoryAccent = favoritesOnly ? '#CA8A04' : categoryColor(categories.find(c => c.id === selectedCategory)?.color ?? null)
              ?? '#2563EB';
            

            return (
              <div
                key={product.id}
                data-testid="pos-product-card"
                data-initial={product.name.trim().charAt(0).toUpperCase()}
                draggable={arranging}
                onDragStart={e => {setDragId(String(product.id));e.dataTransfer.effectAllowed='move';}}
                onDragOver={e => {if(arranging)e.preventDefault();}}
                onDrop={e => {e.preventDefault();if(!dragId)return;setIds(old=>{const next=[...old],a=next.indexOf(dragId),b=next.indexOf(String(product.id));if(a<0||b<0)return old;next.splice(a,1);next.splice(b,0,dragId);return next;});setDragId(null);}}
                onDragEnd={() => setDragId(null)}
                className="group pos-product-tile flex flex-col justify-between bg-[#182234] text-slate-100 rounded-2xl border-2 border-s-[7px] border-[#3d4f7c] shadow-sm active:scale-95 transition text-start relative cursor-pointer overflow-hidden touch-manipulation select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                style={{ borderInlineStartColor: categoryAccent }}

              >
                <button type="button" aria-label={editingFavorites ? `${favorites.includes(String(product.id)) ? 'Unpin' : 'Pin'} ${product.name}` : `Add ${product.name}`}
                  disabled={arranging}
                  onClick={() => tapProduct(product)}
                  onPointerDown={() => { if (!arranging && !editingFavorites) startPress(product); }}
                  onPointerUp={cancelPress}
                  onPointerLeave={cancelPress}
                  onPointerCancel={cancelPress}
                  onContextMenu={(event) => { event.preventDefault(); cancelPress(); if (!arranging) onProductClick(product); }}
                  className="absolute inset-0 z-0 w-full h-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl" />
                {inCartQty > 0 && <span data-testid="pos-product-qty" aria-label={`${inCartQty} in order`} className="pos-qty-badge pointer-events-none absolute -top-0.5 -end-0.5 z-[2] grid h-10 min-w-10 place-items-center rounded-se-xl rounded-es-xl px-2 text-xl font-black">{inCartQty}</span>}
                {(editingFavorites || favorites.includes(String(product.id))) && (
                  <Star aria-hidden size={18} className={`pointer-events-none absolute bottom-2.5 end-2.5 z-[2] ${favorites.includes(String(product.id)) ? 'fill-amber-400 text-amber-400' : 'text-slate-400'}`} />
                )}
                <div className={`pointer-events-none relative z-[1] ${catalogView === 'photo' ? 'p-2 min-h-0' : 'p-3 min-h-[104px]'} flex flex-col flex-1 justify-start`}><div className="mb-1 flex items-start justify-between gap-1 pe-10 empty:hidden">
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
                </div>

                {catalogView === 'photo' && (
                  <div className="w-full aspect-square mb-1 relative overflow-hidden bg-slate-900">
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
                    {product.has_image && (
                      <img
                        src={`${api.defaults.baseURL}/products/${product.id}/image?t=${product.updated_at ? parseDbTimestamp(product.updated_at).getTime() : 0}`}
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

                <h3 className={`${catalogView === 'photo' ? 'text-sm leading-[1.2] line-clamp-2' : 'text-[18px] leading-[1.18] line-clamp-3'} font-extrabold tracking-[-0.01em] text-slate-100 break-words ${inCartQty > 0 ? 'pe-9' : ''}`}>{product.name}</h3>
                {product.special_normal_price != null && product.special_show ? (
                  <p className="mt-auto pt-1 tabular-nums"><span className="me-1.5 text-sm font-semibold text-slate-400 line-through">{fmt(product.special_normal_price)}</span><span className="text-[18px] font-extrabold text-amber-300">{fmt(Number(product.price))}</span><span className="block truncate text-[11px] font-bold uppercase tracking-wide text-amber-300">{product.special_event}</span></p>
                ) : (
                  <p className="mt-auto pt-1 text-[18px] font-extrabold text-blue-400 tabular-nums">{fmt(Number(product.price))}</p>
                )}
                </div>
              </div>
            );
          })}
          </div></>}
      </div>
      {!arranging && !search.trim() && displayed.length > 24 && (
        <div aria-label="Jump to letter" className="flex w-9 shrink-0 flex-col justify-between py-1">
          {Array.from(new Set(displayed.map(p => p.name.trim().charAt(0).toUpperCase()))).map(letter => (
            <button key={letter} type="button"
              onClick={() => gridScrollRef.current?.querySelector(`[data-initial="${letter}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
              className="flex min-h-0 flex-1 items-center justify-center text-xs font-bold text-slate-400 hover:text-white active:text-blue-400 touch-manipulation">{letter}</button>
          ))}
        </div>
      )}
      </div>
      {searchSlot && createPortal(searchBlock, searchSlot)}
      {keyboardOpen && <OnScreenKeyboard value={search} onChange={setSearch} onClose={() => setKeyboardOpen(false)} />}
    </div>
  );
}
