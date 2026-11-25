'use client';

import { useEffect } from 'react';
import { reloadOnceForChunkError } from '@/lib/chunk-reload';

/** Reloads the page once when a newer version's code can't be loaded (after a deploy). */
export function ChunkErrorReloader() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => { reloadOnceForChunkError(event.error ?? event.message); };
    const onRejection = (event: PromiseRejectionEvent) => { reloadOnceForChunkError(event.reason); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
