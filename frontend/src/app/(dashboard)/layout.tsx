'use client';

import { usePathname } from 'next/navigation';
import AppSidebar from '@/components/layout/Sidebar';
import AuthGuard from '@/components/layout/AuthGuard';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import StatusBar from '@/components/layout/StatusBar';
import GlobalNotifications from '@/components/layout/GlobalNotifications';
import TitleBar from '@/components/layout/TitleBar';
import TrainingBanner from '@/components/layout/TrainingBanner';
import { usePrinterStatusSync } from '@/hooks/usePrinter';
import { useRegisterAccess } from '@/hooks/useRegisterAccess';
import RegisterLockScreen from '@/components/pos/RegisterLockScreen';
import { useAuthStore } from '@/store/auth';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const normalizedPath = pathname?.replace(/\/+$/, '') || '/';
  const isPos = normalizedPath === '/pos' || normalizedPath === '/kds';
  const isSettings = normalizedPath === '/settings';
  // The staff PIN covers every page so one unlock lasts the shift until 5 idle minutes.
  // The kitchen display must never lock, or the kitchen loses sight of open tickets.
  const isRegister = normalizedPath !== '/kds';
  const registerAccess = useRegisterAccess(isRegister);
  // Sync printer status early so hardware and WebUSB reconnect before first print.
  usePrinterStatusSync();

  return (
    <AuthGuard>
      <SidebarProvider defaultOpen className="flex h-screen min-h-0 flex-col w-full" style={{ minHeight: 0 }}>
        <TitleBar />
        <TrainingBanner />
        <div className="flex min-h-0 flex-1 w-full overflow-hidden">
          <AppSidebar />
          <SidebarInset className="h-full min-h-0 overflow-hidden flex flex-col">
            {/* Mobile-only app bar: below md the sidebar renders as a Sheet with
                no opener, so expose the trigger here (Refs #241). */}
            <div className="md:hidden flex items-center px-2 py-1.5 border-b border-border bg-card shrink-0">
              <SidebarTrigger className="size-8" aria-label="Open navigation" />
            </div>
            {!isPos && <GlobalNotifications />}
            <div className={isPos
              ? 'flex-1 min-h-0 flex flex-col overflow-hidden p-4'
              : isSettings
              ? 'flex-1 min-h-0 p-4 overflow-auto md:overflow-hidden min-w-0'
              : 'flex-1 p-4 overflow-auto min-w-0'
            }>
              {children}
            </div>
            <StatusBar showUpdateBadge={false} />
          </SidebarInset>
          {isRegister && registerAccess.operator && (
            <div className={`fixed end-3 z-[90] flex items-center gap-2 rounded-lg border bg-card/95 px-3 py-2 shadow-md ${normalizedPath === '/pos' ? 'top-14' : 'bottom-10'}`}>
              <span className="max-w-32 truncate text-xs font-medium">{registerAccess.operator.name}</span>
              <button type="button" onClick={registerAccess.lock}
                className="rounded-md border px-2 py-1 text-xs font-semibold hover:bg-muted"
                aria-label="Switch staff member">
                Switch staff
              </button>
            </div>
          )}
          {isRegister && registerAccess.locked && (
            <RegisterLockScreen error={registerAccess.error} onUnlock={registerAccess.unlock}
              onSignOut={() => useAuthStore.getState().logout()} />
          )}
        </div>
      </SidebarProvider>
    </AuthGuard>
  );
}
