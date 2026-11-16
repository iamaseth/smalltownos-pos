'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { X, Upload, Printer, Download } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { parseCsv, downloadCsv } from '@/lib/csv-table';
import type { Recipe } from '@/components/products/MenuItemEditor';

interface RecipeImportPreview {
  to_create: { product_name: string; items: number }[];
  already_have_recipe: string[];
  skipped: { product_name: string; reason: string }[];
}

export default function RecipeTools({ recipes, canImport, onImported }: {
  recipes: Recipe[];
  canImport: boolean;
  onImported: () => void;
}) {
  const t = useTranslations('inventory');
  const fmtNum = useFormatNumber();
  const [showRecipeImport, setShowRecipeImport] = useState(false);
  const [recipeImportRows, setRecipeImportRows] = useState<Record<string, string>[]>([]);
  const [recipeImportPreview, setRecipeImportPreview] = useState<RecipeImportPreview | null>(null);
  const [importing, setImporting] = useState(false);

  const importError = (err: unknown): string => {
    const message = err instanceof Error && 'response' in err
      ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
      : undefined;
    return message || t('saveFailed');
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
      onImported();
    } catch (err: unknown) {
      toast.error(importError(err));
    } finally {
      setImporting(false);
    }
  };


  const exportRecipes = () => {
    const rows: (string | number | null)[][] = [['product_name', 'ingredient_name', 'quantity', 'unit', 'status', 'cost_per_serving', 'selling_price', 'margin_percent']];
    for (const r of recipes) {
      for (const item of r.items) {
        rows.push([
          r.product_name || r.product_id, item.group_name || item.supply_name, item.quantity, item.unit,
          r.is_active === 1 ? 'confirmed' : 'draft', r.cost_per_serving, r.selling_price, r.margin_percent,
        ]);
      }
    }
    downloadCsv('recipes.csv', rows);
  };


  const printRecipes = () => {
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const money = (n: number | null) => (n === null ? '—' : fmtNum(Math.round(n * 100) / 100));
    const blocks = recipes.map((r) => {
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

  return (
    <>
      <Button variant="outline" onClick={printRecipes} disabled={recipes.length === 0}><Printer size={16} className="me-1" /> {t('print')}</Button>
      <Button variant="outline" onClick={exportRecipes} disabled={recipes.length === 0}><Download size={16} className="me-1" /> {t('exportCsv')}</Button>
      {canImport && <Button variant="outline" onClick={openRecipeImport}><Upload size={16} className="me-1" /> {t('importRecipes')}</Button>}
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
    </>
  );
}
