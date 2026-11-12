'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '@/lib/api';
import { genericMenuPhoto } from '@/lib/generic-menu-photos';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import toast from 'react-hot-toast';
import { Plus, Search, X, Edit, Trash2, Check, ArrowDownCircle, ArrowUpCircle, PackageMinus, ClipboardList, Scale, Truck, Upload, Sparkles, Printer, Download, Camera, SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { tenantCan } from '@/lib/permissions';
import ImageUploader from '@/components/products/ImageUploader';
import { compressImage } from '@/lib/image-utils';

const SUPPLY_UNITS = ['each', 'g', 'kg', 'ml', 'l'] as const;
type SupplyUnit = (typeof SUPPLY_UNITS)[number];

interface Supply {
  id: string;
  name: string;
  base_unit: SupplyUnit;
  stock_quantity: number;
  low_stock_threshold: number | null;
  unit_cost: number | null;
  pack_size: number | null;
  pack_label: string | null;
  pour_size: number | null;
  order_up_to: number | null;
  vendor_id: string | null;
  group_name: string | null;
  is_active: number;
  is_low_stock?: number;
}

interface Vendor {
  id: string;
  name: string;
}

interface OrderListItem {
  supply_id: string;
  name: string;
  base_unit: SupplyUnit;
  pack_label: string | null;
  packs: number | null;
  order_quantity: number | null;
  estimated_cost: number | null;
}

interface OrderListGroup {
  vendor_id: string | null;
  vendor_name: string | null;
  items: OrderListItem[];
  estimated_cost: number;
  missing_cost_count: number;
}

interface DeliveryLine {
  supply_id: string;
  amount: string;
  price: string;
}

const emptySupplyForm = {
  name: '', base_unit: 'each' as SupplyUnit, stock_quantity: '0', low_stock_threshold: '',
  unit_cost: '', pack_size: '', pack_label: '', pour_size: '', order_up_to: '', vendor_id: '', group_name: '',
};

const optionalNumber = (value: string) => (value === '' ? null : Number(value));

interface SupplyMovement {
  id: number;
  supply_id: string;
  supply_name: string | null;
  quantity_delta: number;
  movement_type: string;
  unit: SupplyUnit;
  stock_after: number;
  reason: string | null;
  actor_name: string | null;
  created_at: string;
}

interface RecipeItem {
  group_name: string | null;
  supply_id: string;
  supply_name: string;
  base_unit: SupplyUnit;
  quantity: number;
  unit: SupplyUnit;
  quantity_in_base: number;
}

interface Recipe {
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

interface Product {
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

interface Category {
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

const emptyDish: DishForm = { name: '', category_id: '', price: '', image: null, imageTouched: false, is_active: false, sku: '', barcode: '', description: '', tax_category_id: '' };

const nextSku = (products: Product[]): string | null => {
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

const dishFromProduct = (p: Product | undefined): DishForm => (p
  ? { name: p.name, category_id: p.category_id ?? '', price: p.price === undefined ? '' : String(p.price), image: p.has_image ? 'EXISTING' : null, imageTouched: false, is_active: p.is_active === true || p.is_active === 1, sku: p.sku ?? '', barcode: p.barcode ?? '', description: p.description ?? '', tax_category_id: p.tax_category_id ?? '' }
  : emptyDish);

const movementTypeIcons: Record<string, typeof ArrowUpCircle> = {
  receive: ArrowUpCircle,
  count: Scale,
  adjustment: Edit,
  waste: PackageMinus,
  recipe_depletion: ArrowDownCircle,
  recipe_restore: ArrowUpCircle,
};

interface RecipeImportPreview {
  to_create: { product_name: string; items: number }[];
  already_have_recipe: string[];
  skipped: { product_name: string; reason: string }[];
}

interface ImportPreview {
  to_create: { name: string; base_unit: SupplyUnit; pack_size: number | null; pack_label: string | null; pack_price: number | null }[];
  already_exist: string[];
  errors: { row: number; name: string; error: string }[];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

export default function InventoryPage() {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('inventory');
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const { formatDate } = useFormatDate();
  const fmtNum = useFormatNumber();
  const canManage = tenantCan(currentTenant, 'inventory.manage');

  const [tab, setTab] = useState('supplies');
  const [recipeSearch, setRecipeSearch] = useState('');
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [movements, setMovements] = useState<SupplyMovement[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [showSupplyForm, setShowSupplyForm] = useState(false);
  const [editingSupply, setEditingSupply] = useState<Supply | null>(null);
  const [supplyForm, setSupplyForm] = useState(emptySupplyForm);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [showDelivery, setShowDelivery] = useState(false);
  const [deliveryVendorId, setDeliveryVendorId] = useState('');
  const [newVendorName, setNewVendorName] = useState('');
  const [deliveryReference, setDeliveryReference] = useState('');
  const [deliveryLines, setDeliveryLines] = useState<DeliveryLine[]>([]);

  const [showOrderList, setShowOrderList] = useState(false);
  const [orderGroups, setOrderGroups] = useState<OrderListGroup[]>([]);
  const [orderListLoading, setOrderListLoading] = useState(false);

  const [showRecipeImport, setShowRecipeImport] = useState(false);
  const [recipeImportRows, setRecipeImportRows] = useState<Record<string, string>[]>([]);
  const [recipeImportPreview, setRecipeImportPreview] = useState<RecipeImportPreview | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, string>[]>([]);
  const [importVendor, setImportVendor] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);

  const [movementSupply, setMovementSupply] = useState<Supply | null>(null);
  const [movementForm, setMovementForm] = useState({ movement_type: 'receive', quantity: '', unit: 'each' as SupplyUnit, reason: '' });

  const [showRecipeForm, setShowRecipeForm] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [recipeForm, setRecipeForm] = useState({ product_id: '', yield_quantity: '1', dish: emptyDish, items: [] as { supply_id: string; group_name: string; quantity: string; unit: SupplyUnit }[] });
  const [categories, setCategories] = useState<Category[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [showPhotoPicker, setShowPhotoPicker] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [taxCategories, setTaxCategories] = useState<{ id: string; label: string }[]>([]);
  const [aiPhotos, setAiPhotos] = useState<{ image_url: string; thumb: string; title: string }[]>([]);
  const [aiMissing, setAiMissing] = useState<string[]>([]);
  const [targetFoodCost, setTargetFoodCost] = useState(() => {
    try { return window.localStorage.getItem('recipeTargetFoodCostPct') || '30'; } catch { return '30'; }
  });
  const updateTargetFoodCost = (value: string) => {
    setTargetFoodCost(value);
    try { window.localStorage.setItem('recipeTargetFoodCostPct', value); } catch { /* optional convenience */ }
  };

  const [deletingSupply, setDeletingSupply] = useState<Supply | null>(null);
  const [deletingRecipe, setDeletingRecipe] = useState<Recipe | null>(null);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const groupTotals = useMemo(() => {
    const totals = new Map<string, { name: string; unit: SupplyUnit; stock: number; items: number }>();
    for (const s of supplies) {
      if (!s.group_name) continue;
      const key = s.group_name.toLowerCase();
      const entry = totals.get(key) ?? { name: s.group_name, unit: s.base_unit, stock: 0, items: 0 };
      entry.stock += Number(s.stock_quantity);
      entry.items += 1;
      totals.set(key, entry);
    }
    return [...totals.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [supplies]);
  const recipeQuery = recipeSearch.trim().toLowerCase();
  const visibleRecipes = useMemo(() => {
    if (!recipeQuery) return recipes;
    return recipes.filter((r) =>
      (r.product_name || '').toLowerCase().includes(recipeQuery)
      || r.items.some((item) => `${item.group_name ?? ''} ${item.supply_name}`.toLowerCase().includes(recipeQuery)));
  }, [recipes, recipeQuery]);
  const productsWithoutRecipe = useMemo(() => {
    const have = new Set(recipes.map((r) => r.product_id));
    return products.filter((p) => !have.has(p.id) && (!recipeQuery || p.name.toLowerCase().includes(recipeQuery)));
  }, [products, recipes, recipeQuery]);

  const downloadCsv = (filename: string, rows: (string | number | null)[][]) => {
    const cell = (v: string | number | null) => {
      const text = v === null ? '' : String(v);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const blob = new Blob([`\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportRecipes = () => {
    const rows: (string | number | null)[][] = [['product_name', 'ingredient_name', 'quantity', 'unit', 'status', 'cost_per_serving', 'selling_price', 'margin_percent']];
    for (const r of visibleRecipes) {
      for (const item of r.items) {
        rows.push([
          r.product_name || r.product_id, item.group_name || item.supply_name, item.quantity, item.unit,
          r.is_active === 1 ? 'confirmed' : 'draft', r.cost_per_serving, r.selling_price, r.margin_percent,
        ]);
      }
    }
    downloadCsv('recipes.csv', rows);
  };

  const exportSupplies = () => {
    const rows: (string | number | null)[][] = [['name', 'group', 'base_unit', 'stock', 'par_level', 'order_up_to', 'unit_cost', 'pack_size', 'pack_label', 'pack_price', 'pour_size']];
    for (const s of supplies) {
      rows.push([
        s.name, s.group_name, s.base_unit, s.stock_quantity, s.low_stock_threshold, s.order_up_to, s.unit_cost, s.pack_size, s.pack_label,
        s.unit_cost !== null && s.pack_size ? Math.round(Number(s.unit_cost) * Number(s.pack_size) * 100) / 100 : null, s.pour_size,
      ]);
    }
    downloadCsv('ingredients.csv', rows);
  };

  const printRecipes = () => {
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const money = (n: number | null) => (n === null ? '—' : fmtNum(Math.round(n * 100) / 100));
    const blocks = visibleRecipes.map((r) => {
      const rows = r.items.map((item) => `<tr><td>${esc(item.group_name ? t('anyGroupLine', { group: item.group_name, name: item.supply_name }) : item.supply_name)}</td><td class="n">${esc(fmtNum(Number(item.quantity)))} ${esc(item.unit)}</td></tr>`).join('');
      const margin = r.margin === null ? '—' : `${money(r.margin)} (${fmtNum(r.margin_percent ?? 0)}%)`;
      return `<section><h2>${esc(r.product_name || r.product_id)}${r.is_active === 1 ? '' : ` <small>(${esc(t('draft'))})</small>`}</h2>
        <p>${esc(t('yield'))}: ${esc(fmtNum(Number(r.yield_quantity)))}</p>
        <table>${rows}</table>
        <p class="f">${esc(t('recipeCostPerServing'))}: <b>${money(r.cost_per_serving)}</b> &nbsp; ${esc(t('actualPrice'))}: <b>${money(r.selling_price)}</b> &nbsp; ${esc(t('marginAtActual'))}: <b>${esc(margin)}</b></p></section>`;
    }).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t('tabRecipes'))}</title><style>
      body{font-family:system-ui,sans-serif;font-size:14pt;margin:16mm;color:#111}
      h1{font-size:20pt;margin:0 0 8mm} section{break-inside:avoid;border-top:1px solid #999;padding:4mm 0}
      h2{font-size:16pt;margin:0 0 2mm} h2 small{font-weight:normal;color:#666} p{margin:1mm 0}
      table{border-collapse:collapse;width:100%;margin:2mm 0} td{padding:1.5mm 2mm;border-bottom:1px solid #ddd} td.n{text-align:right;white-space:nowrap}
      .f{font-size:12pt;color:#333}
    </style></head><body><h1>${esc(t('tabRecipes'))}</h1>${blocks}</body></html>`;
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc || !frame.contentWindow) { frame.remove(); return; }
    doc.open(); doc.write(html); doc.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  };
  const groupNames = useMemo(() => groupTotals.map((g) => g.name), [groupTotals]);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    const params: Record<string, string> = {};
    if (search) params.search = search;
    if (lowStockOnly) params.low_stock = 'true';
    if (includeInactive) params.include_inactive = 'true';
    api.get('/supplies', { params, signal: controller.signal })
      .then(({ data }) => setSupplies(data.supplies || []))
      .catch((err: unknown) => {
        if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(t('loadFailed'));
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, lowStockOnly, includeInactive, refreshKey, canManage]);

  useEffect(() => {
    if (!canManage || tab !== 'recipes') return;
    const controller = new AbortController();
    Promise.all([
      api.get('/recipes', { signal: controller.signal }),
      api.get('/products', { signal: controller.signal }),
      api.get('/categories', { signal: controller.signal }),
    ])
      .then(([recipesRes, productsRes, categoriesRes]) => {
        setRecipes(recipesRes.data.recipes || []);
        setProducts(productsRes.data.products || []);
        setCategories(categoriesRes.data.categories || []);
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(t('loadFailed'));
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, refreshKey, canManage]);

  useEffect(() => {
    if (!canManage || tab !== 'recipes') return;
    api.get('/tax/categories')
      .then(({ data }) => setTaxCategories((data.categories || []) as { id: string; label: string }[]))
      .catch(() => undefined);
  }, [canManage, tab]);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    api.get('/vendors', { signal: controller.signal })
      .then(({ data }) => setVendors(data.vendors || []))
      .catch(() => undefined);
    return () => controller.abort();
  }, [canManage, refreshKey]);

  const loadMovements = useCallback(async (cursor?: number | null) => {
    try {
      const params: Record<string, string | number> = { per_page: 50 };
      if (cursor) params.before_id = cursor;
      const { data } = await api.get('/supplies/movements', { params });
      setMovements((prev) => (cursor ? [...prev, ...(data.movements || [])] : data.movements || []));
      setNextCursor(data.nextCursor ?? null);
    } catch {
      toast.error(t('loadFailed'));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    if (!canManage || tab !== 'movements') return;
    const controller = new AbortController();
    api.get('/supplies/movements', { params: { per_page: 50 }, signal: controller.signal })
      .then(({ data }) => {
        setMovements(data.movements || []);
        setNextCursor(data.nextCursor ?? null);
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(t('loadFailed'));
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, refreshKey, canManage]);

  const openAddSupply = () => {
    setEditingSupply(null);
    setSupplyForm(emptySupplyForm);
    setShowSupplyForm(true);
  };

  const openEditSupply = (s: Supply) => {
    setEditingSupply(s);
    setSupplyForm({
      name: s.name,
      base_unit: s.base_unit,
      stock_quantity: String(s.stock_quantity),
      low_stock_threshold: s.low_stock_threshold === null ? '' : String(s.low_stock_threshold),
      unit_cost: s.unit_cost === null ? '' : String(s.unit_cost),
      pack_size: s.pack_size === null ? '' : String(s.pack_size),
      pack_label: s.pack_label ?? '',
      pour_size: s.pour_size === null ? '' : String(s.pour_size),
      order_up_to: s.order_up_to === null ? '' : String(s.order_up_to),
      vendor_id: s.vendor_id ?? '',
      group_name: s.group_name ?? '',
    });
    setShowSupplyForm(true);
  };

  const handleSaveSupply = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        name: supplyForm.name,
        base_unit: supplyForm.base_unit,
        stock_quantity: Number(supplyForm.stock_quantity),
        low_stock_threshold: optionalNumber(supplyForm.low_stock_threshold),
        unit_cost: optionalNumber(supplyForm.unit_cost),
        pack_size: optionalNumber(supplyForm.pack_size),
        pack_label: supplyForm.pack_label.trim() || null,
        pour_size: optionalNumber(supplyForm.pour_size),
        order_up_to: optionalNumber(supplyForm.order_up_to),
        vendor_id: supplyForm.vendor_id || null,
        group_name: supplyForm.group_name.trim() || null,
      };
      if (editingSupply) {
        await api.put(`/supplies/${editingSupply.id}`, {
          name: payload.name,
          low_stock_threshold: payload.low_stock_threshold,
          unit_cost: payload.unit_cost,
          pack_size: payload.pack_size,
          pack_label: payload.pack_label,
          pour_size: payload.pour_size,
          order_up_to: payload.order_up_to,
          vendor_id: payload.vendor_id,
          group_name: payload.group_name,
        });
        toast.success(tCommon('save'));
      } else {
        await api.post('/supplies', payload);
        toast.success(tCommon('save'));
      }
      setShowSupplyForm(false);
      refresh();
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      toast.error(message || t('saveFailed'));
    }
  };

  const handleRecordMovement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!movementSupply) return;
    try {
      await api.post(`/supplies/${movementSupply.id}/movements`, {
        movement_type: movementForm.movement_type,
        quantity: Number(movementForm.quantity),
        unit: movementForm.unit,
        reason: movementForm.reason || undefined,
      });
      toast.success(tCommon('save'));
      setMovementSupply(null);
      setMovementForm({ movement_type: 'receive', quantity: '', unit: 'each', reason: '' });
      refresh();
      if (tab === 'movements') loadMovements(null);
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      toast.error(message || t('saveFailed'));
    }
  };

  const openDelivery = () => {
    setDeliveryVendorId('');
    setNewVendorName('');
    setDeliveryReference('');
    setDeliveryLines([{ supply_id: '', amount: '', price: '' }]);
    setShowDelivery(true);
  };

  const updateDeliveryLine = (index: number, patch: Partial<DeliveryLine>) => {
    setDeliveryLines((lines) => lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const handleSaveDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let vendorId = deliveryVendorId;
      if (!vendorId && newVendorName.trim()) {
        const { data } = await api.post('/vendors', { name: newVendorName.trim() });
        vendorId = data.vendor.id;
      }
      const lines = deliveryLines
        .filter((line) => line.supply_id && line.amount !== '')
        .map((line) => {
          const supply = supplies.find((s) => s.id === line.supply_id);
          const price = line.price === '' ? undefined : Number(line.price);
          return supply?.pack_size
            ? { supply_id: line.supply_id, packs: Number(line.amount), pack_price: price }
            : { supply_id: line.supply_id, quantity: Number(line.amount), total_cost: price };
        });
      await api.post('/supplies/deliveries', {
        vendor_id: vendorId || undefined,
        reference: deliveryReference.trim() || undefined,
        lines,
      });
      toast.success(t('deliverySaved'));
      setShowDelivery(false);
      refresh();
      if (tab === 'movements') loadMovements(null);
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      toast.error(message || t('saveFailed'));
    }
  };

  const openOrderList = async () => {
    setShowOrderList(true);
    setOrderListLoading(true);
    try {
      const { data } = await api.get('/supplies/order-list');
      setOrderGroups(data.groups || []);
    } catch {
      setOrderGroups([]);
      toast.error(t('loadFailed'));
    } finally {
      setOrderListLoading(false);
    }
  };

  const orderLine = (item: OrderListItem) => {
    if (item.order_quantity === null) return `${item.name}: ${t('orderListNeedTarget')}`;
    const amount = item.packs !== null
      ? `${fmtNum(item.packs)} ${item.pack_label || t('packs')} (${fmtNum(item.order_quantity)} ${item.base_unit})`
      : `${fmtNum(item.order_quantity)} ${item.base_unit}`;
    return `${item.name}: ${amount}`;
  };

  const copyOrderList = async () => {
    const text = orderGroups
      .map((g) => [g.vendor_name || t('noVendor'), ...g.items.map((i) => `- ${orderLine(i)}`)].join('\n'))
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('orderListCopied'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const openImport = () => {
    setImportRows([]);
    setImportVendor('');
    setImportPreview(null);
    setShowImport(true);
  };

  const importError = (err: unknown): string => {
    const message = err instanceof Error && 'response' in err
      ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
      : undefined;
    return message || t('saveFailed');
  };

  const importPayload = (rows: Record<string, string>[], dryRun: boolean) => ({
    rows,
    vendor_name: importVendor.trim() || undefined,
    dry_run: dryRun,
  });

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const table = parseCsv(await file.text());
      const header = (table[0] || []).map((h) => h.trim().toLowerCase());
      const rows = table.slice(1).map((cells) => {
        const record: Record<string, string> = {};
        header.forEach((name, index) => { record[name] = (cells[index] ?? '').trim(); });
        return record;
      });
      setImportRows(rows);
      const { data } = await api.post('/supplies/import', importPayload(rows, true));
      setImportPreview(data);
    } catch (err: unknown) {
      setImportRows([]);
      setImportPreview(null);
      toast.error(importError(err));
    }
  };

  const handleImportConfirm = async () => {
    setImporting(true);
    try {
      const { data } = await api.post('/supplies/import', importPayload(importRows, false));
      toast.success(t('importDone', { count: data.to_create.length }));
      setShowImport(false);
      refresh();
      api.get('/vendors').then(({ data: v }) => setVendors(v.vendors || [])).catch(() => undefined);
    } catch (err: unknown) {
      toast.error(importError(err));
    } finally {
      setImporting(false);
    }
  };

  const openRecipeImport = () => {
    setRecipeImportRows([]);
    setRecipeImportPreview(null);
    setShowRecipeImport(true);
  };

  const handleRecipeImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const table = parseCsv(await file.text());
      const header = (table[0] || []).map((h) => h.trim().toLowerCase());
      const rows = table.slice(1).map((cells) => {
        const record: Record<string, string> = {};
        header.forEach((name, index) => { record[name] = (cells[index] ?? '').trim(); });
        return record;
      });
      setRecipeImportRows(rows);
      const { data } = await api.post('/recipes/import', { rows, dry_run: true });
      setRecipeImportPreview(data);
    } catch (err: unknown) {
      setRecipeImportRows([]);
      setRecipeImportPreview(null);
      toast.error(importError(err));
    }
  };

  const handleRecipeImportConfirm = async () => {
    setImporting(true);
    try {
      const { data } = await api.post('/recipes/import', { rows: recipeImportRows, dry_run: false });
      toast.success(t('recipeDone', { count: data.to_create.length }));
      setShowRecipeImport(false);
      refresh();
    } catch (err: unknown) {
      toast.error(importError(err));
    } finally {
      setImporting(false);
    }
  };

  const handleConfirmRecipe = async (r: Recipe) => {
    try {
      await api.put(`/recipes/product/${r.product_id}`, {
        yield_quantity: Number(r.yield_quantity),
        is_active: true,
        items: r.items.map((item) => (item.group_name
          ? { group_name: item.group_name, quantity: Number(item.quantity), unit: item.unit }
          : { supply_id: item.supply_id, quantity: Number(item.quantity), unit: item.unit })),
      });
      toast.success(t('recipeConfirmed'));
      refresh();
    } catch (err: unknown) {
      toast.error(importError(err));
    }
  };

  const handleAiHelp = async () => {
    const name = recipeForm.dish.name.trim();
    if (!name) { toast.error(t('aiNeedName')); return; }
    const category = categories.find((c) => c.id === recipeForm.dish.category_id)?.name ?? '';
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
        const existing = new Set(recipeForm.items.map((i) => (i.group_name ? `group:${i.group_name}` : i.supply_id)));
        const added = suggestion.items
          .filter((i) => !existing.has(i.group_name ? `group:${i.group_name}` : String(i.supply_id)))
          .map((i) => ({ supply_id: i.supply_id ?? '', group_name: i.group_name ?? '', quantity: String(i.quantity), unit: i.unit }));
        if (added.length > 0) {
          setRecipeForm((prev) => ({
            ...prev,
            yield_quantity: prev.items.length === 0 ? String(suggestion.yield_quantity) : prev.yield_quantity,
            items: [...prev.items, ...added],
          }));
          toast.success(t('aiAdded', { count: added.length }));
        }
        setAiMissing(suggestion.not_in_inventory.map((i) => i.name));
      } else {
        toast.error(importError(recipeRes.reason));
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
        toast.error(importError(photoRes.reason));
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
        setRecipeForm((prev) => ({ ...prev, dish: { ...prev.dish, image: compressed, imageTouched: true } }));
        setAiPhotos([]);
        setShowPhotoPicker(false);
      } else {
        toast.error(t('saveFailed'));
      }
    } finally {
      setAiBusy(false);
    }
  };

  const openAddRecipe = (productId = '') => {
    setShowDetails(false);
    setShowPhotoPicker(false);
    setAiPhotos([]);
    setAiMissing([]);
    setEditingRecipe(null);
    setRecipeForm({ product_id: productId, yield_quantity: '1', dish: dishFromProduct(products.find((p) => p.id === productId)), items: [] });
    setShowRecipeForm(true);
  };

  const openEditRecipe = (r: Recipe) => {
    setShowDetails(false);
    setShowPhotoPicker(false);
    setAiPhotos([]);
    setAiMissing([]);
    setEditingRecipe(r);
    setRecipeForm({
      product_id: r.product_id,
      yield_quantity: String(r.yield_quantity),
      dish: dishFromProduct(products.find((p) => p.id === r.product_id)),
      items: r.items.map((item) => ({ supply_id: item.supply_id, group_name: item.group_name ?? '', quantity: String(item.quantity), unit: item.unit })),
    });
    setShowRecipeForm(true);
  };

  const handleSaveRecipe = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const dish = recipeForm.dish;
      const price = Math.round(Number(dish.price) * 100) / 100;
      let productId = recipeForm.product_id;
      const isNewDish = productId === 'new';
      if (isNewDish) {
        const created = await api.post('/products', {
          name: dish.name.trim(),
          category_id: dish.category_id || null,
          price,
          is_active: dish.is_active,
          sku: dish.sku.trim() || nextSku(products),
          barcode: dish.barcode.trim() || null,
          description: dish.description.trim() || null,
          tax_category_id: dish.tax_category_id || null,
          ...(dish.imageTouched ? { image_url: dish.image } : {}),
        });
        productId = String(created.data.product.id);
      } else {
        const current = products.find((p) => p.id === productId);
        const patch: Record<string, unknown> = {};
        if (current) {
          if (dish.name.trim() && dish.name.trim() !== current.name) patch.name = dish.name.trim();
          if ((dish.category_id || null) !== (current.category_id ?? null)) patch.category_id = dish.category_id || null;
          if (dish.price !== '' && price !== Number(current.price)) patch.price = price;
          if (dish.sku.trim() !== (current.sku ?? '')) patch.sku = dish.sku.trim() || null;
          if (dish.barcode.trim() !== (current.barcode ?? '')) patch.barcode = dish.barcode.trim() || null;
          if (dish.description.trim() !== (current.description ?? '')) patch.description = dish.description.trim() || null;
          if (dish.tax_category_id !== (current.tax_category_id ?? '')) patch.tax_category_id = dish.tax_category_id || null;
        }
        if (current && dish.is_active !== (current.is_active === true || current.is_active === 1)) patch.is_active = dish.is_active;
        if (dish.imageTouched) patch.image_url = dish.image;
        if (Object.keys(patch).length > 0) await api.put(`/products/${productId}`, patch);
      }
      await api.put(`/recipes/product/${productId}`, {
        yield_quantity: Number(recipeForm.yield_quantity),
        is_active: isNewDish ? false : (editingRecipe ? editingRecipe.is_active === 1 : true),
        items: recipeForm.items.map((item) => (item.group_name
          ? { group_name: item.group_name, quantity: Number(item.quantity), unit: item.unit }
          : { supply_id: item.supply_id, quantity: Number(item.quantity), unit: item.unit })),
      });
      toast.success(tCommon('save'));
      setShowRecipeForm(false);
      refresh();
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      toast.error(message || t('saveFailed'));
    }
  };

  const handleDeleteSupply = async () => {
    if (!deletingSupply) return;
    try {
      await api.delete(`/supplies/${deletingSupply.id}`);
      toast.success(tCommon('delete'));
      setDeletingSupply(null);
      refresh();
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      toast.error(message || t('deleteFailed'));
    }
  };

  const handleDeleteRecipe = async () => {
    if (!deletingRecipe) return;
    try {
      await api.delete(`/recipes/product/${deletingRecipe.product_id}`);
      toast.success(tCommon('delete'));
      setDeletingRecipe(null);
      refresh();
    } catch {
      toast.error(t('deleteFailed'));
    }
  };

  if (!canManage) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h1 className="text-xl font-bold text-foreground mb-2">{tNav('inventory')}</h1>
        <p className="text-muted-foreground">{t('noAccess')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">{tNav('inventory')}</h1>
        {tab === 'supplies' && (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={openOrderList}><ClipboardList size={16} className="me-1" /> {t('orderList')}</Button>
            <Button variant="outline" onClick={openImport}><Upload size={16} className="me-1" /> {t('importIngredients')}</Button>
            <Button variant="outline" onClick={openDelivery}><Truck size={16} className="me-1" /> {t('receiveDelivery')}</Button>
            <Button onClick={openAddSupply}><Plus size={16} className="me-1" /> {t('addSupply')}</Button>
          </div>
        )}
        {tab === 'recipes' && (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => openAddRecipe('new')}>
              <Sparkles size={16} className="me-1" /> {t('aiRecipeHelper')}
            </Button>
            <Button variant="outline" onClick={openRecipeImport}><Upload size={16} className="me-1" /> {t('importRecipes')}</Button>
            <Button onClick={() => openAddRecipe()}><Plus size={16} className="me-1" /> {t('addRecipe')}</Button>
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="supplies">{t('tabSupplies')}</TabsTrigger>
          <TabsTrigger value="recipes">{t('tabRecipes')}</TabsTrigger>
          <TabsTrigger value="movements">{t('tabMovements')}</TabsTrigger>
        </TabsList>

        <TabsContent value="supplies">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-48">
              <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder={tCommon('search')}
                className="w-full ps-10 pe-4 py-2.5 bg-card border border-border rounded-lg focus:ring-2 focus:ring-brand outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
              <input type="checkbox" checked={lowStockOnly} onChange={(e) => setLowStockOnly(e.target.checked)} />
              {t('lowStockOnly')}
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              {t('includeInactive')}
            </label>
            <Button variant="outline" onClick={exportSupplies} disabled={supplies.length === 0}><Download size={16} className="me-1" /> {t('exportCsv')}</Button>
          </div>

          {groupTotals.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {groupTotals.map((g) => (
                <Badge key={g.name} variant="secondary">
                  {g.name}: {fmtNum(Math.round(g.stock * 100) / 100)} {g.unit} · {t('groupItems', { count: g.items })}
                </Badge>
              ))}
            </div>
          )}

          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('supplyName')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('group')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('baseUnit')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('stock')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('threshold')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('unitCost')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('packPrice')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('pourSize')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{tCommon('active')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {supplies.map((s) => (
                  <tr key={s.id} className="hover:bg-muted">
                    <td className="p-4 font-medium text-foreground">
                      {s.name}
                      {s.is_low_stock === 1 && (
                        <Badge variant="destructive" className="ms-2">{t('lowStock')}</Badge>
                      )}
                    </td>
                    <td className="p-4 text-sm text-muted-foreground">{s.group_name || '—'}</td>
                    <td className="p-4 text-center text-sm text-muted-foreground">{s.base_unit}</td>
                    <td className={`p-4 text-end text-sm font-medium ${Number(s.stock_quantity) < 0 ? 'text-red-600' : ''}`}>{fmtNum(Number(s.stock_quantity))} {s.base_unit}</td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {s.low_stock_threshold === null ? '—' : fmtNum(Number(s.low_stock_threshold))}
                    </td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {s.unit_cost === null ? '—' : fmtNum(Number(s.unit_cost))}
                    </td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {s.unit_cost === null || !s.pack_size
                        ? '—'
                        : `${fmtNum(Math.round(Number(s.unit_cost) * Number(s.pack_size) * 100) / 100)}${s.pack_label ? ` / ${s.pack_label}` : ''}`}
                    </td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {s.pour_size === null ? '—' : `${fmtNum(Number(s.pour_size))} ${s.base_unit}`}
                    </td>
                    <td className="p-4 text-center text-sm">
                      {s.is_active === 1 ? tCommon('active') : tCommon('inactive')}
                    </td>
                    <td className="p-4 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => {
                          setMovementSupply(s);
                          setMovementForm({ movement_type: 'receive', quantity: '', unit: s.base_unit, reason: '' });
                        }} title={t('recordMovement')}>
                          <ArrowDownCircle size={14} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEditSupply(s)} title={tCommon('edit')}>
                          <Edit size={14} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeletingSupply(s)} title={tCommon('delete')}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {supplies.length === 0 && <p className="text-center text-muted-foreground py-12">{t('emptySupplies')}</p>}
          </div>
        </TabsContent>

        <TabsContent value="recipes">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-48">
              <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text" value={recipeSearch} onChange={(e) => setRecipeSearch(e.target.value)}
                placeholder={t('searchRecipes')}
                className="w-full ps-10 pe-4 py-2.5 bg-card border border-border rounded-lg focus:ring-2 focus:ring-brand outline-none"
              />
            </div>
            <Button variant="outline" onClick={printRecipes} disabled={visibleRecipes.length === 0}><Printer size={16} className="me-1" /> {t('print')}</Button>
            <Button variant="outline" onClick={exportRecipes} disabled={visibleRecipes.length === 0}><Download size={16} className="me-1" /> {t('exportCsv')}</Button>
          </div>
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('product')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('yield')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('components')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('costPerServing')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('sellingPrice')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('margin')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleRecipes.map((r) => (
                  <tr key={r.id} className="hover:bg-muted">
                    <td className="p-4 font-medium text-foreground">
                      <div className="flex items-center gap-3">
                        {(() => {
                          const product = products.find((p) => p.id === r.product_id);
                          const name = r.product_name || '';
                          const src = product?.has_image
                            ? `${api.defaults.baseURL}/products/${r.product_id}/image?t=${product.updated_at ?? ''}`
                            : genericMenuPhoto(name);
                          return src
                            ? <img src={src} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0 border border-border" loading="lazy" />
                            : <div className="w-12 h-12 rounded-lg bg-muted shrink-0 border border-border" />;
                        })()}
                        <span>
                          {r.product_name || r.product_id}
                          {r.is_active !== 1 && <Badge variant="secondary" className="ms-2">{t('draft')}</Badge>}
                          {(() => {
                            const product = products.find((p) => p.id === r.product_id);
                            const on = product?.is_active === true || product?.is_active === 1;
                            return <Badge variant={on ? 'default' : 'outline'} className="ms-2">{on ? t('onPos') : t('offPos')}</Badge>;
                          })()}
                        </span>
                      </div>
                    </td>
                    <td className="p-4 text-center text-sm">{fmtNum(Number(r.yield_quantity))}</td>
                    <td className="p-4 text-sm text-muted-foreground">
                      <ul className="space-y-0.5">
                        {r.items.map((item) => (
                          <li key={item.group_name ? `group:${item.group_name}` : item.supply_id}>
                            {item.group_name
                              ? t('anyGroupLine', { group: item.group_name, name: item.supply_name })
                              : item.supply_name}: {fmtNum(Number(item.quantity))} {item.unit}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="p-4 text-end text-sm">
                      {r.cost_per_serving === null ? '-' : fmtNum(r.cost_per_serving)}
                      {!r.cost_complete && r.missing_cost_supplies.length > 0 && (
                        <p className="text-xs text-amber-600">{t('costMissing', { names: r.missing_cost_supplies.join(', ') })}</p>
                      )}
                    </td>
                    <td className="p-4 text-end text-sm">{r.selling_price === null ? '-' : fmtNum(r.selling_price)}</td>
                    <td className="p-4 text-end text-sm">
                      {r.margin === null ? '-' : `${fmtNum(r.margin)} (${fmtNum(r.margin_percent ?? 0)}%)`}
                    </td>
                    <td className="p-4 text-center">
                      <div className="flex items-center justify-center gap-1">
                        {r.is_active !== 1 && (
                          <Button variant="ghost" size="sm" onClick={() => handleConfirmRecipe(r)} title={t('confirmRecipe')}>
                            <Check size={14} />
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => openEditRecipe(r)} title={tCommon('edit')}>
                          <Edit size={14} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeletingRecipe(r)} title={tCommon('delete')}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleRecipes.length === 0 && <p className="text-center text-muted-foreground py-12">{t('emptyRecipes')}</p>}
          </div>

          {productsWithoutRecipe.length > 0 && (
            <div className="bg-card rounded-xl border border-border mt-6 p-4">
              <h3 className="text-lg font-semibold">{t('menuNoRecipe', { count: productsWithoutRecipe.length })}</h3>
              <p className="text-sm text-muted-foreground mb-3">{t('menuNoRecipeHelp')}</p>
              <ul className="divide-y divide-border">
                {productsWithoutRecipe.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="text-base">{p.name}</span>
                    <Button variant="outline" size="sm" onClick={() => openAddRecipe(p.id)}>
                      <Plus size={14} className="me-1" /> {t('createRecipe')}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TabsContent>

        <TabsContent value="movements">
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('date')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('supply')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('movementType')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('quantity')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('stockAfter')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('reason')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('actor')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {movements.map((m) => {
                  const Icon = movementTypeIcons[m.movement_type] || ClipboardList;
                  const labelKey = m.movement_type === 'recipe_depletion' ? 'recipeDepletion'
                    : m.movement_type === 'recipe_restore' ? 'recipeRestore'
                    : m.movement_type;
                  return (
                    <tr key={m.id} className="hover:bg-muted">
                      <td className="p-4 text-sm text-muted-foreground whitespace-nowrap">{formatDate(m.created_at)}</td>
                      <td className="p-4 text-sm font-medium text-foreground">{m.supply_name || m.supply_id}</td>
                      <td className="p-4 text-center text-sm">
                        <span className="inline-flex items-center gap-1.5">
                          <Icon size={14} className="text-muted-foreground" />
                          {t(labelKey as 'receive' | 'count' | 'adjustment' | 'waste' | 'recipeDepletion' | 'recipeRestore')}
                        </span>
                      </td>
                      <td className={`p-4 text-end text-sm font-medium whitespace-nowrap ${Number(m.quantity_delta) < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        {Number(m.quantity_delta) > 0 ? '+' : ''}{fmtNum(Number(m.quantity_delta))} {m.unit}
                      </td>
                      <td className="p-4 text-end text-sm text-muted-foreground whitespace-nowrap">{fmtNum(Number(m.stock_after))} {m.unit}</td>
                      <td className="p-4 text-sm text-muted-foreground">{m.reason || '—'}</td>
                      <td className="p-4 text-sm text-muted-foreground">{m.actor_name || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {movements.length === 0 && <p className="text-center text-muted-foreground py-12">{t('emptyMovements')}</p>}
            {nextCursor !== null && (
              <div className="text-center py-3 border-t border-border">
                <Button variant="outline" size="sm" onClick={() => loadMovements(nextCursor)}>{t('loadMore')}</Button>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {showSupplyForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{editingSupply ? t('editSupply') : t('addSupply')}</h2>
              <button onClick={() => setShowSupplyForm(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleSaveSupply} className="space-y-4">
              <input type="text" placeholder={t('supplyName')} value={supplyForm.name}
                onChange={(e) => setSupplyForm({ ...supplyForm, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
              {!editingSupply && (
                <>
                  <select value={supplyForm.base_unit}
                    onChange={(e) => setSupplyForm({ ...supplyForm, base_unit: e.target.value as SupplyUnit })}
                    className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                    {SUPPLY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <input type="number" step="any" min="0" placeholder={t('stock')} value={supplyForm.stock_quantity}
                    onChange={(e) => setSupplyForm({ ...supplyForm, stock_quantity: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
                </>
              )}
              <input type="number" step="any" min="0" placeholder={t('threshold')} value={supplyForm.low_stock_threshold}
                onChange={(e) => setSupplyForm({ ...supplyForm, low_stock_threshold: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              <input type="number" step="any" min="0" placeholder={t('orderUpTo')} value={supplyForm.order_up_to}
                onChange={(e) => setSupplyForm({ ...supplyForm, order_up_to: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              <input type="number" step="any" min="0" placeholder={t('unitCost')} value={supplyForm.unit_cost}
                onChange={(e) => setSupplyForm({ ...supplyForm, unit_cost: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              <div className="flex gap-2">
                <input type="number" step="any" min="0" placeholder={t('packSize')} value={supplyForm.pack_size}
                  onChange={(e) => setSupplyForm({ ...supplyForm, pack_size: e.target.value })}
                  className="flex-1 min-w-0 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                <input type="text" placeholder={t('packLabel')} value={supplyForm.pack_label}
                  onChange={(e) => setSupplyForm({ ...supplyForm, pack_label: e.target.value })}
                  className="flex-1 min-w-0 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              </div>
              <input type="number" step="any" min="0" placeholder={t('pourSize')} value={supplyForm.pour_size}
                onChange={(e) => setSupplyForm({ ...supplyForm, pour_size: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              <input type="text" list="supply-groups" placeholder={t('groupHint')} value={supplyForm.group_name}
                onChange={(e) => setSupplyForm({ ...supplyForm, group_name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              <datalist id="supply-groups">
                {groupNames.map((g) => <option key={g} value={g} />)}
              </datalist>
              <select value={supplyForm.vendor_id}
                onChange={(e) => setSupplyForm({ ...supplyForm, vendor_id: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                <option value="">{t('noVendor')}</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <Button type="submit" className="w-full">{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {showOrderList && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('orderList')}</h2>
              <button onClick={() => setShowOrderList(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{t('orderListHelp')}</p>
            {!orderListLoading && orderGroups.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('orderListEmpty')}</p>
            )}
            <div className="space-y-4">
              {orderGroups.map((g) => (
                <div key={g.vendor_id || 'none'} className="border rounded-lg p-3">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold">{g.vendor_name || t('noVendor')}</span>
                    {g.estimated_cost > 0 && (
                      <span className="text-sm text-muted-foreground">{t('orderListTotal', { amount: fmtNum(g.estimated_cost) })}</span>
                    )}
                  </div>
                  <ul className="space-y-1 text-sm">
                    {g.items.map((i) => <li key={i.supply_id}>{orderLine(i)}</li>)}
                  </ul>
                  {g.missing_cost_count > 0 && (
                    <p className="text-xs text-amber-600 mt-2">{t('orderListMissing', { count: g.missing_cost_count })}</p>
                  )}
                </div>
              ))}
            </div>
            {orderGroups.length > 0 && (
              <div className="flex justify-end mt-4">
                <Button onClick={copyOrderList}>{t('orderListCopy')}</Button>
              </div>
            )}
          </div>
        </div>
      )}

      {showRecipeImport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('importRecipes')}</h2>
              <button onClick={() => setShowRecipeImport(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('importRecipesHelp')}</p>
              <input type="file" accept=".csv,text/csv"
                onChange={(e) => handleRecipeImportFile(e.target.files?.[0])}
                className="w-full text-sm" />
              {recipeImportPreview && (
                <div className="space-y-2 text-sm">
                  <p className="font-medium">{t('recipeNew', { count: recipeImportPreview.to_create.length })}</p>
                  {recipeImportPreview.already_have_recipe.length > 0 && (
                    <p className="text-muted-foreground">{t('recipeHave', { count: recipeImportPreview.already_have_recipe.length })}</p>
                  )}
                  {recipeImportPreview.skipped.length > 0 && (
                    <div>
                      <p className="text-amber-600">{t('recipeSkipped', { count: recipeImportPreview.skipped.length })}</p>
                      <ul className="max-h-40 overflow-y-auto text-xs text-muted-foreground list-disc ps-5">
                        {recipeImportPreview.skipped.map((s, i) => <li key={i}>{s.product_name}: {s.reason}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              <div className="flex justify-end">
                <Button onClick={handleRecipeImportConfirm}
                  disabled={importing || !recipeImportPreview || recipeImportPreview.to_create.length === 0}>
                  {t('recipeImportConfirm', { count: recipeImportPreview?.to_create.length ?? 0 })}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('importIngredients')}</h2>
              <button onClick={() => setShowImport(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('importHelp')}</p>
              <input type="text" list="import-vendors" placeholder={t('importVendor')} value={importVendor}
                onChange={(e) => { setImportVendor(e.target.value); setImportPreview(null); setImportRows([]); }}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              <datalist id="import-vendors">
                {vendors.map((v) => <option key={v.id} value={v.name} />)}
              </datalist>
              <input type="file" accept=".csv,text/csv"
                onChange={(e) => handleImportFile(e.target.files?.[0])}
                className="w-full text-sm" />
              {importPreview && (
                <div className="space-y-2 text-sm">
                  <p className="font-medium">{t('importNew', { count: importPreview.to_create.length })}</p>
                  {importPreview.already_exist.length > 0 && (
                    <p className="text-muted-foreground">{t('importSkipped', { count: importPreview.already_exist.length })}</p>
                  )}
                  {importPreview.errors.length > 0 && (
                    <div className="text-red-600">
                      <p className="font-medium">{t('importErrors', { count: importPreview.errors.length })}</p>
                      {importPreview.errors.slice(0, 5).map((row) => (
                        <p key={row.row}>{row.row}: {row.name || '-'} ({row.error})</p>
                      ))}
                    </div>
                  )}
                  <ul className="max-h-48 overflow-y-auto border rounded-lg divide-y">
                    {importPreview.to_create.map((item) => (
                      <li key={item.name} className="px-3 py-1.5 flex justify-between gap-2">
                        <span className="truncate">{item.name}</span>
                        <span className="text-muted-foreground whitespace-nowrap">
                          {item.pack_size ? `${fmtNum(item.pack_size)} ${item.base_unit}` : item.base_unit}
                          {item.pack_price !== null ? ` · ${fmtNum(item.pack_price)}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <Button className="w-full" disabled={importing || !importPreview || importPreview.errors.length > 0 || importPreview.to_create.length === 0}
                onClick={handleImportConfirm}>
                {t('importConfirm', { count: importPreview?.to_create.length ?? 0 })}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showDelivery && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('receiveDelivery')}</h2>
              <button onClick={() => setShowDelivery(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleSaveDelivery} className="space-y-4">
              <div className="flex gap-2">
                <select value={deliveryVendorId}
                  onChange={(e) => setDeliveryVendorId(e.target.value)}
                  className="flex-1 min-w-0 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                  <option value="">{t('noVendor')}</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                {!deliveryVendorId && (
                  <input type="text" placeholder={t('newVendor')} value={newVendorName}
                    onChange={(e) => setNewVendorName(e.target.value)}
                    className="flex-1 min-w-0 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                )}
              </div>
              <input type="text" placeholder={t('deliveryReference')} value={deliveryReference}
                onChange={(e) => setDeliveryReference(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              {deliveryLines.map((line, index) => {
                const lineSupply = supplies.find((s) => s.id === line.supply_id);
                const byPack = Boolean(lineSupply?.pack_size);
                return (
                  <div key={index} className="flex gap-2">
                    <select value={line.supply_id}
                      onChange={(e) => updateDeliveryLine(index, { supply_id: e.target.value })}
                      className="flex-1 min-w-0 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card" required>
                      <option value="">{t('supply')}</option>
                      {supplies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <input type="number" step="any" min="0.00000001"
                      placeholder={byPack ? `${t('packs')} (${lineSupply?.pack_label || t('packLabel')})` : `${t('quantity')} (${lineSupply?.base_unit || ''})`}
                      value={line.amount}
                      onChange={(e) => updateDeliveryLine(index, { amount: e.target.value })}
                      className="w-28 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
                    <input type="number" step="any" min="0"
                      placeholder={byPack ? t('packPrice') : t('totalCost')}
                      value={line.price}
                      onChange={(e) => updateDeliveryLine(index, { price: e.target.value })}
                      className="w-28 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                    <Button type="button" variant="ghost" size="icon-sm"
                      onClick={() => setDeliveryLines((lines) => lines.filter((_, i) => i !== index))}>
                      <X size={14} />
                    </Button>
                  </div>
                );
              })}
              <Button type="button" variant="outline" size="sm"
                onClick={() => setDeliveryLines((lines) => [...lines, { supply_id: '', amount: '', price: '' }])}>
                <Plus size={14} /> {t('addComponent')}
              </Button>
              <Button type="submit" className="w-full" disabled={deliveryLines.length === 0}>{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {movementSupply && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('recordMovement')}</h2>
              <button onClick={() => setMovementSupply(null)}><X size={20} className="text-gray-400" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{movementSupply.name}</p>
            <form onSubmit={handleRecordMovement} className="space-y-4">
              <select value={movementForm.movement_type}
                onChange={(e) => setMovementForm({ ...movementForm, movement_type: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                <option value="receive">{t('receive')}</option>
                <option value="count">{t('count')}</option>
                <option value="adjustment">{t('adjustment')}</option>
                <option value="waste">{t('waste')}</option>
              </select>
              <div className="flex gap-2">
                <input type="number" step="any" min={movementForm.movement_type === 'adjustment' ? undefined : 0} placeholder={t('quantity')} value={movementForm.quantity}
                  onChange={(e) => setMovementForm({ ...movementForm, quantity: e.target.value })}
                  className="flex-1 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
                <select value={movementForm.unit}
                  onChange={(e) => setMovementForm({ ...movementForm, unit: e.target.value as SupplyUnit })}
                  className="px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                  {SUPPLY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <input type="text" placeholder={t('reason')} value={movementForm.reason}
                onChange={(e) => setMovementForm({ ...movementForm, reason: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                required={movementForm.movement_type === 'adjustment' || movementForm.movement_type === 'waste'} />
              <Button type="submit" className="w-full">{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {showRecipeForm && (() => {
        const toBase = (qty: number, unit: SupplyUnit, base: SupplyUnit): number | null => {
          const f: Record<SupplyUnit, [string, number]> = { each: ['c', 1], g: ['w', 1], kg: ['w', 1000], ml: ['v', 1], l: ['v', 1000] };
          return f[unit][0] === f[base][0] ? (qty * f[unit][1]) / f[base][1] : null;
        };
        const lineSupply = (item: { supply_id: string; group_name: string }): Supply | undefined => {
          if (!item.group_name) return supplies.find((s) => s.id === item.supply_id);
          const members = supplies.filter((s) => s.group_name === item.group_name);
          const resolved = editingRecipe?.items.find((r) => r.group_name === item.group_name);
          return members.find((s) => s.id === resolved?.supply_id) ?? members.find((s) => Number(s.stock_quantity) > 0) ?? members[0];
        };
        const lines = recipeForm.items.map((item) => {
          const supply = lineSupply(item);
          const qty = Number(item.quantity);
          const base = supply && Number.isFinite(qty) ? toBase(qty, item.unit, supply.base_unit) : null;
          const cost = supply && base !== null && supply.unit_cost !== null ? base * Number(supply.unit_cost) : null;
          return { supply, cost };
        });
        const yieldQty = Number(recipeForm.yield_quantity) > 0 ? Number(recipeForm.yield_quantity) : 1;
        const complete = lines.length > 0 && lines.every((l) => l.cost !== null);
        const costPerServing = lines.reduce((sum, l) => sum + (l.cost ?? 0), 0) / yieldQty;
        const dishPrice = recipeForm.dish.price === '' ? undefined : Number(recipeForm.dish.price);
        const price = dishPrice !== undefined && Number.isFinite(dishPrice) ? dishPrice : undefined;
        const targetPct = Number(targetFoodCost);
        const suggested = complete && targetPct > 0 && targetPct < 100
          ? Math.ceil((costPerServing / (targetPct / 100)) * 4) / 4
          : null;
        const foodCostPct = complete && typeof price === 'number' && price > 0 ? (costPerServing / price) * 100 : null;
        const isNew = recipeForm.product_id === 'new';
        const setDish = (patch: Partial<DishForm>) => setRecipeForm({ ...recipeForm, dish: { ...recipeForm.dish, ...patch } });
        const margin = complete && typeof price === 'number' ? price - costPerServing : null;
        const fieldClass = 'w-full px-4 py-3 text-base border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card';
        const labelClass = 'block text-sm font-medium text-muted-foreground mb-1';
        const sectionClass = 'rounded-xl border border-border p-4 sm:p-5 space-y-4';
        const sectionTitle = 'text-base font-semibold text-foreground';
        const photoSrc = recipeForm.dish.image === 'EXISTING'
          ? (isNew ? null : `${api.defaults.baseURL}/products/${recipeForm.product_id}/image`)
          : recipeForm.dish.image;
        const tilePhoto = photoSrc ?? genericMenuPhoto(recipeForm.dish.name);
        const compactField = 'w-full px-3 py-1.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card';
        const statLabel = 'text-xs font-medium text-muted-foreground';
        const addLine = () => setRecipeForm({
          ...recipeForm,
          items: [...recipeForm.items, { supply_id: supplies[0]?.id || '', group_name: '', quantity: '1', unit: (supplies[0]?.base_unit || 'each') as SupplyUnit }],
        });
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
            <div className="bg-card rounded-2xl w-full max-w-6xl h-[96vh] flex flex-col overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
                <div className="flex items-center gap-3 min-w-0">
                  <h2 className="text-xl font-bold truncate">
                    {recipeForm.dish.name.trim() || (editingRecipe ? t('editRecipe') : t('addRecipe'))}
                  </h2>
                  {editingRecipe && editingRecipe.is_active !== 1 && <Badge variant="secondary">{t('draft')}</Badge>}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  {recipeForm.product_id !== '' && (
                    <Button type="button" variant="outline" size="sm" disabled={aiBusy} onClick={handleAiHelp}>
                      <Sparkles size={16} className="me-1" /> {aiBusy ? '…' : t('aiHelp')}
                    </Button>
                  )}
                  {recipeForm.product_id !== '' && (
                    <button type="button" role="switch" aria-checked={recipeForm.dish.is_active}
                      onClick={() => setDish({ is_active: !recipeForm.dish.is_active })}
                      className="flex items-center gap-2">
                      <span className={`relative inline-block h-7 w-12 rounded-full transition-colors ${recipeForm.dish.is_active ? 'bg-green-600' : 'bg-gray-500'}`}>
                        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${recipeForm.dish.is_active ? 'start-[1.5rem]' : 'start-0.5'}`} />
                      </span>
                      <span className={`text-sm font-semibold ${recipeForm.dish.is_active ? 'text-green-600' : 'text-muted-foreground'}`}>
                        {recipeForm.dish.is_active ? t('onPos') : t('offPos')}
                      </span>
                    </button>
                  )}
                  <button type="button" onClick={() => setShowRecipeForm(false)}><X size={24} className="text-gray-400" /></button>
                </div>
              </div>

              {(aiMissing.length > 0 || aiPhotos.length > 0) && (
                <div className="px-5 py-2 text-xs border-b border-border bg-muted">
                  {aiMissing.length > 0 && <span className="text-amber-600">{t('aiNotInInventory', { names: aiMissing.join(', ') })} </span>}
                  <span className="text-muted-foreground">{t('aiDraftNote')}</span>
                </div>
              )}

              <form id="recipe-form" onSubmit={handleSaveRecipe}
                className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden grid gap-4 p-4 lg:grid-cols-[1fr_20rem]">
                <div className="flex flex-col gap-3 min-h-0">
                  {!editingRecipe && (
                    <div>
                      <select value={recipeForm.product_id}
                        onChange={(e) => {
                          const picked = e.target.value;
                          setRecipeForm({ ...recipeForm, product_id: picked, dish: picked === 'new' ? emptyDish : dishFromProduct(products.find((p) => p.id === picked)) });
                        }}
                        className={compactField} required>
                        <option value="">{t('product')}</option>
                        <option value="new">{t('newMenuItem')}</option>
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                  )}
                  {recipeForm.product_id !== '' && (
                    <div className="flex items-end gap-3">
                      <button type="button" onClick={() => setShowPhotoPicker(true)} title={t('dishPhoto')}
                        className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-dashed border-border bg-muted hover:ring-2 hover:ring-brand">
                        {tilePhoto
                          ? <img src={tilePhoto} alt="" className="h-full w-full object-cover" />
                          : <Camera size={24} className="mx-auto text-muted-foreground" />}
                        {aiPhotos.length > 0 && <span className="absolute bottom-0 end-0 rounded-tl-md bg-brand px-1 text-[10px] text-white">{aiPhotos.length}</span>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <label className={statLabel}>{t('dishName')}</label>
                        <input type="text" value={recipeForm.dish.name} onChange={(e) => setDish({ name: e.target.value })}
                          className={compactField} required />
                      </div>
                      <div className="w-44">
                        <label className={statLabel}>{t('dishCategory')}</label>
                        <select value={recipeForm.dish.category_id} onChange={(e) => setDish({ category_id: e.target.value })}
                          className={compactField} required={isNew}>
                          <option value="">{t('chooseCategory')}</option>
                          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </div>
                      <div className="w-20">
                        <label className={statLabel}>{t('yield')}</label>
                        <input type="number" step="any" min="0.00000001" value={recipeForm.yield_quantity}
                          onChange={(e) => setRecipeForm({ ...recipeForm, yield_quantity: e.target.value })}
                          className={compactField} required />
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => setShowDetails(true)}>
                        <SlidersHorizontal size={14} className="me-1" /> {t('moreDetails')}
                      </Button>
                    </div>
                  )}

                  {recipeForm.product_id !== '' && (
                    <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-border">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                        <h3 className="text-sm font-semibold">{t('sectionIngredients')}</h3>
                        <Button type="button" variant="outline" size="sm" onClick={addLine}>
                          <Plus size={14} /> {t('addComponent')}
                        </Button>
                      </div>
                      {recipeForm.items.length > 0 && (
                        <div className="hidden sm:grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem_6rem_2rem] gap-2 px-3 pt-2 text-[11px] uppercase text-muted-foreground">
                          <span>{t('recipeIngredient')}</span><span>{t('recipeAmount')}</span><span>{t('baseUnit')}</span>
                          <span className="text-end">{t('recipeLineCost')}</span><span className="text-end">{t('recipeInStock')}</span><span />
                        </div>
                      )}
                      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1.5">
                        {recipeForm.items.map((item, index) => {
                          const line = lines[index];
                          return (
                            <div key={index} className="grid grid-cols-2 sm:grid-cols-[1fr_5.5rem_4.5rem_4.5rem_6rem_2rem] gap-2 items-center">
                              <select value={item.group_name ? `group:${item.group_name}` : item.supply_id}
                                onChange={(e) => {
                                  const items = [...recipeForm.items];
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
                                  setRecipeForm({ ...recipeForm, items });
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
                                  const items = [...recipeForm.items];
                                  items[index] = { ...items[index], quantity: e.target.value };
                                  setRecipeForm({ ...recipeForm, items });
                                }}
                                className={compactField} required />
                              <select value={item.unit}
                                onChange={(e) => {
                                  const items = [...recipeForm.items];
                                  items[index] = { ...items[index], unit: e.target.value as SupplyUnit };
                                  setRecipeForm({ ...recipeForm, items });
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
                                onClick={() => setRecipeForm({ ...recipeForm, items: recipeForm.items.filter((_, i) => i !== index) })}>
                                <X size={14} />
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {recipeForm.product_id !== '' && (
                  <div className="flex flex-col gap-3 rounded-xl border border-border p-4 min-h-0 overflow-y-auto">
                    <h3 className="text-sm font-semibold">{t('sectionPricing')}</h3>
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
                      <Button type="button" variant="outline" size="sm" disabled={suggested === null}
                        onClick={() => suggested !== null && setDish({ price: String(suggested) })}>
                        {t('suggestedPrice')}: {suggested === null ? '—' : fmtNum(suggested)}
                      </Button>
                    </div>
                    <div className="rounded-xl bg-muted p-3">
                      <label className="block text-sm font-semibold mb-1">{t('actualPrice')}</label>
                      <input type="number" step="any" min="0" value={recipeForm.dish.price}
                        onChange={(e) => setDish({ price: e.target.value })}
                        className="w-full px-3 py-2 text-2xl font-bold border-2 border-brand rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card" required />
                    </div>
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
                    <Button type="submit" size="lg" className="mt-auto w-full text-base"
                      disabled={recipeForm.items.length === 0}>{tCommon('save')}</Button>
                  </div>
                )}
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
                      <input type="text" value={recipeForm.dish.sku} onChange={(e) => setDish({ sku: e.target.value })}
                        placeholder={isNew && nextSku(products) ? t('skuAuto', { sku: nextSku(products) ?? '' }) : ''} className={compactField} />
                    </div>
                    <div>
                      <label className={statLabel}>{t('dishBarcode')}</label>
                      <input type="text" value={recipeForm.dish.barcode} onChange={(e) => setDish({ barcode: e.target.value })} className={compactField} />
                    </div>
                  </div>
                  <div>
                    <label className={statLabel}>{t('dishDescription')}</label>
                    <textarea rows={3} value={recipeForm.dish.description} onChange={(e) => setDish({ description: e.target.value })} className={compactField} />
                  </div>
                  {taxCategories.length > 0 && (
                    <div>
                      <label className={statLabel}>{t('dishTaxCategory')}</label>
                      <select value={recipeForm.dish.tax_category_id} onChange={(e) => setDish({ tax_category_id: e.target.value })} className={compactField}>
                        <option value="">{t('taxStoreDefault')}</option>
                        {taxCategories.map((tc) => <option key={tc.id} value={tc.id}>{tc.label}</option>)}
                      </select>
                    </div>
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
                    value={recipeForm.dish.image}
                    onChange={(val) => { setDish({ image: val, imageTouched: true }); if (val) setShowPhotoPicker(false); }}
                    productId={isNew ? undefined : recipeForm.product_id}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {deletingSupply && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold mb-2">{tCommon('delete')}</h2>
            <p className="text-sm text-muted-foreground mb-4">{t('confirmDeleteSupply', { name: deletingSupply.name })}</p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setDeletingSupply(null)}>{tCommon('cancel')}</Button>
              <Button variant="destructive" onClick={handleDeleteSupply}>{tCommon('delete')}</Button>
            </div>
          </div>
        </div>
      )}

      {deletingRecipe && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold mb-2">{tCommon('delete')}</h2>
            <p className="text-sm text-muted-foreground mb-4">{t('confirmDeleteRecipe', { name: deletingRecipe.product_name || deletingRecipe.product_id })}</p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setDeletingRecipe(null)}>{tCommon('cancel')}</Button>
              <Button variant="destructive" onClick={handleDeleteRecipe}>{tCommon('delete')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
