'use client';

import { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import toast from 'react-hot-toast';
import { Plus, Search, X, Edit, Trash2, ArrowDownCircle, ArrowUpCircle, PackageMinus, ClipboardList, Scale, Truck, Upload } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { tenantCan } from '@/lib/permissions';

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
  is_active: number;
  is_low_stock?: number;
}

interface Vendor {
  id: string;
  name: string;
}

interface DeliveryLine {
  supply_id: string;
  amount: string;
  price: string;
}

const emptySupplyForm = {
  name: '', base_unit: 'each' as SupplyUnit, stock_quantity: '0', low_stock_threshold: '',
  unit_cost: '', pack_size: '', pack_label: '', pour_size: '', order_up_to: '', vendor_id: '',
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
}

interface Product {
  id: string;
  name: string;
}

const movementTypeIcons: Record<string, typeof ArrowUpCircle> = {
  receive: ArrowUpCircle,
  count: Scale,
  adjustment: Edit,
  waste: PackageMinus,
  recipe_depletion: ArrowDownCircle,
  recipe_restore: ArrowUpCircle,
};

interface ImportPreview {
  to_create: { name: string; base_unit: SupplyUnit; pack_size: number | null; pack_label: string | null }[];
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

  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, string>[]>([]);
  const [importVendor, setImportVendor] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);

  const [movementSupply, setMovementSupply] = useState<Supply | null>(null);
  const [movementForm, setMovementForm] = useState({ movement_type: 'receive', quantity: '', unit: 'each' as SupplyUnit, reason: '' });

  const [showRecipeForm, setShowRecipeForm] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [recipeForm, setRecipeForm] = useState({ product_id: '', yield_quantity: '1', items: [] as { supply_id: string; quantity: string; unit: SupplyUnit }[] });

  const [deletingSupply, setDeletingSupply] = useState<Supply | null>(null);
  const [deletingRecipe, setDeletingRecipe] = useState<Recipe | null>(null);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

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
    ])
      .then(([recipesRes, productsRes]) => {
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

  const openAddRecipe = () => {
    setEditingRecipe(null);
    setRecipeForm({ product_id: '', yield_quantity: '1', items: [] });
    setShowRecipeForm(true);
  };

  const openEditRecipe = (r: Recipe) => {
    setEditingRecipe(r);
    setRecipeForm({
      product_id: r.product_id,
      yield_quantity: String(r.yield_quantity),
      items: r.items.map((item) => ({ supply_id: item.supply_id, quantity: String(item.quantity), unit: item.unit })),
    });
    setShowRecipeForm(true);
  };

  const handleSaveRecipe = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.put(`/recipes/product/${recipeForm.product_id}`, {
        yield_quantity: Number(recipeForm.yield_quantity),
        items: recipeForm.items.map((item) => ({
          supply_id: item.supply_id,
          quantity: Number(item.quantity),
          unit: item.unit,
        })),
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
            <Button variant="outline" onClick={openImport}><Upload size={16} className="me-1" /> {t('importIngredients')}</Button>
            <Button variant="outline" onClick={openDelivery}><Truck size={16} className="me-1" /> {t('receiveDelivery')}</Button>
            <Button onClick={openAddSupply}><Plus size={16} className="me-1" /> {t('addSupply')}</Button>
          </div>
        )}
        {tab === 'recipes' && (
          <Button onClick={openAddRecipe}><Plus size={16} className="me-1" /> {t('addRecipe')}</Button>
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

          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('supplyName')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('baseUnit')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('stock')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('threshold')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('unitCost')}</th>
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
                    <td className="p-4 text-center text-sm text-muted-foreground">{s.base_unit}</td>
                    <td className={`p-4 text-end text-sm font-medium ${Number(s.stock_quantity) < 0 ? 'text-red-600' : ''}`}>{fmtNum(Number(s.stock_quantity))} {s.base_unit}</td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {s.low_stock_threshold === null ? '—' : fmtNum(Number(s.low_stock_threshold))}
                    </td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {s.unit_cost === null ? '—' : fmtNum(Number(s.unit_cost))}
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
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recipes.map((r) => (
                  <tr key={r.id} className="hover:bg-muted">
                    <td className="p-4 font-medium text-foreground">{r.product_name || r.product_id}</td>
                    <td className="p-4 text-center text-sm">{fmtNum(Number(r.yield_quantity))}</td>
                    <td className="p-4 text-sm text-muted-foreground">
                      <ul className="space-y-0.5">
                        {r.items.map((item) => (
                          <li key={item.supply_id}>
                            {item.supply_name}: {fmtNum(Number(item.quantity))} {item.unit}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="p-4 text-center">
                      <div className="flex items-center justify-center gap-1">
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

      {showRecipeForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-md max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{editingRecipe ? t('editRecipe') : t('addRecipe')}</h2>
              <button onClick={() => setShowRecipeForm(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleSaveRecipe} className="space-y-4">
              <select value={recipeForm.product_id}
                onChange={(e) => setRecipeForm({ ...recipeForm, product_id: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                required disabled={Boolean(editingRecipe)}>
                <option value="">{t('product')}</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input type="number" step="any" min="0.00000001" placeholder={t('yield')} value={recipeForm.yield_quantity}
                onChange={(e) => setRecipeForm({ ...recipeForm, yield_quantity: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-foreground">{t('components')}</span>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => setRecipeForm({
                      ...recipeForm,
                      items: [...recipeForm.items, { supply_id: supplies[0]?.id || '', quantity: '1', unit: (supplies[0]?.base_unit || 'each') as SupplyUnit }],
                    })}>
                    <Plus size={14} /> {t('addComponent')}
                  </Button>
                </div>
                {recipeForm.items.map((item, index) => (
                  <div key={index} className="flex gap-2 mb-2">
                    <select value={item.supply_id}
                      onChange={(e) => {
                        const items = [...recipeForm.items];
                        const targetSupply = supplies.find((s) => s.id === e.target.value);
                        items[index] = {
                          ...items[index],
                          supply_id: e.target.value,
                          unit: (targetSupply?.base_unit || 'each') as SupplyUnit,
                        };
                        setRecipeForm({ ...recipeForm, items });
                      }}
                      className="flex-1 min-w-0 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                      <option value="">{t('supply')}</option>
                      {supplies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <input type="number" step="any" min="0.00000001" placeholder={t('quantity')} value={item.quantity}
                      onChange={(e) => {
                        const items = [...recipeForm.items];
                        items[index] = { ...items[index], quantity: e.target.value };
                        setRecipeForm({ ...recipeForm, items });
                      }}
                      className="w-24 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
                    <select value={item.unit}
                      onChange={(e) => {
                        const items = [...recipeForm.items];
                        items[index] = { ...items[index], unit: e.target.value as SupplyUnit };
                        setRecipeForm({ ...recipeForm, items });
                      }}
                      className="px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                      {SUPPLY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <Button type="button" variant="ghost" size="icon-sm"
                      onClick={() => setRecipeForm({ ...recipeForm, items: recipeForm.items.filter((_, i) => i !== index) })}>
                      <X size={14} />
                    </Button>
                  </div>
                ))}
              </div>
              <Button type="submit" className="w-full" disabled={recipeForm.items.length === 0}>{tCommon('save')}</Button>
            </form>
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
