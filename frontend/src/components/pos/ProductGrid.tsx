'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import toast from 'react-hot-toast';
import { Plus, Search, Keyboard, SlidersHorizontal, Star, UtensilsCrossed, Martini, Wine, Beer, Coffee, Zap, LayoutGrid } from 'lucide-react';
import type { Category, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { nameToColor } from '@/lib/image-utils';
import { genericMenuPhoto } from '@/lib/generic-menu-photos';
import TagBadge from './DietaryBadge';
import OnScreenKeyboard from './OnScreenKeyboard';
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

const FAVORITES_KEY = 'pos-favorite-products';
const SUBCATEGORY_LIMIT = 8;

const subscribeCoarsePointer = (callback: () => void) => {
  const query = window.matchMedia('(pointer: coarse)');
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
};
const getCoarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

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
  onQuickAdd: (product: Product) => void;
  sidebarOpen?: boolean;
  canArrange?: boolean;
  onOrderSaved?: () => Promise<void>;
}

export default function ProductGrid({
  categories, products, selectedCategory, setSelectedCategory,
  search, setSearch, onProductClick, onQuickAdd, sidebarOpen = true, canArrange = false, onOrderSaved,
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

  // UI-only grouping: preserve original categories, products, and database.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const toggleFavorite = (id: string) => setFavorites(prev => {
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch {}
    return next;
  });
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
    // No selected category means show the entire menu.
    if (!activeGroup && !search.trim()) return true;
    const matchCat = burgerFilterSelected ? /burger/i.test(p.name)
      : selectedCategory ? p.category_id === selectedCategory
      : activeGroup === 'Favorites' ? favorites.includes(String(p.id))
      : activeGroup ? children.some((cat) => cat.id === p.category_id) : true;
    // Search only within the selected category or subcategory.
    // With no category selected, matchCat is true and search covers the full menu.
    return matchCat && menuSearchScore(p.name, search) > 0;
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
  // VeloxPOS category-pill styling; retain FloPOS group IDs and filtering.
  const referenceCategories = [
    { label: 'Favorites', group: 'Favorites', filter: null, color: '#CA8A04', Icon: Star },
    { label: 'Beer', group: 'Beer & Wine', filter: /beer/i, color: '#F59E0B', Icon: Beer },
    { label: 'Wine', group: 'Beer & Wine', filter: /wine/i, color: '#DC2626', Icon: Wine },
    { label: 'Cocktails', group: 'Cocktails', filter: null, color: '#2563EB', Icon: Martini },
    { label: 'Spirits', group: 'Spirits', filter: null, color: '#0284C7', Icon: Coffee },
    { label: 'Food', group: 'Food', filter: null, color: '#16A34A', Icon: UtensilsCrossed },
    { label: 'Drinks', group: 'Non-Alcoholic', filter: null, color: '#EA580C', Icon: Coffee },
  ] as const;
  const [referenceCategory, setReferenceCategory] = useState<string | null>(null);
  const [catalogView, setCatalogView] = useState<'photo' | 'compact'>('compact');
  const isTouch = useSyncExternalStore(subscribeCoarsePointer, getCoarsePointer, () => false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [showAllSubcategories, setShowAllSubcategories] = useState(false);
  const gridScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
        if (Array.isArray(saved) && saved.length) {
          setFavorites(saved.map(String));
          setReferenceCategory('Favorites');
          setOpenGroup('Favorites');
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

  return (
    <div data-testid="pos-product-grid" className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <div className="shrink-0 mb-2 px-3 pt-2">
        <div className="mb-2 flex items-center gap-2">
        <div role="group" aria-label="Order type" className="flex shrink-0 rounded-xl border border-[#1e293b] bg-[#131d31] p-1">
          {([['dine_in', 'Dine-in'], ['takeaway', 'Takeaway']] as const).map(([type, label]) => (
            <button key={type} type="button" aria-pressed={cart.orderType === type}
              onClick={() => cart.setOrderType(type)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${cart.orderType === type ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#182234]'}`}>{label}</button>
          ))}
        </div>
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
          {search && <button type="button" aria-label="Clear product search" onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-blue-300 hover:text-white">Clear</button>}
        </div>
        <button type="button" aria-label={keyboardOpen ? 'Hide on-screen keyboard' : 'Show on-screen keyboard'} aria-pressed={keyboardOpen}
          onClick={() => setKeyboardOpen(v => !v)}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#1e293b] ${keyboardOpen ? 'bg-blue-600 text-white' : 'bg-[#131d31] text-slate-300 hover:bg-[#182234]'}`}><Keyboard size={20} /></button>
        </div>
        <div className="hidden">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Menu</span>
          {showProductImages && <button type="button" onClick={() => setShowMenuPhotos(v => !v)}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">
            {showMenuPhotos ? 'Compact cards' : 'Show photos'}
          </button>}
        </div>
        <nav aria-label="Menu categories" className="flex gap-2 overflow-x-auto py-1 mb-1">
          {referenceCategories.map(({ label, group, filter, color, Icon }) => {
            const selected = referenceCategory === label;
            return <button key={label} type="button" aria-pressed={selected}
              onClick={() => {
                setReferenceCategory(selected ? null : label);
                setSearch('');
                setOpenGroup(selected ? null : group);
                setSelectedCategory(selected ? null : (filter ? (groups.get(group) ?? []).find(c => filter.test(c.name))?.id ?? null : null));
                setArranging(false);
              }}
              className={`group relative h-10 shrink-0 rounded-xl overflow-hidden border border-white/10 shadow-[inset_0_-2px_0_rgba(0,0,0,0.20)] flex flex-row items-center justify-center gap-1.5 px-3.5 transition-[filter,transform] active:scale-95 text-white ${selected ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-[#0b0f17] brightness-110' : 'hover:brightness-110'}`}
              style={{ backgroundColor: color }}>
              <Icon size={18} strokeWidth={2} className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.3)]" />
              <span className={`font-bold text-xs tracking-wide text-white drop-shadow ${selected ? 'font-black' : ''}`}>{label}</span>
            </button>;
          })}
        </nav>
        {activeGroup && activeGroup !== 'Favorites' && (
          (() => {
            const subcategories = [
              ...(showVirtualBurgers ? [{ id: '__virtual_burgers__', name: 'Burgers' }] : []),
              ...children.map(cat => ({ id: cat.id, name: activeGroup === 'Cocktails' ? cat.name.replace(/\\s+Cocktails?$/i, '') : cat.name.replace(/^Spirits\s*[—–-]\s*/i, '') })),
            ];
            const selectedIndex = subcategories.findIndex(cat => cat.id === selectedCategory);
            const collapsible = subcategories.length > SUBCATEGORY_LIMIT;
            const expanded = showAllSubcategories || selectedIndex >= SUBCATEGORY_LIMIT;
            const visible = collapsible && !expanded ? subcategories.slice(0, SUBCATEGORY_LIMIT) : subcategories;
            const pill = (active: boolean) => `h-11 shrink-0 rounded-xl border px-4 text-sm font-semibold touch-manipulation ${active ? 'border-brand bg-brand/10 text-brand' : 'border-border bg-card hover:bg-muted'}`;
            return (
              <nav aria-label="Menu subcategories" className="flex flex-wrap gap-2 py-1">
                <button type="button" onClick={() => setSelectedCategory(null)} className={pill(!selectedCategory)}>All {activeGroup}</button>
                {visible.map(cat => <button key={cat.id} type="button" onClick={() => setSelectedCategory(cat.id)} className={pill(selectedCategory === cat.id)}>{cat.name}</button>)}
                {collapsible && selectedIndex < SUBCATEGORY_LIMIT && (
                  <button type="button" onClick={() => setShowAllSubcategories(v => !v)} className={pill(false)}>{expanded ? 'Less ▴' : `More (${subcategories.length - SUBCATEGORY_LIMIT}) ▾`}</button>
                )}
              </nav>
            );
          })()
        )}
      </div>

      <div className="flex min-h-0 flex-1">
      <div ref={gridScrollRef} className="min-w-0 flex-1 overflow-y-auto pb-20 md:pb-0 px-3">
        {activeGroup === 'Favorites' && !search.trim() && displayed.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">No favorites yet. Tap the ☆ on any product to pin it here.</p>
        )}
        
        {<>
          <div className="flex items-center justify-between mb-2 gap-2">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold text-white tracking-tight">{selectedCategory && !search.trim() ? categories.find(c => c.id === selectedCategory)?.name || 'Items' : referenceCategory || activeGroup || 'All Products'}</h2>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-purple-950/60 border border-purple-500/40 text-purple-300">{displayed.length}</span>
            </div>
            <div className="flex items-center bg-[#131d31] p-1 rounded-xl border border-[#1e293b] gap-1 shadow-sm">
              <button type="button" onClick={() => setCatalogView('photo')} className={`px-3 py-1.5 rounded-lg font-semibold text-xs ${catalogView === 'photo' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#182234]'}`}><LayoutGrid size={12} className="inline-block mr-1.5 align-[-2px]" />Photo View</button>
              <button type="button" onClick={() => setCatalogView('compact')} className={`px-3 py-1.5 rounded-lg font-semibold text-xs ${catalogView === 'compact' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#182234]'}`}><Zap size={12} className="inline-block mr-1.5 align-[-2px] text-amber-300 fill-amber-300" />Quick-Tap Grid</button>
            </div>
          </div>
          <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 ${catalogView === 'photo' ? 'gap-2' : 'gap-1.5'} pb-8`}>
          {displayed.map((product) => {
            const inCartQty = cartQuantities.get(product.id) || 0;
            const categoryAccent = referenceCategories.find(c => c.label === referenceCategory)?.color
              ?? referenceCategories.find(c => c.group === activeGroup)?.color
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
                className={`group flex flex-col justify-between bg-[#182234] text-slate-100 rounded-xl border border-[#1e293b] ${catalogView === 'compact' ? 'border-l-4' : ''} hover:border-[#334155] shadow-sm hover:shadow-lg active:scale-95 transition text-start relative cursor-pointer overflow-hidden touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
                style={catalogView === 'compact' ? { borderLeftColor: categoryAccent } : undefined}

              >
                <button type="button" aria-label={`Edit ${product.name}`}
                  onClick={() => { if (!arranging) onProductClick(product); }}
                  className="absolute inset-0 z-0 w-full h-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl" />
                <div className="pointer-events-none relative z-[1] p-2.5 min-h-[84px] flex flex-col flex-1 justify-between"><div className="mb-1 flex items-start justify-between gap-1 empty:hidden">
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

                {catalogView === 'photo' && (
                  <div className="w-full aspect-[1.3] mb-1 relative overflow-hidden bg-slate-900">
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

                <h3 className="font-bold text-[13px] text-slate-100 leading-snug line-clamp-2 min-h-[2.4em] break-words">{product.name}</h3>
                <div className="flex items-center justify-between mt-1 pt-1 border-t border-[#1e293b]/60">
                  <p className="font-bold text-xs text-blue-400">{fmt(Number(product.price))}</p>
                  <div className="flex items-center gap-1">
                  <button type="button" aria-label={favorites.includes(String(product.id)) ? `Remove ${product.name} from favorites` : `Add ${product.name} to favorites`}
                    aria-pressed={favorites.includes(String(product.id))}
                    onClick={(event) => { event.stopPropagation(); toggleFavorite(String(product.id)); }}
                    className="pointer-events-auto relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-slate-500 hover:text-amber-300 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><Star size={15} className={favorites.includes(String(product.id)) ? 'fill-amber-400 text-amber-400' : ''} /></button>
                  <button type="button" aria-label={`Quick add ${product.name}`}
                    disabled={arranging}
                    onClick={(event) => { event.stopPropagation(); onQuickAdd(product); }}
                    className="pointer-events-auto relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-600/20 text-blue-400 hover:bg-blue-600 hover:text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><Plus size={16} /></button>
                  </div>
                </div></div>
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
      {keyboardOpen && <OnScreenKeyboard value={search} onChange={setSearch} onClose={() => setKeyboardOpen(false)} />}
    </div>
  );
}
