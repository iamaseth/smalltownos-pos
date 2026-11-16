'use client';

import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { parseContactsFile, type ContactRow } from '@/lib/contacts-import';

const CHUNK = 400;

interface Props {
  onImported: () => void;
}

interface Totals {
  added: number;
  skippedDuplicates: number;
  addedWithoutPhone: number;
}

export default function ImportCustomersButton({ onImported }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Totals | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseContactsFile(file.name, await file.text());
      if (parsed.length === 0) {
        toast.error('No contacts with a name found in that file');
        return;
      }
      setDone(null);
      setRows(parsed);
    } catch {
      toast.error('Could not read that file');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const runImport = async () => {
    if (!rows) return;
    setBusy(true);
    const totals: Totals = { added: 0, skippedDuplicates: 0, addedWithoutPhone: 0 };
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { data } = await api.post('/customers/import', { customers: rows.slice(i, i + CHUNK) });
        totals.added += data.added;
        totals.skippedDuplicates += data.skippedDuplicates;
        totals.addedWithoutPhone += data.addedWithoutPhone;
      }
      setDone(totals);
      setRows(null);
      onImported();
    } catch {
      toast.error('Import stopped. Contacts already added are kept; run it again to finish.');
      onImported();
    } finally {
      setBusy(false);
    }
  };

  const withPhone = rows ? rows.filter((r) => r.phone).length : 0;

  return (
    <>
      <input ref={inputRef} type="file" accept=".vcf,.csv,text/vcard,text/csv" className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])} />
      <Button variant="outline" onClick={() => inputRef.current?.click()}><Upload size={16} className="me-1" /> Import contacts</Button>

      {(rows || done) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold">Import contacts</h2>
              <button type="button" aria-label="Close" onClick={() => { setRows(null); setDone(null); }} disabled={busy}><X size={20} /></button>
            </div>
            {rows && (
              <>
                <p className="text-sm">Found <b>{rows.length}</b> contacts, <b>{withPhone}</b> with a phone number.</p>
                <p className="mt-2 text-xs text-muted-foreground">Contacts already in the system (same phone) are skipped. Numbers that are not valid are added by name only.</p>
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setRows(null)} disabled={busy}>Cancel</Button>
                  <Button onClick={runImport} disabled={busy}>{busy ? 'Importing…' : `Import ${rows.length}`}</Button>
                </div>
              </>
            )}
            {done && (
              <>
                <p className="text-sm">Added <b>{done.added}</b> customers{done.addedWithoutPhone > 0 ? ` (${done.addedWithoutPhone} without a valid phone)` : ''}. Skipped <b>{done.skippedDuplicates}</b> already in the system.</p>
                <div className="mt-4 flex justify-end"><Button onClick={() => setDone(null)}>Done</Button></div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
