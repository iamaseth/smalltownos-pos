'use client';

import PrinterStatus from './PrinterStatus';
import { useState } from 'react';
import CustomerSearch from './CustomerSearch';
import { useCartStore } from '@/store/cart';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { Banknote, LayoutGrid, Maximize2, Minimize2, LockOpen, Lock, Menu, ChevronDown } from 'lucide-react';
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
    <div className="relative flex shrink-0 items-center justify-between gap-3 border-b border-[#1e293b] bg-[#0d1527] px-5 py-3 text-slate-100">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-900/20">
          <span className="text-xl font-black">B</span>
        </div>
        <div className="min-w-0">
          <div className="truncate text-lg font-extrabold tracking-tight text-white">{currentTenant?.business_name || 'The Bay Bar'}</div>
          <div className="text-[11px] font-medium text-slate-400">FloPOS</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {showTableBtn && <button type="button" onClick={onShowTablePicker} className="hidden sm:flex items-center gap-2 rounded-xl border border-[#1e293b] bg-[#182234] px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-[#243149]">
          <LayoutGrid size={16} className="text-blue-400" />
          <span>{cart.tableId ? t('tableLabel',{name:tables.find(table=>table.id===cart.tableId)?.name||cart.tableId}) : t('selectTable')}</span>
        </button>}
        {canUseShift && <button type="button" disabled={shiftLoading} title={shiftError||undefined} onClick={onShowShift} className="hidden md:flex items-center gap-2 rounded-xl border border-[#1e293b] bg-[#182234] px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-[#243149] disabled:opacity-50">
          {shiftHasOpenSession ? <Lock size={15} className="text-emerald-400" /> : <LockOpen size={15} className="text-amber-400" />}
          <span>{shiftHasOpenSession ? tDashboard('closeShiftSession') : tDashboard('openShift')}</span>
        </button>}
        <div className="relative">
        <button type="button" onClick={() => setActionsOpen(v => !v)} aria-expanded={actionsOpen}
          aria-label="Cashier actions" className="flex items-center gap-2 rounded-xl border border-[#1e293b] bg-[#182234] px-3 py-2 text-xs font-semibold hover:bg-[#243149]">
          <Menu size={16}/> Actions <ChevronDown size={13} className="text-slate-400" />
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
    </div>
  );
}
