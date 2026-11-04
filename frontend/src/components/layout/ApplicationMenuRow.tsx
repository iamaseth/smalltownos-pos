'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import type { ApplicationMenuEntry } from '@/types/electron';

const subscribeToElectronCapability = () => () => {};
const getElectronCapability = () => typeof window !== 'undefined' && Boolean(window.electronAPI?.getStatus);
const getServerElectronCapability = () => false;

/**
 * Restores the top-level application menu on the frameless Windows and Linux
 * title bars. Electron refuses to draw a menu bar for a frameless window, so
 * this renders the labels the main process built and asks it to pop the
 * matching submenu; the entries, roles, accelerators, and click handlers are
 * still the ones the native application menu uses. macOS keeps its
 * authoritative native menu bar and renders nothing.
 */
export default function ApplicationMenuRow() {
  const tCommon = useTranslations('common');
  const isElectron = useSyncExternalStore(
    subscribeToElectronCapability,
    getElectronCapability,
    getServerElectronCapability,
  );
  const [entries, setEntries] = useState<ApplicationMenuEntry[]>([]);
  const [trainingOpen, setTrainingOpen] = useState(false);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    if (!isElectron || window.electronAPI?.platform === 'darwin') return;
    let cancelled = false;
    void window.electronAPI
      ?.getApplicationMenu()
      .then((result) => {
        if (cancelled || 'error' in result) return;
        setEntries(result.entries);
      })
      // Main rejects the invoke when the renderer tears down before it
      // answers, so an uncatchable rejection would surface in the console.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  if (entries.length === 0) return null;

  return (
    <div
      data-testid="desktop-application-menu"
      role="menubar"
      aria-label={tCommon('appTitle')}
      className="flo-title-bar__menu flo-title-bar__interactive pointer-events-auto flex items-center"
    >
      {entries.map((entry) => entry.label === 'Training' ? (
        <div key={entry.key} className="relative">
          <button type="button" role="menuitem" className="flo-title-bar__menu-button"
            onClick={() => {
              setTrainingOpen(!trainingOpen);
              void window.electronAPI?.getTrainingStatus().then((state) => setDemo(state.demo));
            }}>Training</button>
          {trainingOpen && (
            <div className="absolute top-full left-0 z-[100] min-w-56 rounded-lg border border-border bg-popover p-2 shadow-xl">
              <div className="px-3 py-2 text-xs font-semibold text-muted-foreground">{demo ? 'DEMO MODE ACTIVE' : 'LIVE MODE'}</div>
              <button type="button" className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => { setTrainingOpen(false); void window.electronAPI?.switchTrainingMode(!demo); }}>
                {demo ? 'Return to Live Mode…' : 'Enter Demo Mode…'}
              </button>
              <button type="button" className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => setTrainingOpen(false)}>Cancel</button>
            </div>
          )}
        </div>
      ) : (
        <button
          key={entry.key}
          type="button"
          role="menuitem"
          className="flo-title-bar__menu-button"
          onClick={(event) => {
            setTrainingOpen(false);
            const { left, bottom } = event.currentTarget.getBoundingClientRect();
            void window.electronAPI?.openApplicationMenu(entry.key, left, bottom).catch(() => {});
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
