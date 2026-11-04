'use client';

import PrinterStatus from './PrinterStatus';
import { useState } from 'react';
import CustomerSearch from './CustomerSearch';
import { useCartStore } from '@/store/cart';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { Banknote, LayoutGrid, Maximize2, Minimize2, LockOpen, Lock, Menu } from 'lucide-react';
import type { Table } from '@/lib/types';
import { useTranslations } from 'use-intl';

interface Props {
  tables: Table[];
  onShowTablePicker: () => void;
  onShowCashMovement: () => void;
  onShowShift: () => void;
  shiftHasOpenSession: boolean;
  shiftLoading: boolean;
  shiftError: string | null;
  canUseShift: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

export default function PosTopbar({ tables, onShowTablePicker, onShowCashMovement, onShowShift, shiftHasOpenSession, shiftLoading, shiftError, canUseShift, fullscreen, onToggleFullscreen }: Props) {
  const cart = useCartStore();
  const [actionsOpen, setActionsOpen] = useState(false);
  const { currentTenant } = useAuthStore();
  const tablesRequired = usePosSettingsStore((s) => s.tablesRequired);
  const t = useTranslations('pos');
  const tDashboard = useTranslations('dashboard');
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const showTableBtn = isRestaurant && cart.orderType === 'dine_in' && tablesRequired;

  return (
    <div className="relative flex shrink-0 items-center gap-2 border-b border-slate-800 bg-[#0f172a] px-3 py-2 text-slate-100">
      <div className="min-w-0 flex-1" />
      <div className="relative">
        <button type="button" onClick={() => setActionsOpen(v => !v)} aria-expanded={actionsOpen}
          aria-label="Cashier actions" className="flex items-center gap-2 rounded-lg border border-slate-700 bg-[#1e293b] px-3 py-2 text-xs font-semibold hover:bg-[#334155]">
          <Menu size={16}/> Actions
        </button>
        {actionsOpen && <>
          <button type="button" className="fixed inset-0 z-40 cursor-default" aria-label="Close cashier actions" onClick={() => setActionsOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[90vw] space-y-2 rounded-xl border border-slate-700 bg-[#111a2e] p-3 shadow-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Customer</p>
            <CustomerSearch variant="topbar" />
            {showTableBtn && <button type="button" onClick={() => {setActionsOpen(false);onShowTablePicker();}} className="flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-slate-700">
              <LayoutGrid size={16}/>{cart.tableId ? t('tableLabel',{name:tables.find(table=>table.id===cart.tableId)?.name||cart.tableId}) : t('selectTable')}
            </button>}
            <button type="button" onClick={() => {setActionsOpen(false);onShowCashMovement();}} className="flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-slate-700"><Banknote size={16}/>{tDashboard('cashMovement')}</button>
            {canUseShift && <button type="button" disabled={shiftLoading} title={shiftError||undefined} onClick={() => {setActionsOpen(false);onShowShift();}} className="flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-slate-700 disabled:opacity-50">
              {shiftHasOpenSession ? <Lock size={16}/> : <LockOpen size={16}/>}
              {shiftHasOpenSession ? tDashboard('closeShiftSession') : tDashboard('openShift')}
            </button>}
            <div className="border-t border-slate-700 pt-2"><PrinterStatus /></div>
            <button type="button" onClick={() => {setActionsOpen(false);onToggleFullscreen();}} className="flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-slate-700">
              {fullscreen ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}
              {fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
            </button>
          </div>
        </>}
      </div>
    </div>
  );
}
