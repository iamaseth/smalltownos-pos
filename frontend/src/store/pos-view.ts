import { create } from 'zustand';

type CatalogView = 'photo' | 'compact';
/** BackStreet: 'popular' = best sellers of the last 30 days first (weekly); 'manual' = the Arrange order. */
export type MenuOrder = 'popular' | 'manual';

function readSaved<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

interface PosViewState {
  catalogView: CatalogView;
  menuOrder: MenuOrder;
  editingFavorites: boolean;
  arranging: boolean;
  subcategoriesOpen: boolean;
  setCatalogView: (view: CatalogView) => void;
  setMenuOrder: (order: MenuOrder) => void;
  setEditingFavorites: (on: boolean) => void;
  setArranging: (on: boolean) => void;
  setSubcategoriesOpen: (open: boolean) => void;
}

/** POS screen view choices shared between the Actions menu and the product grid. */
export const usePosViewStore = create<PosViewState>((set) => ({
  catalogView: readSaved('pos.catalogView', ['photo', 'compact'] as const, 'photo'),
  menuOrder: readSaved('pos.menuOrder', ['popular', 'manual'] as const, 'popular'),
  editingFavorites: false,
  arranging: false,
  subcategoriesOpen: readSaved('pos.subcategoriesOpen', ['open', 'closed'] as const, 'open') === 'open',
  setCatalogView: (catalogView) => { save('pos.catalogView', catalogView); set({ catalogView }); },
  setMenuOrder: (menuOrder) => { save('pos.menuOrder', menuOrder); set({ menuOrder }); },
  setEditingFavorites: (editingFavorites) => set({ editingFavorites, ...(editingFavorites && { arranging: false }) }),
  setArranging: (arranging) => set({ arranging, ...(arranging && { editingFavorites: false }) }),
  setSubcategoriesOpen: (subcategoriesOpen) => { save('pos.subcategoriesOpen', subcategoriesOpen ? 'open' : 'closed'); set({ subcategoriesOpen }); },
}));
