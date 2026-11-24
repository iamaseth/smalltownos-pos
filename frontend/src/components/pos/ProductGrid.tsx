'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import toast from 'react-hot-toast';
import { Search, Keyboard, X, Star, ChevronUp, ChevronDown, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { Category, Product } from '@/lib/types';
import { usePosViewStore } from '@/store/pos-view';
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
const SUB_PALETTE = [
  { edge: '#BA7517', soft: '#FAEEDA', ink: '#633806' },
  { edge: '#185FA5', soft: '#E6F1FB', ink: '#0C447C' },
  { edge: '#0F6E56', soft: '#E1F5EE', ink: '#085041' },
  { edge: '#993C1D', soft: '#FAECE7', ink: '#712B13' },
  { edge: '#534AB7', soft: '#EEEDFE', ink: '#3C3489' },
  { edge: '#993556', soft: '#FBEAF0', ink: '#72243E' },
  { edge: '#3B6D11', soft: '#EAF3DE', ink: '#27500A' },
  { edge: '#A32D2D', soft: '#FCEBEB', ink: '#791F1F' },
  { edge: '#5F5E5A', soft: '#F1EFE8', ink: '#2C2C2A' },
  { edge: '#0C447C', soft: '#B5D4F4', ink: '#042C53' },
] as const;
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
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  canArrange?: boolean;
  onOrderSaved?: () => Promise<void>;
}

const LONG_PRESS_MS = 700;
const MOVE_TOLERANCE_PX = 8;

export default function ProductGrid({
  categories, products, selectedCategory, setSelectedCategory,
  search, setSearch, onProductClick, onQuickAdd, canArrange = false, onOrderSaved, searchOpen, setSearchOpen,
}: Props) {
  const cart = useCartStore();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { arranging, setArranging, editingFavorites, setEditingFavorites, catalogView, subcategoriesOpen, setSubcategoriesOpen } = usePosViewStore();
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
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const movedDuringPress = useRef(false);
  const startPress = (product: Product, point: { x: number; y: number }) => {
    longPressed.current = false;
    movedDuringPress.current = false;
    pressStart.current = point;
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => { longPressed.current = true; onProductClick(product); }, LONG_PRESS_MS);
  };
  const cancelPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const trackPress = (point: { x: number; y: number }) => {
    const start = pressStart.current;
    if (!start || movedDuringPress.current) return;
    if (Math.abs(point.x - start.x) > MOVE_TOLERANCE_PX || Math.abs(point.y - start.y) > MOVE_TOLERANCE_PX) {
      movedDuringPress.current = true;
      cancelPress();
    }
  };
  const tapProduct = (product: Product) => {
    cancelPress();
    pressStart.current = null;
    if (longPressed.current) { longPressed.current = false; return; }
    if (movedDuringPress.current) { movedDuringPress.current = false; return; }
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
  const subStyle = (name: string) => {
    const tone = SUB_PALETTE[Math.max(0, subcategoryNames.indexOf(name as never)) % SUB_PALETTE.length];
    const icon = childCategories.find(c => c.name === name)?.icon || (spiritVirtualGroups ? '🥃' : '');
    return { ...tone, icon };
  };
  const subTrees = childCategories.map(c => ({ name: c.name, tree: categoryTreeIds(c.id) }));
  const productSub = (p: Product): string | null => {
    if (!selectedCategory || favoritesOnly || subcategoryNames.length === 0) return null;
    if (spiritVirtualGroups) return spiritGroup(p.name);
    return subTrees.find(t => t.tree.has(String(p.category_id)))?.name ?? null;
  };

  const selectedCategoryTree = selectedCategory ? categoryTreeIds(selectedCategory) : null;
  const selectedSubcategoryTree = subcategoryId ? categoryTreeIds(subcategoryId) : null;
  const filtered = products.filter((p) => {
    if (!hasActiveCategoryPath(p.category_id)) return false;
    const matchCat = favoritesOnly ? favorites.includes(String(p.id))
      : selectedCategory ? selectedCategoryTree?.has(String(p.category_id)) === true : true;
    const matchSub = !selectedSubcategory ? true
      : spiritVirtualGroups ? spiritGroup(p.name) === selectedSubcategory
      : selectedSubcategoryTree?.has(String(p.category_id)) === true;
    return matchCat && matchSub;
  });
  const ordered = [...filtered].sort((a,b) => {
    return (a.sort_order ?? 0)-(b.sort_order ?? 0) || a.name.localeCompare(b.name);
  });
  const displayed = arranging && ids.length > 0 ? [...ordered].sort((a,b) => ids.indexOf(String(a.id))-ids.indexOf(String(b.id))) : ordered;
  const saveOrder = async () => {
    setSaving(true);
    try {
      const base = Math.max(0,...products.map(p => p.sort_order || 0)) + 1;
      for (let i=0;i<ids.length;i++) await api.put('/products/'+ids[i], {sort_order:base+i});
      setIds([]);
      await onOrderSaved?.();
      setArranging(false);
      toast.success('Menu order saved');
    } catch { toast.error('Could not save order. Refresh and retry.'); }
    finally { setSaving(false); }
  };
  // Category buttons are driven by the active category records.
  const isTouch = useSyncExternalStore(subscribeCoarsePointer, getCoarsePointer, () => false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const subListRef = useRef<HTMLDivElement>(null);

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
      if (event.key.length !== 1 || !/^[\p{L}\p{N} ]$/u.test(event.key)) return;
      if (event.key === ' ' && !search) return;
      event.preventDefault();
      setSearch(search + event.key);
      setSearchOpen(true);
    };
    document.addEventListener('keydown', handleTyping);
    return () => document.removeEventListener('keydown', handleTyping);
  }, [search, setSearch, setSearchOpen]);

  const query = search.trim();
  const searchResults = query
    ? products
      .filter(p => hasActiveCategoryPath(p.category_id) && menuSearchScore(p.name, query) > 0)
      .sort((a, b) => menuSearchScore(b.name, query) - menuSearchScore(a.name, query) || a.name.localeCompare(b.name))
      .slice(0, 40)
    : [];
  const closeSearch = () => { setSearchOpen(false); setSearch(''); setKeyboardOpen(false); };
  const pickResult = (product: Product) => { closeSearch(); onProductClick(product); };

  const searchOverlay = searchOpen && (
    <div role="dialog" aria-modal="true" aria-label="Search menu" data-testid="pos-search-overlay"
      className="fixed inset-0 z-[45] flex items-start justify-center bg-black/50 p-4 pt-[8vh]"
      onClick={(e) => { if (e.target === e.currentTarget) closeSearch(); }}>
      <div className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-2xl border border-border bg-card p-4 text-foreground shadow-2xl">
        <div className="flex items-center gap-3 rounded-xl border-2 border-blue-500 px-3 py-2">
          <Search size={26} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            autoFocus
            type="text"
            inputMode={isTouch ? 'none' : undefined}
            onFocus={() => { if (isTouch) setKeyboardOpen(true); }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return; }
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (!query) return;
              const match = resolveScannedProduct(query, products);
              if (match) {
                closeSearch();
                if (match.scaleBarcode) cart.addItem(match.product, match.quantity);
                else onProductClick(match.product);
              } else if (searchResults[0]) pickResult(searchResults[0]);
            }}
            aria-label="Search the whole menu"
            placeholder="Type to search"
            className="min-w-0 flex-1 bg-transparent text-4xl font-bold uppercase tracking-[0.2em] outline-none placeholder:text-xl placeholder:font-normal placeholder:normal-case placeholder:tracking-normal"
          />
          <button type="button" aria-label="Close search" onClick={closeSearch} className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted"><X size={26} /></button>
        </div>
        <div className="mt-2 flex items-center justify-between text-sm text-muted-foreground">
          <span>{query ? `${searchResults.length}${searchResults.length === 40 ? '+' : ''} items · tap to add · Esc to close` : 'Whole menu · Esc to close'}</span>
          {isTouch && <button type="button" aria-label={keyboardOpen ? 'Hide on-screen keyboard' : 'Show on-screen keyboard'} onClick={() => setKeyboardOpen(v => !v)} className="flex size-9 items-center justify-center rounded-lg border border-border"><Keyboard size={18} /></button>}
        </div>
        <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain">
          {query && searchResults.length === 0 && <p className="py-8 text-center text-base text-muted-foreground">No items found</p>}
          {searchResults.map(product => (
            <button key={product.id} type="button" data-testid="pos-search-result" onClick={() => pickResult(product)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-start text-lg font-semibold hover:bg-muted active:scale-[0.99]">
              <span className="min-w-0 truncate">{product.name}</span>
              <span className="shrink-0 tabular-nums">{fmt(Number(product.price))}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div data-testid="pos-product-grid" className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <div className="shrink-0 mb-2 px-3 pt-2">
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
          <nav aria-label="Subcategory buttons" className="flex gap-2 overflow-x-auto py-1">
            {['All', ...subcategoryNames].map(name => {
              const active = name === 'All' ? !selectedSubcategory : selectedSubcategory === name;
              const tone = name === 'All' ? null : subStyle(name);
              return <button key={name} type="button" aria-pressed={active}
                onClick={() => { setSelectedSubcategory(name === 'All' ? null : name); setArranging(false); }}
                style={tone ? { borderColor: tone.edge, backgroundColor: active ? tone.edge : tone.soft, color: active ? '#ffffff' : tone.ink } : undefined}
                className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border-2 px-3 text-sm font-bold ${tone ? '' : active ? 'border-blue-500 bg-blue-600 text-white' : 'border-border bg-card text-foreground hover:bg-muted'}`}>
                {tone?.icon && <span aria-hidden className="text-base leading-none">{tone.icon}</span>}{name}
              </button>;
            })}
          </nav>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
      <div ref={gridScrollRef} onScroll={() => { if (pressTimer.current) { movedDuringPress.current = true; cancelPress(); } }} className="min-w-0 flex-1 overflow-y-auto overscroll-contain pb-20 md:pb-0 px-3">
        {favoritesOnly && displayed.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">No favorites yet. Tap ★ Favorites, then tap products to pin them here.</p>
        )}
        
        {<>
          {(editingFavorites || (canArrange && arranging)) && <div className="flex items-center justify-between mb-2 gap-2">
            <div className="flex items-center gap-3">
              {editingFavorites && <span className="hidden lg:inline text-xs font-semibold text-slate-400">Tap products to pin or unpin</span>}
            </div>
            <div className="flex items-center gap-2">
            {editingFavorites && (
              <button type="button" onClick={() => setEditingFavorites(false)} className="h-10 rounded-xl border border-amber-400 bg-amber-400 px-4 text-xs font-bold text-black">Done</button>
            )}
            {canArrange && arranging && (
              <>
                <button type="button" disabled={saving} onClick={() => { setIds([]); setArranging(false); }} className="h-10 rounded-xl border border-[#1e293b] bg-[#131d31] px-3 text-xs font-semibold text-slate-300 hover:bg-[#182234]">Cancel</button>
                <button type="button" disabled={saving || ids.length === 0} onClick={saveOrder} className="h-10 rounded-xl bg-emerald-600 px-3 text-xs font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save order'}</button>
              </>
            )}
            </div>
          </div>}
          <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 ${catalogView === 'photo' ? 'gap-2' : 'gap-1.5'} pb-8`}>
          {displayed.map((product) => {
            const inCartQty = cartQuantities.get(product.id) || 0;
            const sub = productSub(product);
            const subTone = sub ? subStyle(sub) : null;
            const categoryAccent = subTone?.edge ?? (favoritesOnly ? '#CA8A04' : categoryColor(categories.find(c => c.id === selectedCategory)?.color ?? null)
              ?? '#2563EB');
            

            return (
              <div
                key={product.id}
                data-testid="pos-product-card"
                data-initial={product.name.trim().charAt(0).toUpperCase()}
                draggable={arranging}
                onDragStart={e => {setDragId(String(product.id));e.dataTransfer.effectAllowed='move';}}
                onDragOver={e => {if(arranging)e.preventDefault();}}
                onDrop={e => {e.preventDefault();if(!dragId)return;setIds(old=>{const next=old.length ? [...old] : ordered.map(p => String(p.id)),a=next.indexOf(dragId),b=next.indexOf(String(product.id));if(a<0||b<0)return old;next.splice(a,1);next.splice(b,0,dragId);return next;});setDragId(null);}}
                onDragEnd={() => setDragId(null)}
                className="group pos-product-tile flex flex-col justify-between bg-[#182234] text-slate-100 rounded-2xl border-2 border-s-[7px] border-[#3d4f7c] shadow-sm active:scale-95 transition text-start relative cursor-pointer overflow-hidden touch-manipulation select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                style={{ borderInlineStartColor: categoryAccent, contentVisibility: 'auto', containIntrinsicSize: 'auto 220px' }}

              >
                <button type="button" aria-label={editingFavorites ? `${favorites.includes(String(product.id)) ? 'Unpin' : 'Pin'} ${product.name}` : `Add ${product.name}`}
                  disabled={arranging}
                  onClick={() => tapProduct(product)}
                  onPointerDown={(e) => { if (!arranging && !editingFavorites) startPress(product, { x: e.clientX, y: e.clientY }); }}
                  onPointerMove={(e) => trackPress({ x: e.clientX, y: e.clientY })}
                  onPointerUp={cancelPress}
                  onPointerLeave={cancelPress}
                  onPointerCancel={cancelPress}
                  onContextMenu={(event) => { event.preventDefault(); cancelPress(); if (!arranging) onProductClick(product); }}
                  className="absolute inset-0 z-0 w-full h-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl" />
                {inCartQty > 0 && <span data-testid="pos-product-qty" aria-label={`${inCartQty} in order`} className={`pos-qty-badge pointer-events-none absolute -top-0.5 z-[12] grid h-10 min-w-10 place-items-center px-2 text-xl font-black ${catalogView === 'photo' ? '-start-0.5 rounded-ss-xl rounded-ee-xl' : '-end-0.5 rounded-se-xl rounded-es-xl'}`}>{inCartQty}</span>}
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
                    <span data-testid="pos-product-price" style={{ color: product.special_normal_price != null && product.special_show ? '#993C1D' : '#000000', backgroundColor: '#ffffff' }} className="absolute top-1.5 end-1.5 z-10 rounded-md px-1.5 py-0.5 text-base font-black leading-tight tabular-nums shadow-md">
                      {product.special_normal_price != null && product.special_show && <span className="me-1 text-[11px] font-bold line-through opacity-80">{fmt(product.special_normal_price)}</span>}
                      {fmt(Number(product.price))}
                    </span>
                  </div>
                )}

                <h3 className={`${catalogView === 'photo' ? 'text-sm leading-[1.2] line-clamp-2' : 'text-[18px] leading-[1.18] line-clamp-3'} font-extrabold tracking-[-0.01em] text-slate-100 break-words ${inCartQty > 0 && catalogView !== 'photo' ? 'pe-9' : ''}`}>{product.name}</h3>
                {catalogView === 'photo' ? (
                  product.special_normal_price != null && product.special_show && <span className="truncate text-[11px] font-bold uppercase tracking-wide text-orange-600">{product.special_event}</span>
                ) : product.special_normal_price != null && product.special_show ? (
                  <p className="mt-auto pt-1 tabular-nums"><span className="me-1.5 text-sm font-semibold text-slate-400 line-through">{fmt(product.special_normal_price)}</span><span className="text-[18px] font-extrabold text-orange-600">{fmt(Number(product.price))}</span><span className="block truncate text-[11px] font-bold uppercase tracking-wide text-orange-600">{product.special_event}</span></p>
                ) : (
                  <p className="mt-auto pt-1 text-[18px] font-extrabold text-blue-400 tabular-nums">{fmt(Number(product.price))}</p>
                )}
                </div>
              </div>
            );
          })}
          </div></>}
      </div>
      {selectedCategory && subcategoryNames.length > 0 && !favoritesOnly && !search.trim() && (
        <div className="relative flex shrink-0">
          <button type="button" aria-label={subcategoriesOpen ? 'Hide subcategories' : 'Show subcategories'} aria-expanded={subcategoriesOpen}
            onClick={() => setSubcategoriesOpen(!subcategoriesOpen)}
            className="absolute start-0 top-1/2 z-10 flex h-24 w-9 -translate-x-full -translate-y-1/2 items-center justify-center rounded-s-xl bg-blue-600 text-white shadow-lg hover:bg-blue-500 rtl:translate-x-full">
            {subcategoriesOpen ? <ChevronsRight size={26} /> : <ChevronsLeft size={26} />}
          </button>
          {subcategoriesOpen && (
            <nav aria-label="Menu subcategories" className="flex w-48 flex-col border-s-2 border-blue-600 bg-card">
              <button type="button" aria-label="Scroll subcategories up" onClick={() => subListRef.current?.scrollBy({ top: -200, behavior: 'smooth' })} className="flex h-11 shrink-0 items-center justify-center border-b border-border text-foreground hover:bg-muted"><ChevronUp size={26} /></button>
              <div ref={subListRef} tabIndex={0} aria-label="Subcategory list"
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  const names: (string | null)[] = [null, ...subcategoryNames];
                  const at = names.indexOf(selectedSubcategory ?? null);
                  const next = names[Math.min(names.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
                  setSelectedSubcategory(next); setArranging(false);
                  subListRef.current?.querySelector(`[data-sub="${next ?? '__all__'}"]`)?.scrollIntoView({ block: 'nearest' });
                }}
                className="min-h-0 flex-1 overflow-y-auto outline-none">
                {['All', ...subcategoryNames].map(name => {
                  const active = name === 'All' ? !selectedSubcategory : selectedSubcategory === name;
                  const tone = name === 'All' ? null : subStyle(name);
                  return <button key={name} type="button" data-sub={name === 'All' ? '__all__' : name} aria-pressed={active}
                    onClick={() => { setSelectedSubcategory(name === 'All' ? null : name); setArranging(false); }}
                    style={tone ? { borderInlineStartColor: tone.edge, ...(active && { backgroundColor: tone.soft, color: tone.ink }) } : undefined}
                    className={`flex min-h-16 w-full items-center gap-2.5 border-b border-s-[7px] border-b-border px-3 py-2 text-start text-base font-extrabold uppercase leading-tight ${tone ? '' : 'border-s-transparent'} ${active ? (tone ? 'ring-2 ring-inset ring-current' : 'bg-blue-600 text-white') : 'text-foreground hover:bg-muted'}`}>
                    {tone?.icon && <span aria-hidden className="text-2xl leading-none">{tone.icon}</span>}
                    <span className="min-w-0 flex-1 break-words">{name === 'All' ? `All ${categories.find(c => c.id === selectedCategory)?.name ?? ''}`.trim() : name}</span>
                  </button>;
                })}
              </div>
              <button type="button" aria-label="Scroll subcategories down" onClick={() => subListRef.current?.scrollBy({ top: 200, behavior: 'smooth' })} className="flex h-11 shrink-0 items-center justify-center border-t border-border text-foreground hover:bg-muted"><ChevronDown size={26} /></button>
            </nav>
          )}
        </div>
      )}
      </div>
      {searchOverlay}
      {keyboardOpen && <OnScreenKeyboard value={search} onChange={setSearch} onClose={() => setKeyboardOpen(false)} />}
    </div>
  );
}
