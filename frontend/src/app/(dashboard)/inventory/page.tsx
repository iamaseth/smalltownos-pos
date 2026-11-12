'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import toast from 'react-hot-toast';
import { Plus, Search, UtensilsCrossed, X, Edit, Trash2, Check, ArrowDownCircle, ArrowUpCircle, PackageMinus, ClipboardList, Scale, Truck, Upload, Sparkles, Printer, Download } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { tenantCan } from '@/lib/permissions';
import { parseCsv, downloadCsv } from '@/lib/csv-table';
import MenuItemEditor, { SUPPLY_UNITS, type SupplyUnit, type Recipe, type RecipeItem, type MenuProduct as Product, type MenuCategory as Category } from '@/components/products/MenuItemEditor';

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
  ingredient_only: number;
  product_number: string | null;
  vendors?: SupplyVendor[];
  current_unit_cost?: number | null;
  next_unit_cost?: number | null;
  is_active: number;
  is_low_stock?: number;
}

interface SupplyVendor {
  vendor_id: string;
  vendor_name: string | null;
  vendor_item_name: string | null;
  pack_size: number | null;
  pack_label: string | null;
  unit_cost: number | null;
  is_preferred: number;
}

interface VendorLine {
  vendor_id: string;
  vendor_item_name: string;
  pack_size: string;
  pack_label: string;
  pack_price: string;
  is_preferred: boolean;
}

interface Vendor {
  id: string;
  name: string;
}

interface OrderListItem {
  supply_id: string;
  product_number: string | null;
  name: string;
  vendor_item_name: string | null;
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
  unit_cost: '', pack_size: '', pack_label: '', pour_size: '', order_up_to: '', group_name: '', ingredient_only: false,
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

const photoKey = (name: string) => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const movementTypeIcons: Record<string, typeof ArrowUpCircle> = {
  receive: ArrowUpCircle,
  count: Scale,
  adjustment: Edit,
  waste: PackageMinus,
  recipe_depletion: ArrowDownCircle,
  recipe_restore: ArrowUpCircle,
};

interface ImportPreview {
  to_create: { name: string; base_unit: SupplyUnit; pack_size: number | null; pack_label: string | null; pack_price: number | null }[];
  already_exist: string[];
  errors: { row: number; name: string; error: string }[];
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
  const [categories, setCategories] = useState<Category[]>([]);
  const [taxCategories, setTaxCategories] = useState<{ id: string; label: string }[]>([]);
  const [menuSupply, setMenuSupply] = useState<Supply | null>(null);
  const [linkPlan, setLinkPlan] = useState<{ matches: { product: Product; supply: Supply }[]; unmatched: Product[] } | null>(null);
  const [linking, setLinking] = useState(false);
  const canAddToMenu = tenantCan(currentTenant, 'catalog.manage');
  const onMenuSupplyIds = new Set(recipes.filter((r) => r.items.length === 1 && r.items[0].supply_id).map((r) => r.items[0].supply_id as string));
  const onMenuGroups = new Set(recipes.filter((r) => r.items.length === 1 && r.items[0].group_name).map((r) => (r.items[0].group_name as string).toLowerCase()));
  const [showDelivery, setShowDelivery] = useState(false);
  const [deliveryVendorId, setDeliveryVendorId] = useState('');
  const [newVendorName, setNewVendorName] = useState('');
  const [deliveryReference, setDeliveryReference] = useState('');
  const [deliveryLines, setDeliveryLines] = useState<DeliveryLine[]>([]);

  const [showOrderList, setShowOrderList] = useState(false);
  const [orderGroups, setOrderGroups] = useState<OrderListGroup[]>([]);
  const [orderListLoading, setOrderListLoading] = useState(false);

  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, string>[]>([]);
  const [importVendor, setImportVendor] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);

  const [movementSupply, setMovementSupply] = useState<Supply | null>(null);
  const [movementForm, setMovementForm] = useState({ movement_type: 'receive', quantity: '', unit: 'each' as SupplyUnit, reason: '' });

  const productByName = new Map<string, Product>();
  for (const p of products) {
    const key = photoKey(p.name);
    if (!productByName.get(key)?.has_image) productByName.set(key, p);
  }
  const supplyProduct = new Map<string, Product>();
  for (const single of [true, false]) {
    for (const r of recipes) {
      if ((r.items.length === 1) !== single) continue;
      const product = products.find((p) => p.id === r.product_id);
      if (!product?.has_image) continue;
      for (const item of r.items) if (item.supply_id && !supplyProduct.has(item.supply_id)) supplyProduct.set(item.supply_id, product);
    }
  }

  const [deletingSupply, setDeletingSupply] = useState<Supply | null>(null);

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
  const exportSupplies = () => {
    const rows: (string | number | null)[][] = [['product_number', 'name', 'group', 'base_unit', 'stock', 'par_level', 'order_up_to', 'unit_cost', 'pack_size', 'pack_label', 'pack_price', 'pour_size']];
    for (const s of supplies) {
      rows.push([
        s.product_number, s.name, s.group_name, s.base_unit, s.stock_quantity, s.low_stock_threshold, s.order_up_to, s.unit_cost, s.pack_size, s.pack_label,
        s.unit_cost !== null && s.pack_size ? Math.round(Number(s.unit_cost) * Number(s.pack_size) * 100) / 100 : null, s.pour_size,
      ]);
    }
    downloadCsv('ingredients.csv', rows);
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
    if (!canManage || tab === 'movements') return;
    const controller = new AbortController();
    Promise.all([
      api.get('/recipes', { signal: controller.signal }),
      api.get('/products', { signal: controller.signal }),
      api.get('/categories', { signal: controller.signal }),
    ])
      .then(([recipesRes, productsRes, categoriesRes]) => {
        setCategories(categoriesRes.data.categories || []);
        setRecipes(recipesRes.data.recipes || []);
        setProducts(productsRes.data.products || []);
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(t('loadFailed'));
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, refreshKey, canManage]);

  useEffect(() => {
    if (!canManage || !canAddToMenu) return;
    api.get('/tax/categories')
      .then(({ data }) => setTaxCategories((data.categories || []) as { id: string; label: string }[]))
      .catch(() => undefined);
  }, [canManage, canAddToMenu]);

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

  const [vendorLines, setVendorLines] = useState<VendorLine[]>([]);

  const openAddSupply = () => {
    setVendorLines([]);
    setEditingSupply(null);
    setSupplyForm(emptySupplyForm);
    setShowSupplyForm(true);
  };

  const openEditSupply = (s: Supply) => {
    setVendorLines((s.vendors ?? []).map((v) => ({
      vendor_id: v.vendor_id,
      vendor_item_name: v.vendor_item_name ?? '',
      pack_size: v.pack_size === null ? '' : String(v.pack_size),
      pack_label: v.pack_label ?? '',
      pack_price: v.unit_cost !== null && v.pack_size ? String(Math.round(v.unit_cost * v.pack_size * 100) / 100) : '',
      is_preferred: v.is_preferred === 1,
    })));
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
      group_name: s.group_name ?? '',
      ingredient_only: s.ingredient_only === 1,
    });
    setShowSupplyForm(true);
  };

  const saveVendorLines = async (supplyId: string) => {
    const lines = vendorLines.filter((line) => line.vendor_id);
    if (lines.length === 0 && !editingSupply) return;
    await api.put(`/supplies/${supplyId}/vendors`, {
      vendors: lines.map((line) => ({
        vendor_id: line.vendor_id,
        vendor_item_name: line.vendor_item_name.trim() || null,
        pack_size: optionalNumber(line.pack_size),
        pack_label: line.pack_label.trim() || null,
        pack_price: optionalNumber(line.pack_price),
        is_preferred: line.is_preferred,
      })),
    });
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
        group_name: supplyForm.group_name.trim() || null,
        ingredient_only: supplyForm.ingredient_only,
      };
      if (editingSupply) {
        const saved = await api.put(`/supplies/${editingSupply.id}`, {
          name: payload.name,
          low_stock_threshold: payload.low_stock_threshold,
          unit_cost: payload.unit_cost,
          pack_size: payload.pack_size,
          pack_label: payload.pack_label,
          pour_size: payload.pour_size,
          order_up_to: payload.order_up_to,
          group_name: payload.group_name,
          ingredient_only: payload.ingredient_only,
        });
        void saved;
        await saveVendorLines(editingSupply.id);
        toast.success(tCommon('save'));
      } else {
        const created = await api.post('/supplies', payload);
        await saveVendorLines(created.data.supply.id);
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

  const openLinkMenuItems = () => {
    const withRecipe = new Set(recipes.map((r) => r.product_id));
    const bySupplyName = new Map<string, Supply>();
    for (const s of supplies) if (s.ingredient_only !== 1 && s.is_active === 1) bySupplyName.set(photoKey(s.name), s);
    const matches: { product: Product; supply: Supply }[] = [];
    const unmatched: Product[] = [];
    for (const product of products) {
      if (withRecipe.has(product.id)) continue;
      const supply = bySupplyName.get(photoKey(product.name));
      if (supply) matches.push({ product, supply }); else unmatched.push(product);
    }
    setLinkPlan({ matches, unmatched });
  };

  const handleLinkMenuItems = async () => {
    if (!linkPlan || linking) return;
    setLinking(true);
    let linked = 0;
    for (const { product, supply } of linkPlan.matches) {
      try {
        await api.put(`/recipes/product/${product.id}`, {
          yield_quantity: 1,
          is_active: false,
          items: [{ supply_id: supply.id, quantity: supply.pour_size ?? 1, unit: supply.base_unit }],
        });
        linked += 1;
      } catch { /* the rest are still linked; the count below shows how many worked */ }
    }
    setLinking(false);
    setLinkPlan(null);
    toast.success(t('linkMenuDone', { count: linked }));
    refresh();
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
    const shown = item.vendor_item_name || item.name;
    const label = item.product_number ? `${item.product_number} ${shown}` : shown;
    if (item.order_quantity === null) return `${label}: ${t('orderListNeedTarget')}`;
    const amount = item.packs !== null
      ? `${fmtNum(item.packs)} ${item.pack_label || t('packs')} (${fmtNum(item.order_quantity)} ${item.base_unit})`
      : `${fmtNum(item.order_quantity)} ${item.base_unit}`;
    return `${label}: ${amount}`;
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
            <Button variant="outline" onClick={openLinkMenuItems}><UtensilsCrossed size={16} className="me-1" /> {t('linkMenuItems')}</Button>
            <Button variant="outline" onClick={openOrderList}><ClipboardList size={16} className="me-1" /> {t('orderList')}</Button>
            <Button variant="outline" onClick={openImport}><Upload size={16} className="me-1" /> {t('importIngredients')}</Button>
            <Button variant="outline" onClick={openDelivery}><Truck size={16} className="me-1" /> {t('receiveDelivery')}</Button>
            <Button onClick={openAddSupply}><Plus size={16} className="me-1" /> {t('addSupply')}</Button>
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="supplies">{t('tabSupplies')}</TabsTrigger>
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
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('productNumber')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('supplyName')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('group')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('vendor')}</th>
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
                    <td className="p-4 text-xs font-mono text-muted-foreground whitespace-nowrap">{s.product_number || '—'}</td>
                    <td className="p-4 font-medium text-foreground">
                      <div className="flex items-center gap-3">
                        {(() => {
                          const match = supplyProduct.get(s.id) ?? productByName.get(photoKey(s.name));
                          return match?.has_image
                            ? <img src={`${api.defaults.baseURL}/products/${match.id}/image?t=${match.updated_at ?? ''}`} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0 border border-border" loading="lazy" />
                            : <div className="w-10 h-10 rounded-lg bg-muted shrink-0 border border-border" />;
                        })()}
                        <span>
                          {s.name}
                          {s.is_low_stock === 1 && (
                            <Badge variant="destructive" className="ms-2">{t('lowStock')}</Badge>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-muted-foreground">{s.group_name || '—'}</td>
                    <td className="p-4 text-sm text-muted-foreground">{(() => {
                      const list = s.vendors ?? [];
                      if (list.length === 0) return '—';
                      const detail = list.map((v) => `${v.vendor_name ?? ''}${v.vendor_item_name ? ` — ${v.vendor_item_name}` : ''}${v.unit_cost !== null && v.pack_size ? ` — ${fmtNum(Math.round(v.unit_cost * v.pack_size * 100) / 100)}${v.pack_label ? ` / ${v.pack_label}` : ''}` : ''}`).join('\n');
                      return <span title={detail}>{list[0].vendor_name}{list.length > 1 ? ` ${t('alsoVendors', { count: list.length - 1 })}` : ''}</span>;
                    })()}</td>
                    <td className="p-4 text-center text-sm text-muted-foreground">{s.base_unit}</td>
                    <td className={`p-4 text-end text-sm font-medium ${Number(s.stock_quantity) < 0 ? 'text-red-600' : ''}`}>{fmtNum(Number(s.stock_quantity))} {s.base_unit}</td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {s.low_stock_threshold === null ? '—' : fmtNum(Number(s.low_stock_threshold))}
                    </td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {(s.current_unit_cost ?? s.unit_cost) === null ? '—' : fmtNum(Number(s.current_unit_cost ?? s.unit_cost))}
                      {s.next_unit_cost != null && (
                        <span className="block text-xs" title={t('nextPrice')}>→ {fmtNum(Number(s.next_unit_cost))}</span>
                      )}
                    </td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {(s.current_unit_cost ?? s.unit_cost) === null || !s.pack_size
                        ? '—'
                        : `${fmtNum(Math.round(Number(s.current_unit_cost ?? s.unit_cost) * Number(s.pack_size) * 100) / 100)}${s.pack_label ? ` / ${s.pack_label}` : ''}`}
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
                        {canAddToMenu && s.ingredient_only !== 1 && !onMenuSupplyIds.has(s.id) && !(s.group_name && onMenuGroups.has(s.group_name.toLowerCase())) && (
                          <Button variant="ghost" size="sm" onClick={() => setMenuSupply(s)} title={t('addToMenu')} aria-label={t('addToMenu')}>
                            <UtensilsCrossed size={14} />
                          </Button>
                        )}
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
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={supplyForm.ingredient_only}
                  onChange={(e) => setSupplyForm({ ...supplyForm, ingredient_only: e.target.checked })} />
                {t('ingredientOnly')}
              </label>
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('vendorsTitle')}</p>
                {vendorLines.map((line, index) => (
                  <div key={index} className="border rounded-lg p-2 space-y-2">
                    <div className="flex gap-2">
                      <select value={line.vendor_id}
                        onChange={(e) => setVendorLines(vendorLines.map((l, i) => (i === index ? { ...l, vendor_id: e.target.value } : l)))}
                        className="flex-1 min-w-0 px-2 py-1.5 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                        <option value="">{t('noVendor')}</option>
                        {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                      <label className="flex items-center gap-1 text-xs whitespace-nowrap">
                        <input type="radio" name="preferred-vendor" checked={line.is_preferred}
                          onChange={() => setVendorLines(vendorLines.map((l, i) => ({ ...l, is_preferred: i === index })))} />
                        {t('preferredVendor')}
                      </label>
                      <button type="button" onClick={() => setVendorLines(vendorLines.filter((_, i) => i !== index))} aria-label={tCommon('delete')}>
                        <X size={16} className="text-gray-400" />
                      </button>
                    </div>
                    <input type="text" placeholder={t('vendorItemName')} value={line.vendor_item_name}
                      onChange={(e) => setVendorLines(vendorLines.map((l, i) => (i === index ? { ...l, vendor_item_name: e.target.value } : l)))}
                      className="w-full px-2 py-1.5 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                    <div className="flex gap-2">
                      <input type="number" step="any" min="0" placeholder={t('packSize')} value={line.pack_size}
                        onChange={(e) => setVendorLines(vendorLines.map((l, i) => (i === index ? { ...l, pack_size: e.target.value } : l)))}
                        className="flex-1 min-w-0 px-2 py-1.5 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                      <input type="text" placeholder={t('packLabel')} value={line.pack_label}
                        onChange={(e) => setVendorLines(vendorLines.map((l, i) => (i === index ? { ...l, pack_label: e.target.value } : l)))}
                        className="flex-1 min-w-0 px-2 py-1.5 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                      <input type="number" step="any" min="0" placeholder={t('packPrice')} value={line.pack_price}
                        onChange={(e) => setVendorLines(vendorLines.map((l, i) => (i === index ? { ...l, pack_price: e.target.value } : l)))}
                        className="flex-1 min-w-0 px-2 py-1.5 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                    </div>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm"
                  onClick={() => setVendorLines([...vendorLines, { vendor_id: '', vendor_item_name: '', pack_size: '', pack_label: '', pack_price: '', is_preferred: vendorLines.length === 0 }])}>
                  <Plus size={14} className="me-1" /> {t('addVendorLine')}
                </Button>
              </div>
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

      {menuSupply && (
        <MenuItemEditor
          key={menuSupply.id}
          productId="new"
          recipe={null}
          prefill={{ name: menuSupply.group_name || menuSupply.name, supply_id: menuSupply.id, group_name: menuSupply.group_name, quantity: menuSupply.pour_size ?? 1, unit: menuSupply.base_unit }}
          products={products}
          categories={categories}
          supplies={supplies}
          taxCategories={taxCategories}
          canEditProduct={canAddToMenu}
          canEditRecipe={tenantCan(currentTenant, 'supplies.manage')}
          onClose={() => setMenuSupply(null)}
          onSaved={() => { setMenuSupply(null); refresh(); }}
        />
      )}

      {linkPlan && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('linkMenuItems')}</h2>
              <button onClick={() => setLinkPlan(null)}><X size={20} className="text-gray-400" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-3">{t('linkMenuHelp')}</p>
            <ul className="max-h-48 overflow-y-auto text-sm divide-y divide-border mb-3">
              {linkPlan.matches.map(({ product, supply }) => (
                <li key={product.id} className="py-1">{product.name} → {fmtNum(supply.pour_size ?? 1)} {supply.base_unit}</li>
              ))}
            </ul>
            {linkPlan.unmatched.length > 0 && (
              <div className="mb-4">
                <p className="text-sm text-amber-600">{t('linkMenuUnmatched', { count: linkPlan.unmatched.length })}</p>
                <p className="max-h-24 overflow-y-auto text-xs text-muted-foreground">{linkPlan.unmatched.map((p) => p.name).join(', ')}</p>
              </div>
            )}
            <div className="flex justify-end">
              <Button onClick={handleLinkMenuItems} disabled={linking || linkPlan.matches.length === 0}>
                {t('linkMenuConfirm', { count: linkPlan.matches.length })}
              </Button>
            </div>
          </div>
        </div>
      )}

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

    </div>
  );
}
