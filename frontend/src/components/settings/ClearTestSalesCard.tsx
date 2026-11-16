'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Eraser } from 'lucide-react';
import api from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MasterPinPrompt } from './MasterPinPrompt';

const CONFIRM_PHRASE = 'CLEAR TEST SALES';

export function ClearTestSalesCard() {
  const [open, setOpen] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  const openDialog = async () => {
    setPhrase('');
    setShowPin(false);
    try {
      const { data } = await api.get('/db-tools/clear-test-sales-impact');
      setCounts(data.counts);
    } catch {
      setCounts(null);
    }
    setOpen(true);
  };

  const close = () => { setOpen(false); setShowPin(false); setPhrase(''); };

  const submitPin = async (pin: string) => {
    try {
      const { data } = await api.post('/db-tools/clear-test-sales', { master_pin: pin, confirmation_phrase: CONFIRM_PHRASE });
      close();
      toast.success(`Test sales cleared (${data.deleted?.orders ?? 0} orders). A backup was saved first.`);
      return { success: true };
    } catch {
      return { success: false, error: 'Could not clear test sales. Check the Master PIN. Nothing was changed.' };
    }
  };

  return (
    <div className="bg-card rounded-xl border border-amber-300 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Eraser size={20} className="text-amber-600" />
        <h2 className="font-semibold text-amber-700">Clear test sales</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Removes all orders, bills, payments and cash sessions. Your menu, pictures, tables, staff, customers and settings stay. A full backup is saved first.
      </p>
      <button onClick={openDialog} className="px-5 py-2 text-sm bg-amber-600 text-white rounded-lg hover:opacity-90 font-medium">
        Clear test sales
      </button>

      <Dialog open={open && !showPin} onOpenChange={(next) => !next && close()}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Clear test sales</DialogTitle>
            <DialogDescription className="space-y-2 pt-2 text-start">
              <span className="block">
                {counts
                  ? `This will delete ${counts.orders ?? 0} orders and ${counts.bills ?? 0} bills. It cannot be undone, except from the backup.`
                  : 'This will delete all orders, bills, payments and cash sessions.'}
              </span>
              <span className="block font-medium">Stock quantities are not restored.</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="clear-sales-confirm">Type {CONFIRM_PHRASE} to confirm</Label>
            <Input id="clear-sales-confirm" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={CONFIRM_PHRASE} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button variant="destructive" disabled={phrase !== CONFIRM_PHRASE} onClick={() => setShowPin(true)}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MasterPinPrompt
        open={open && showPin}
        mode="verify"
        title="Master PIN"
        description="Enter the Master PIN to clear test sales."
        onCancel={() => setShowPin(false)}
        onSubmit={submitPin}
      />
    </div>
  );
}
