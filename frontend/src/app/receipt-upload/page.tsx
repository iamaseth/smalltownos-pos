'use client';

import { useEffect, useState } from 'react';

type Info = { open: boolean; cashier: string | null; uploaded: number; max_photos: number; expires_at: string };
type Picked = { id: string; url: string; data: string };

const MAX_SIDE = 1600;

/** Shrinks a phone photo to a JPEG of at most MAX_SIDE pixels so it uploads quickly. */
function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the photo'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(String(reader.result));
      img.onload = () => {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(String(reader.result)); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function readError(res: Response, fallback: string): Promise<string> {
  try { return (await res.json()).error || fallback; } catch { return fallback; }
}

export default function ReceiptUploadPage() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(0);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('t');
    queueMicrotask(() => setToken(t));
    if (!t) { queueMicrotask(() => setError('This link is not complete. Scan the code on the till again.')); return; }
    fetch(`/api/receipt-upload/info?t=${encodeURIComponent(t)}`)
      .then(async (res) => { if (!res.ok) throw new Error(await readError(res, 'This link is not valid')); return res.json(); })
      .then((data: Info) => { setInfo(data); if (!data.open) setError('This shift is closed. Scan the new code on the till.'); })
      .catch((e: Error) => setError(e.message));
  }, []);

  const left = info ? Math.max(0, info.max_photos - info.uploaded - sent - picked.length) : 0;

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const list = Array.from(files).slice(0, left);
    for (const file of list) {
      try {
        const data = await shrink(file);
        setPicked((p) => [...p, { id: `${Date.now()}-${Math.random()}`, url: data, data }]);
      } catch { setError('Could not read one photo. Try again.'); }
    }
  };

  const upload = async () => {
    if (!token || picked.length === 0) return;
    setSending(true);
    setError(null);
    const remaining = [...picked];
    for (const photo of picked) {
      try {
        const res = await fetch('/api/receipt-upload', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token, data: photo.data }),
        });
        if (!res.ok) throw new Error(await readError(res, 'Upload failed. Try again.'));
        remaining.shift();
        setSent((n) => n + 1);
        setPicked([...remaining]);
      } catch (e) {
        setError((e as Error).message);
        break;
      }
    }
    setSending(false);
  };

  const blocked = !info || !info.open;

  return (
    <main className="mx-auto min-h-screen max-w-md bg-white p-5 text-neutral-900">
      <h1 className="text-2xl font-bold">Receipt photos</h1>
      <p className="mt-1 text-base text-neutral-600">{info?.cashier ? `Shift: ${info.cashier}` : 'BackStreet Riverside'}</p>

      {error && <p className="mt-4 rounded-xl bg-red-50 p-4 text-base font-semibold text-red-700">{error}</p>}
      {sent > 0 && picked.length === 0 && !error && (
        <p className="mt-4 rounded-xl bg-emerald-50 p-4 text-lg font-bold text-emerald-800">✓ {sent} sent. They are on the till now.</p>
      )}

      {!blocked && (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <label className={`flex h-16 cursor-pointer items-center justify-center rounded-2xl bg-neutral-900 text-lg font-bold text-white ${left === 0 ? 'opacity-40' : ''}`}>
              📷 Take photo
              <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={left === 0 || sending}
                onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            <label className={`flex h-16 cursor-pointer items-center justify-center rounded-2xl border-2 border-neutral-900 text-lg font-bold ${left === 0 ? 'opacity-40' : ''}`}>
              🖼 From gallery
              <input type="file" accept="image/*" multiple className="sr-only" disabled={left === 0 || sending}
                onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
            </label>
          </div>

          {picked.length > 0 && (
            <div className="mt-5 grid grid-cols-3 gap-2">
              {picked.map((photo) => (
                <div key={photo.id} className="relative">
                  <img src={photo.url} alt="Receipt to send" className="aspect-square w-full rounded-lg object-cover" />
                  {!sending && (
                    <button type="button" aria-label="Remove photo" onClick={() => setPicked((p) => p.filter((x) => x.id !== photo.id))}
                      className="absolute right-1 top-1 h-8 w-8 rounded-full bg-black/70 text-lg font-bold text-white">×</button>
                  )}
                </div>
              ))}
            </div>
          )}

          <button type="button" disabled={picked.length === 0 || sending} onClick={upload}
            className="mt-5 h-16 w-full rounded-2xl bg-emerald-600 text-xl font-bold text-white disabled:opacity-40">
            {sending ? 'Sending…' : picked.length > 0 ? `Send ${picked.length}` : 'Send'}
          </button>
          <p className="mt-3 text-center text-sm text-neutral-500">{left} more photos allowed for this shift</p>
        </>
      )}
    </main>
  );
}
