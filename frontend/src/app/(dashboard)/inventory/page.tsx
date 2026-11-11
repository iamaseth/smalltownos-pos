'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import toast from 'react-hot-toast';
import { Plus, Search, X, Edit, Trash2, Check, ArrowDownCircle, ArrowUpCircle, PackageMinus, ClipboardList, Scale, Truck, Upload, Sparkles } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { tenantCan } from '@/lib/permissions';
import ImageUploader from '@/components/products/ImageUploader';

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
  is_active?: number | boolean;
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
}

const emptyDish: DishForm = { name: '', category_id: '', price: '', image: null, imageTouched: false };

const dishFromProduct = (p: Product | undefined): DishForm => (p
  ? { name: p.name, category_id: p.category_id ?? '', price: p.price === undefined ? '' : String(p.price), image: p.has_image ? 'EXISTING' : null, imageTouched: false }
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
  const productsWithoutRecipe = useMemo(() => {
    const have = new Set(recipes.map((r) => r.product_id));
    return products.filter((p) => !have.has(p.id));
  }, [products, recipes]);
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
      const product = products.find((p) => p.id === r.product_id);
      const hidden = product !== undefined && !(product.is_active === true || product.is_active === 1);
      if (hidden) await api.put(`/products/${r.product_id}`, { is_active: true });
      toast.success(hidden ? t('recipeConfirmedShown') : t('recipeConfirmed'));
      refresh();
    } catch (err: unknown) {
      toast.error(importError(err));
    }
  };

  const openAddRecipe = (productId = '') => {
    setEditingRecipe(null);
    setRecipeForm({ product_id: productId, yield_quantity: '1', dish: dishFromProduct(products.find((p) => p.id === productId)), items: [] });
    setShowRecipeForm(true);
  };

  const openEditRecipe = (r: Recipe) => {
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
          is_active: false,
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
        }
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
            <Button variant="outline" disabled title={t('comingSoon')}>
              <Sparkles size={16} className="me-1" /> {t('aiRecipeHelper')}
              <Badge variant="secondary" className="ms-2">{t('comingSoon')}</Badge>
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
                {recipes.map((r) => (
                  <tr key={r.id} className="hover:bg-muted">
                    <td className="p-4 font-medium text-foreground">
                      {r.product_name || r.product_id}
                      {r.is_active !== 1 && <Badge variant="secondary" className="ms-2">{t('draft')}</Badge>}
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
            {recipes.length === 0 && <p className="text-center text-muted-foreground py-12">{t('emptyRecipes')}</p>}
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
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-card rounded-2xl p-6 sm:p-8 w-full max-w-4xl max-h-[92vh] overflow-y-auto">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-bold">
                  {editingRecipe ? t('editRecipe') : t('addRecipe')}
                  {editingRecipe && editingRecipe.is_active !== 1 && <Badge variant="secondary" className="ms-3 align-middle">{t('draft')}</Badge>}
                </h2>
                <button onClick={() => setShowRecipeForm(false)}><X size={24} className="text-gray-400" /></button>
              </div>
              <form onSubmit={handleSaveRecipe} className="space-y-6">
                <div>
                  <label className={labelClass}>{t('product')}</label>
                  <select value={recipeForm.product_id}
                    onChange={(e) => {
                      const picked = e.target.value;
                      setRecipeForm({ ...recipeForm, product_id: picked, dish: picked === 'new' ? emptyDish : dishFromProduct(products.find((p) => p.id === picked)) });
                    }}
                    className={fieldClass} required disabled={Boolean(editingRecipe)}>
                    <option value="">{t('product')}</option>
                    {!editingRecipe && <option value="new">{t('newMenuItem')}</option>}
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  {isNew && <p className="text-xs text-muted-foreground mt-1">{t('hiddenUntilConfirmed')}</p>}
                </div>

                {recipeForm.product_id !== '' && (
                  <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                    <div className="grid gap-4">
                      <div>
                        <label className={labelClass}>{t('dishName')}</label>
                        <input type="text" value={recipeForm.dish.name} onChange={(e) => setDish({ name: e.target.value })}
                          className={fieldClass} required />
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className={labelClass}>{t('dishCategory')}</label>
                          <select value={recipeForm.dish.category_id} onChange={(e) => setDish({ category_id: e.target.value })}
                            className={fieldClass} required={isNew}>
                            <option value="">{t('chooseCategory')}</option>
                            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={labelClass}>{t('actualPrice')}</label>
                          <input type="number" step="any" min="0" value={recipeForm.dish.price}
                            onChange={(e) => setDish({ price: e.target.value })}
                            className={fieldClass} required />
                          <p className="text-xs text-muted-foreground mt-1">{t('actualPriceHint')}</p>
                        </div>
                      </div>
                      <div>
                        <label className={labelClass}>{t('yield')}</label>
                        <input type="number" step="any" min="0.00000001" value={recipeForm.yield_quantity}
                          onChange={(e) => setRecipeForm({ ...recipeForm, yield_quantity: e.target.value })}
                          className={fieldClass} required />
                      </div>
                    </div>
                    <div>
                      <label className={labelClass}>{t('dishPhoto')}</label>
                      <ImageUploader
                        value={recipeForm.dish.image}
                        onChange={(val) => setDish({ image: val, imageTouched: true })}
                        productId={isNew ? undefined : recipeForm.product_id}
                      />
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-lg font-semibold text-foreground">{t('components')}</span>
                    <Button type="button" variant="outline"
                      onClick={() => setRecipeForm({
                        ...recipeForm,
                        items: [...recipeForm.items, { supply_id: supplies[0]?.id || '', group_name: '', quantity: '1', unit: (supplies[0]?.base_unit || 'each') as SupplyUnit }],
                      })}>
                      <Plus size={16} /> {t('addComponent')}
                    </Button>
                  </div>
                  {recipeForm.items.length > 0 && (
                    <div className="hidden sm:grid grid-cols-[1fr_7rem_6rem_6rem_8rem_2.5rem] gap-2 px-1 mb-1 text-xs uppercase text-muted-foreground">
                      <span>{t('recipeIngredient')}</span><span>{t('recipeAmount')}</span><span>{t('baseUnit')}</span>
                      <span className="text-end">{t('recipeLineCost')}</span><span className="text-end">{t('recipeInStock')}</span><span />
                    </div>
                  )}
                  {recipeForm.items.map((item, index) => {
                    const line = lines[index];
                    return (
                      <div key={index} className="grid grid-cols-2 sm:grid-cols-[1fr_7rem_6rem_6rem_8rem_2.5rem] gap-2 mb-3 items-center">
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
                          className={`${fieldClass} col-span-2 sm:col-span-1 min-w-0`}>
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
                          className={fieldClass} required />
                        <select value={item.unit}
                          onChange={(e) => {
                            const items = [...recipeForm.items];
                            items[index] = { ...items[index], unit: e.target.value as SupplyUnit };
                            setRecipeForm({ ...recipeForm, items });
                          }}
                          className={fieldClass}>
                          {SUPPLY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                        <span className={`text-end text-base ${line.cost === null ? 'text-amber-600' : ''}`}>
                          {line.cost === null ? '—' : fmtNum(Math.round(line.cost * 100) / 100)}
                        </span>
                        <span className={`text-end text-sm ${line.supply && Number(line.supply.stock_quantity) <= 0 ? 'text-red-600' : 'text-muted-foreground'}`}>
                          {line.supply ? `${fmtNum(Number(line.supply.stock_quantity))} ${line.supply.base_unit}` : '—'}
                        </span>
                        <Button type="button" variant="ghost" size="icon-sm"
                          onClick={() => setRecipeForm({ ...recipeForm, items: recipeForm.items.filter((_, i) => i !== index) })}>
                          <X size={16} />
                        </Button>
                      </div>
                    );
                  })}
                </div>

                <div className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
                  <div>
                    <label className={labelClass}>{t('targetFoodCost')}</label>
                    <input type="number" step="any" min="1" max="99" value={targetFoodCost}
                      onChange={(e) => updateTargetFoodCost(e.target.value)} className={fieldClass} />
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">{t('suggestedPrice')}</p>
                    <p className="text-2xl font-bold">{suggested === null ? '—' : fmtNum(suggested)}</p>
                    {foodCostPct !== null && (
                      <p className="text-sm text-muted-foreground">{t('foodCostNow', { percent: fmtNum(Math.round(foodCostPct * 10) / 10) })}</p>
                    )}
                  </div>
                  <Button type="button" variant="outline" disabled={suggested === null}
                    onClick={() => suggested !== null && setDish({ price: String(suggested) })}>
                    {t('useSuggested')}
                  </Button>
                </div>

                <div className="grid grid-cols-3 gap-3 rounded-xl bg-muted p-4 text-center">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">{t('recipeCostPerServing')}</p>
                    <p className="text-xl font-bold">{lines.length === 0 ? '—' : fmtNum(Math.round(costPerServing * 100) / 100)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">{t('actualPrice')}</p>
                    <p className="text-xl font-bold">{typeof price === 'number' ? fmtNum(price) : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">{t('marginAtActual')}</p>
                    <p className="text-xl font-bold">
                      {margin === null ? '—' : `${fmtNum(Math.round(margin * 100) / 100)} (${fmtNum(Math.round((margin / (price as number)) * 1000) / 10)}%)`}
                    </p>
                  </div>
                </div>

                <Button type="submit" size="lg" className="w-full text-base" disabled={recipeForm.items.length === 0}>{tCommon('save')}</Button>
              </form>
            </div>
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
