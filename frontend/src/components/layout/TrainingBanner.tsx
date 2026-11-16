'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

export default function TrainingBanner() {
  const [training, setTraining] = useState(false);
  useEffect(() => {
    if (window.electronAPI) return;
    api.get('/health')
      .then(({ data }) => setTraining(data?.training === true))
      .catch(() => { /* banner is optional */ });
  }, []);
  if (!training) return null;
  return (
    <div role="status" className="shrink-0 bg-amber-500 px-3 py-1 text-center text-xs font-extrabold text-black">
      TRAINING SITE — PRACTICE ONLY, NOT REAL SALES
    </div>
  );
}
