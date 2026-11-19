'use client';

import SplitEvenlyRow from '@/components/pos/SplitEvenlyRow';
import { useState, useEffect, useRef } from 'react';
import { X, Wallet, Sparkles, User, Percent, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import type { Bill } from '@/lib/types';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import { resolveTaxComponents } from '@/lib/printer/tax-components';
import { useCartStore } from '@/store/cart';
import { useConfirm } from '@/hooks/use-confirm';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCountryByCode, getCurrencyMinorUnitFactor } from '@/lib/countries';
import { getDiscountInputStep, normalizeFixedDiscountValue } from '@/lib/currency-input';
import { useWhatsAppReady } from '@/hooks/useWhatsAppReady';
import { sendBillViaFlo, shareBillViaWhatsApp } from '@/lib/whatsapp-share';
import { useAuthStore } from '@/store/auth';
import {
  defaultDiscountTypeForMode,
  isDiscountTypeAllowed,
  normalizeDiscountMode,
  type DiscountMode,
  type DiscountType,
} from '@/lib/discount-settings';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';
import { BACKSTREET_CASH_NOTES, addBackStreetCashNote, applyBackStreetCashKey, khrToUsdMinor, restForTenderMinor } from '@/lib/backstreet-cash';

interface Props {
  bill: Bill;
  currency: string;
  onClose: () => void;
  onPaid: () => void;
  onBillUpdate?: (bill: Bill) => void;
}

interface Payment {
  method: string;
  payment_method_id?: number;
  amount: string;
}

type AmountTarget = { kind: 'payment'; index: number } | { kind: 'wallet' } | { kind: 'discount' } | null;

// Loyalty points are 1:1 with currency units. Must match LOYALTY_REDEMPTION_RATE in main/routes/bills.ts.
const LOYALTY_REDEMPTION_RATE = 1;

type PosKey = keyof AppConfig['Messages']['pos'];

// Built-in payment method label keys mapped to typed `pos` leaf keys.
const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const satisfies Record<'cash' | 'card', PosKey>;

const ABA_SETUP_TENDER = -1;

export default function PaymentModal({ bill, onClose, onPaid, onBillUpdate }: Props) {
  const remaining = Number(bill.balance);
  const cartCustomerId = useCartStore((s) => s.customerId);
  const cartCustomer = useCartStore((s) => s.customer);
  const effectiveCustomerId = bill.customer_id || cartCustomerId || null;
  const { confirm, ConfirmDialog } = useConfirm();
  const t = useTranslations('pos');
  const locale = useLocale();
  const tCommon = useTranslations('common');
  const tOrders = useTranslations('orders');
  const tReceipt = useTranslations('receipt');
  const tWhatsappSend = useTranslations('whatsapp.send');

  // sendBillViaFlo (shared with OrdersPage) takes a translator callback;
  // bridge the typed `whatsapp.send` namespace to that contract.
  const whatsappSendT = (key: string): string =>
    tWhatsappSend(
      key.replace(/^whatsapp\.send\./, '') as
        | 'success'
        | 'failed'
        | 'error.notConnected'
        | 'error.notOnWhatsapp'
        | 'error.blocked'
        | 'error.rateLimited',
    );
  const { currentTenant } = useAuthStore();
  const isWhatsAppReady = useWhatsAppReady();
  const unitAdapter = useCurrencyUnitAdapter();
  const { toDisplay: toDisplayUnit, toStored: toStoredUnit, label: inputCurrencyLabel, step: inputCurrencyStep, formatInput } = unitAdapter;
  const currencyCode =
    currentTenant?.currency ||
    (currentTenant?.country ? getCountryByCode(currentTenant.country)?.currency : undefined) ||
    'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currencyCode);
  const toMinorUnits = (amount: number) => Math.round(amount * minorFactor);

  const idempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [bill.id]);
  const [justPaid, setJustPaid] = useState(false);
  const [extraPanel, setExtraPanel] = useState<'split' | 'details' | null>(null);
  const [tenderIndex, setTenderIndex] = useState<number | null>(null);
  const [keypadCurrency, setKeypadCurrency] = useState<'USD' | 'KHR'>('USD');
  const [sendingWa, setSendingWa] = useState(false);
  const [pointsEarned, setPointsEarned] = useState(0);
  const [payments, setPayments] = useState<Payment[]>(
    PAYMENT_METHODS.map((method) => ({ method: method.key, amount: '' })),
  );
  // Tracks whether the cashier has manually typed a split amount — once true, we stop
  // auto-rescaling payment splits (e.g. on discount edits) so we don't clobber their entry.
  const [paymentsTouched, setPaymentsTouched] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletAmount, setWalletAmount] = useState('');
  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>([]);
  // QR is manual verification only until a receiving bank is configured.
  const [khrTendered, setKhrTendered] = useState('');
  const [khrRate, setKhrRate] = useState(4100);
  const [people, setPeople] = useState(2);
  useEffect(() => {
    api.get('/settings/usd_khr_exchange_rate').then(({ data }) => {
      const value = Number(data.setting?.value);
      if (Number.isInteger(value) && value >= 1000 && value <= 10000) setKhrRate(value);
    }).catch(() => { /* Default to 4100 if settings are unavailable. */ });
  }, []);


  // Discount state
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<DiscountType>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [discountReason, setDiscountReason] = useState('');

  const [discountMode, setDiscountMode] = useState<DiscountMode>('percentage');
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');
  const [applyingDiscount, setApplyingDiscount] = useState(false);
  const [loyaltySettings, setLoyaltySettings] = useState<{ loyalty_enabled: boolean } | null>(null);
  const [amountTarget, setAmountTarget] = useState<AmountTarget>(null);

  // Sync state with active bill discount during render before paint
  // to prevent flashing stale values.
  const [syncedBill, setSyncedBill] = useState(bill);
  if (bill !== syncedBill) {
    setSyncedBill(bill);
    if (bill && Number(bill.discount_amount) > 0) {
      const nextType = (bill.discount_type === 'percentage' || bill.discount_type === 'amount')
        ? bill.discount_type
        : defaultDiscountTypeForMode(discountMode);
      setDiscountType(isDiscountTypeAllowed(discountMode, nextType) ? nextType : defaultDiscountTypeForMode(discountMode));
      setDiscountValue(String(nextType === 'amount' ? toDisplayUnit(Number(bill.discount_value || 0)) : (bill.discount_value || '')));
      setDiscountReason(bill.discount_reason || '');
      setShowDiscount(true);
    } else {
      setDiscountType('percentage');
      setDiscountValue('');
      setDiscountReason('');
      setShowDiscount(false);
    }
  }

  if (!isDiscountTypeAllowed(discountMode, discountType)) {
    setDiscountType(defaultDiscountTypeForMode(discountMode));
    setDiscountValue('');
    setDiscountReason('');
    setDiscountPin('');
    setAmountTarget((target) => target?.kind === 'discount' ? null : target);
  }

  // Proportionally update payment inputs when remaining balance changes,
  // unless cashier has already edited inputs manually.
  const [syncedRemaining, setSyncedRemaining] = useState(remaining);
  if (!paymentsTouched && remaining !== syncedRemaining) {
    setSyncedRemaining(remaining);
    const totalAllocated = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    if (totalAllocated > 0) {
      const displayRemaining = toDisplayUnit(remaining);
      setPayments(payments.map(p => {
        const ratio = (parseFloat(p.amount) || 0) / totalAllocated;
        return { ...p, amount: formatInput(displayRemaining * ratio) };
      }));
    }
  }

  useEffect(() => {
    const custId = bill.customer_id || cartCustomerId;
    if (custId) {
      api.get(`/customers/${custId}/wallet`)
        .then((res) => {
          setWalletBalance(Number(res.data.balance) || 0);
        })
        .catch(() => setWalletBalance(0));
    }
    api.get('/settings/loyalty')
      .then((res) => setLoyaltySettings(res.data))
      .catch(() => {});
    api.get('/settings/discount')
      .then((res) => {
        setDiscountMode(normalizeDiscountMode(res.data.discount_mode));
        setDiscountRequiresApproval(!!res.data.discount_requires_approval);
      })
      .catch(() => {});
    api.get('/payment-methods')
      .then((res) => {
        const methods: CustomPaymentMethod[] = res.data.payment_methods || [];
        setCustomMethods(methods);
        setPayments((current) => [
          ...PAYMENT_METHODS.map((method) => current.find((row) => row.method === method.key && row.payment_method_id === undefined) || { method: method.key, amount: '' }),
          ...methods.map((method) => current.find((row) => row.payment_method_id === method.id) || { method: 'custom', payment_method_id: method.id, amount: '' }),
        ]);
      })
      .catch(() => setCustomMethods([]));
  }, [bill.customer_id, cartCustomerId]);

  const walletAmt = toStoredUnit(parseFloat(walletAmount) || 0);
  const khrAmount = Number(khrTendered) || 0;
  const khrUsdMinor = khrToUsdMinor(khrAmount, khrRate, minorFactor);
  const totalPaymentMinor = payments.reduce((s, p) => s + toMinorUnits(toStoredUnit(parseFloat(p.amount) || 0)), 0) + toMinorUnits(walletAmt) + khrUsdMinor;
  const totalPayment = totalPaymentMinor / minorFactor;
  const remainingMinor = toMinorUnits(remaining);

  const updatePaymentAmount = (idx: number, value: string) => {
    setPaymentsTouched(true);
    setPayments((current) => current.map((payment, index) => index === idx ? { ...payment, amount: value } : payment));
  };

  // The touch keypad and note buttons edit the same controlled inputs as a physical keyboard.
  const cashIndex = payments.findIndex((p) => p.method === 'cash' && p.payment_method_id === undefined);
  const abaIndex = payments.findIndex((p) => p.payment_method_id !== undefined
    && customMethods.find((m) => m.id === p.payment_method_id)?.name.trim().toLowerCase() === 'aba (manual)');

  const updateCashField = (compute: (current: string) => string, currency: 'USD' | 'KHR' = keypadCurrency) => {
    if (cashIndex < 0) return;
    const current = currency === 'KHR' ? khrTendered : payments[cashIndex].amount;
    const next = compute(current);
    if (currency === 'KHR') {
      setKhrTendered(next);
      setPaymentsTouched(true);
    } else updatePaymentAmount(cashIndex, next);
  };

  const enterCashKey = (key: string) => {
    if (tenderIndex === ABA_SETUP_TENDER) return;
    if (tenderIndex !== null) {
      updatePaymentAmount(tenderIndex, applyBackStreetCashKey(payments[tenderIndex]?.amount || '', key, 'USD'));
      return;
    }
    updateCashField((current) => applyBackStreetCashKey(current, key, keypadCurrency));
  };

  const addCashNote = (note: number, currency: 'USD' | 'KHR') => {
    setTenderIndex(null);
    setKeypadCurrency(currency);
    updateCashField((current) => addBackStreetCashNote(current, note, currency), currency);
  };

  const restForMinor = (idx: number) => restForTenderMinor(
    remainingMinor,
    totalPaymentMinor,
    toMinorUnits(toStoredUnit(parseFloat(payments[idx]?.amount) || 0)),
  );
  const restFor = (idx: number) => toDisplayUnit(restForMinor(idx) / minorFactor);

  const allocateRemainingTo = (idx: number) => {
    const restMinor = restForMinor(idx);
    const decimals = Math.round(Math.log10(minorFactor));
    setPaymentsTouched(true);
    setPayments(payments.map((payment, index) => index === idx
      ? { ...payment, amount: restMinor > 0 ? toDisplayUnit(restMinor / minorFactor).toFixed(decimals) : '' }
      : payment));
  };

  const hasCash = khrAmount > 0 || payments.some((p) => p.method === 'cash' && (parseFloat(p.amount) || 0) > 0);

  const change = hasCash && totalPaymentMinor > remainingMinor
    ? (totalPaymentMinor - remainingMinor) / minorFactor
    : 0;

  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();

  const handleApplyDiscount = async (customVal?: number) => {
    if (applyingDiscount) return;
    const rawVal = customVal !== undefined ? customVal : parseFloat(discountValue);
    if (customVal === undefined && (isNaN(rawVal) || rawVal < 0)) {
      toast.error(t('discountInvalid'));
      return;
    }
    const val = discountType === 'amount'
      ? normalizeFixedDiscountValue(rawVal, unitAdapter.maxDecimals)
      : rawVal;
    if (discountType === 'amount' && rawVal > 0 && val <= 0) {
      toast.error(t('discountInvalid'));
      return;
    }
    // Check if PIN is required
    if (discountRequiresApproval && val > 0 && !discountPin) {
      toast.error(t('managerPinRequired'));
      return;
    }
    if (val > 0 && !isDiscountTypeAllowed(discountMode, discountType)) {
      toast.error(t('discountInvalid'));
      return;
    }
    setApplyingDiscount(true);
    try {
      const storedDiscountValue = discountType === 'amount' && customVal === undefined ? toStoredUnit(val) : val;
      await api.patch(`/orders/${bill.order_id}/discount`, {
        discount_type: discountType,
        discount_value: storedDiscountValue,
        discount_reason: val > 0 ? discountReason || undefined : undefined,
        override_pin: discountRequiresApproval && val > 0 ? discountPin : undefined,
      });
      toast.success(val === 0 ? t('discountRemoved') : t('discountUpdated'));
      setDiscountPin('');
      if (val === 0) {
        setShowDiscount(false);
        setDiscountValue('');
        setDiscountReason('');
      }
      // Refresh bill without closing modal
      const { data } = await api.get(`/bills/order/${bill.order_id}`);
      if (data.bill && onBillUpdate) {
        onBillUpdate(data.bill);
      }
    } catch {
      toast.error(t('failedToUpdateDiscount'));
      // Clear the PIN on any failure (wrong PIN or rate-limited) so a stale/rejected
      // PIN doesn't sit in the field looking like it might still work on retry.
      setDiscountPin('');
    } finally {
      setApplyingDiscount(false);
    }
  };

  const handlePay = async (partial = false) => {
    const decimalPart = unitAdapter.maxDecimals > 0 ? `(?:\\.\\d{1,${unitAdapter.maxDecimals}})?` : '';
    const amountPattern = new RegExp(`^\\d+${decimalPart}$`);
    const amountIsValid = (value: string) => value.trim() === '' || amountPattern.test(value.trim());
    if (payments.some((p) => (
      !PAYMENT_METHODS.some((allowed) => allowed.key === p.method)
      && !customMethods.some((method) => method.id === p.payment_method_id)
    ) || !amountIsValid(p.amount))) {
      toast.error(t('paymentFailed'));
      return;
    }
    if (khrTendered.trim() && (!/^[0-9]+$/.test(khrTendered.trim()) || !Number.isSafeInteger(khrAmount))) {
      toast.error('KHR cash must be a non-negative whole number');
      return;
    }
    if (walletAmount.trim() && !amountPattern.test(walletAmount.trim())) {
      toast.error(t('paymentFailed'));
      return;
    }
    const nonCashTotalMinor = payments
      .filter((p) => p.method !== 'cash')
      .reduce((sum, p) => sum + toMinorUnits(toStoredUnit(Number(p.amount) || 0)), 0) + toMinorUnits(walletAmt);
    if (nonCashTotalMinor > remainingMinor) {
      toast.error(t('paymentAboveBalance'));
      return;
    }
    if (partial ? totalPaymentMinor <= 0 : totalPaymentMinor < remainingMinor) {
      toast.error(t('paymentBelowBalance'));
      return;
    }
    // Validate wallet amount against available balance (convert currency to points for comparison)
    if (walletAmt > 0 && walletBalance !== null) {
      const redemptionRate = LOYALTY_REDEMPTION_RATE;
      const walletPointsRequired = walletAmt * redemptionRate;
      if (walletPointsRequired > walletBalance) {
        const maxCurrency = Math.floor(walletBalance / redemptionRate);
        toast.error(t('walletMaxAmount', { max: currencyFmt(maxCurrency) }));
        return;
      }
    }
    setProcessing(true);
    try {
      const splitLines = payments
        .map((p) => ({
          method: p.payment_method_id === undefined ? p.method : 'custom',
          ...(p.payment_method_id !== undefined ? { payment_method_id: p.payment_method_id } : {}),
          amount: toStoredUnit(parseFloat(p.amount) || 0),
        }))
        .filter((p) => p.amount > 0 && !isNaN(p.amount));
      if (khrAmount > 0) {
        const khrCashUsd = khrUsdMinor / minorFactor;
        const existingCash = splitLines.find((line) => line.method === 'cash');
        if (existingCash) existingCash.amount += khrCashUsd;
        else splitLines.push({ method: 'cash', amount: khrCashUsd });
      }
      // BackStreet drawer: record USD and KHR received and change given separately so
      // shift closing can reconcile each currency. Change policy: whole dollars in USD,
      // the cents remainder in riel (rounded to 100៛). The backend re-validates.
      const cashLine = splitLines.find((line) => line.method === 'cash') as (typeof splitLines[number] & Record<string, number>) | undefined;
      if (cashLine) {
        const usdIn = cashIndex >= 0 ? toStoredUnit(parseFloat(payments[cashIndex].amount) || 0) : 0;
        const changeMinor = Math.max(0, totalPaymentMinor - remainingMinor);
        const changeUsd = changeMinor / minorFactor;
        const changeUsdWhole = Math.floor(changeUsd + 1e-9);
        cashLine.cash_usd_in = usdIn;
        cashLine.cash_khr_in = khrAmount;
        cashLine.change_usd_out = changeUsdWhole;
        cashLine.change_khr_out = Math.round(((changeUsd - changeUsdWhole) * khrRate) / 100) * 100;
      }
      if (walletAmt > 0) splitLines.push({ method: 'wallet', amount: walletAmt });

      // Atomic call ensures all split payment lines succeed together
      // or fail together without leaving partial payments.
      const idempotencyKey = idempotencyKeyRef.current || createPaymentIdempotencyKey();
      idempotencyKeyRef.current = idempotencyKey;
      const res = await api.post(
        `/bills/${bill.id}/payments`,
        { payments: splitLines, customer_id: effectiveCustomerId },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );
      const updatedBill = res.data?.bill as Bill | undefined;
      if (!updatedBill || updatedBill.payment_status !== 'paid') {
        // This request committed a partial payment, so the next attempt is a
        // new request and must not reuse the completed request's hash.
        if (updatedBill) idempotencyKeyRef.current = null;
        if (updatedBill && onBillUpdate) onBillUpdate(updatedBill);
        if (partial && updatedBill?.payment_status === 'partial') {
          setPayments((current) => current.map((p) => ({ ...p, amount: '' })));
          setKhrTendered('');
          setWalletAmount('');
          setPaymentsTouched(false);
          setAmountTarget(null);
          setPeople((n) => Math.max(1, n - 1));
          toast.success(`Payment recorded. ${currencyFmt(Number(updatedBill.balance) || 0)} left to pay.`);
          return;
        }
        toast.error(t('paymentIncomplete', {
          amount: currencyFmt(Number(updatedBill?.balance) || 0),
        }));
        return;
      }
      const earned = res.data?.loyaltyPointsEarned > 0 ? res.data.loyaltyPointsEarned : 0;
      setPointsEarned(earned);
      if (earned > 0) {
        toast.success(t('paymentRecordedWithPoints', { points: earned }));
      } else {
        toast.success(t('paymentRecorded'));
      }
      setJustPaid(true);
    } catch {
      toast.error(t('paymentFailed'));
    } finally {
      setProcessing(false);
    }
  };

  const tenantForShare = {
    business_name: currentTenant?.business_name || tCommon('businessNameFallback'),
    currency: currentTenant?.currency || '',
    country: currentTenant?.country || '',
  };

  const handleSendWhatsApp = async () => {
    const phone = cartCustomer?.phone;
    if (!phone) {
      toast.error(tWhatsappSend('customerPhoneRequired'));
      return;
    }
    setSendingWa(true);
    try {
      await sendBillViaFlo(bill, phone, tenantForShare, whatsappSendT, { pointsEarned }, locale);
    } finally {
      setSendingWa(false);
    }
  };

  const handleShareWhatsApp = async () => {
    if (!cartCustomer?.phone) {
      toast.error(tWhatsappSend('customerPhoneRequired'));
      return;
    }
    try {
      const opened = await shareBillViaWhatsApp(
        bill,
        { phone: cartCustomer.phone, country_code: cartCustomer.country_code },
        tenantForShare,
        { pointsEarned },
        locale,
      );
      if (!opened) toast.error(tOrders('whatsappFailed'));
    } catch {
      toast.error(tOrders('whatsappFailed'));
    }
  };

  const cashTenderedUsd = (cashIndex >= 0 ? parseFloat(payments[cashIndex].amount) || 0 : 0) + khrUsdMinor / minorFactor;
  const stillToPay = Math.max(0, remainingMinor - totalPaymentMinor) / minorFactor;
  const toRielDisplay = (usd: number) => `${(Math.round((usd * khrRate) / 100) * 100).toLocaleString('en-US')}៛`;

  const tenderLabel = (idx: number) => {
    const payment = payments[idx];
    const builtIn = PAYMENT_METHODS.find((method) => method.key === payment?.method && payment?.payment_method_id === undefined);
    if (builtIn?.key === 'card') return '💳 ' + t(BUILT_IN_PAYMENT_KEYS[builtIn.key]);
    if (builtIn) return t(BUILT_IN_PAYMENT_KEYS[builtIn.key]);
    if (idx === abaIndex) return 'ABA / KHQR';
    return customMethods.find((method) => method.id === payment?.payment_method_id)?.name || tCommon('unknown');
  };


  const tenderButton = (idx: number | null, label: string, amount: number) => {
    const selected = tenderIndex === idx;
    const hasAmount = amount > 0;
    return (
      <button
        key={idx === null ? 'cash' : `tender-${idx}`}
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={() => {
          setTenderIndex(idx);
          if (idx !== null && idx !== ABA_SETUP_TENDER) setAmountTarget({ kind: 'payment', index: idx });
        }}
        className={`relative flex min-h-16 items-center justify-center gap-2 rounded-2xl border-2 px-3 text-xl font-extrabold transition-colors ${selected
          ? 'border-white bg-white text-black'
          : hasAmount ? 'border-green-500 bg-neutral-900 text-white' : 'border-neutral-600 bg-neutral-900 text-white hover:border-neutral-400'}`}
      >
        <span className="truncate">{label}</span>
        {hasAmount && <span className={`text-sm font-bold ${selected ? 'text-black' : 'text-neutral-300'}`}>{currencyFmt(amount)}</span>}
        {hasAmount && !selected && <span className="absolute end-2.5 top-2 h-2.5 w-2.5 rounded-full bg-green-500" aria-hidden />}
      </button>
    );
  };

  const secondaryChip = (open: boolean) => `inline-flex min-h-12 items-center gap-2 rounded-xl border-2 px-4 text-base font-bold ${open
    ? 'border-white bg-white text-black'
    : 'border-neutral-600 bg-neutral-900 text-white hover:border-neutral-400'}`;

  const keypadTargetLabel = tenderIndex !== null && tenderIndex !== ABA_SETUP_TENDER
    ? `${tenderLabel(tenderIndex)} ${inputCurrencyLabel}`
    : keypadCurrency === 'KHR' ? 'KHR ៛' : 'USD $';
  const extraKey = tenderIndex === null && keypadCurrency === 'KHR' ? '000' : minorFactor > 1 ? '.' : null;

  const usedTenders = [
    ...(cashTenderedUsd > 0 ? [`cash ${currencyFmt(cashTenderedUsd)}`] : []),
    ...payments.flatMap((payment, idx) => idx !== cashIndex && (parseFloat(payment.amount) || 0) > 0
      ? [`${tenderLabel(idx).replace(/^\p{Extended_Pictographic}\s*/u, '')} ${currencyFmt(parseFloat(payment.amount) || 0)}`] : []),
  ];
  const paySubLabel = change > 0
    ? `· give change ${currencyFmt(change)}`
    : usedTenders.length > 1 ? `· ${usedTenders.join(' + ')}` : '';

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="dark bg-neutral-950 text-white w-full sm:max-w-6xl sm:max-h-[95vh] sm:flex sm:flex-col rounded-t-3xl sm:rounded-2xl border-2 border-neutral-700 shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-4 border-b-2 border-neutral-800 bg-black px-5 py-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-white">{t('payment')}</h2>
            <p className="mt-0.5 truncate text-sm text-neutral-300">
              {t('billNumber', { number: bill.bill_number })}
              {cartCustomer && <> · <User size={12} className="inline -mt-0.5" /> {cartCustomer.name}</>}
            </p>
          </div>
          <div className="ms-auto text-end" data-testid="payment-total-due">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-yellow-400">{t('totalDue')}</p>
            <p className="text-5xl font-extrabold leading-none tracking-tight text-white tabular-nums">{currencyFmt(remaining)}</p>
            <p className="mt-1 text-sm font-semibold text-neutral-400">
              {Number(bill.paid_amount) > 0
                ? `Already paid ${currencyFmt(Number(bill.paid_amount))} of ${currencyFmt(Number(bill.total))}`
                : `≈ ${toRielDisplay(remainingMinor / minorFactor)}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="touch-target h-13 w-13 rounded-xl border-2 border-neutral-600 bg-neutral-900 text-white hover:bg-neutral-800"
            aria-label={t('close')}
          >
            <X size={22} />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[75vh] overflow-y-auto sm:min-h-0 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">

          <div className="space-y-3">
            {/* Loyalty Info Strip (staff reference) */}
            {loyaltySettings?.loyalty_enabled && effectiveCustomerId && (
              <div className="flex items-center gap-2 px-3.5 py-2.5 bg-muted border border-border rounded-xl">
                <Sparkles size={13} className="text-muted-foreground shrink-0" />
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                  <span className="text-foreground font-medium">{t('loyalty')}</span>
                  <span className="font-semibold text-foreground">
                    {walletBalance !== null
                      ? t('pointsApproxValue', { count: fmtNum(walletBalance), value: currencyFmt(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE))) })
                      : '…'}
                  </span>
                </div>
              </div>
            )}


            {/* Payment type */}
            <div className="grid grid-cols-3 gap-2.5" role="tablist" aria-label="Payment type">
              {tenderButton(null, '💵 Cash', cashTenderedUsd)}
              {abaIndex >= 0
                ? tenderButton(abaIndex, 'ABA / KHQR', parseFloat(payments[abaIndex].amount) || 0)
                : tenderButton(ABA_SETUP_TENDER, 'ABA / KHQR', 0)}
              {payments.map((payment, idx) => idx === cashIndex || idx === abaIndex ? null : tenderButton(idx, tenderLabel(idx), parseFloat(payment.amount) || 0))}
            </div>

            {tenderIndex === null && cashIndex >= 0 && (
              <div className="rounded-2xl border-2 border-neutral-700 bg-neutral-900 p-4">
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-sm font-bold uppercase tracking-[0.1em] text-neutral-300">Cash received</span>
                  <span className="text-sm font-semibold text-neutral-400">1 USD = {khrRate.toLocaleString('en-US')}៛</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {(['USD', 'KHR'] as const).map((unit) => {
                    const selected = keypadCurrency === unit;
                    return <div key={unit} className="flex min-w-0 flex-col gap-2">
                      <label className={`block min-w-0 rounded-xl border-2 bg-black px-3.5 py-2 ${selected ? 'border-yellow-400 ring-2 ring-inset ring-yellow-400' : 'border-neutral-600'}`}>
                        <span className={`text-sm font-bold ${selected ? 'text-yellow-400' : 'text-neutral-400'}`}>{unit === 'USD' ? 'USD $' : 'KHR ៛'}</span>
                        <input
                          type="number"
                          value={unit === 'USD' ? payments[cashIndex].amount : khrTendered}
                          min="0"
                          step={unit === 'USD' ? '0.01' : '1'}
                          inputMode={unit === 'USD' ? 'decimal' : 'numeric'}
                          onFocus={() => { setTenderIndex(null); setKeypadCurrency(unit); setAmountTarget(unit === 'USD' ? { kind: 'payment', index: cashIndex } : null); }}
                          onChange={(e) => unit === 'USD' ? updatePaymentAmount(cashIndex, e.target.value) : (setKhrTendered(e.target.value), setPaymentsTouched(true))}
                          placeholder={unit === 'USD' ? '0.00' : '0'}
                          className="block w-full min-w-0 bg-transparent text-3xl font-extrabold text-white tabular-nums outline-none placeholder:text-neutral-600"
                        />
                      </label>
                      <div className="grid grid-cols-3 gap-1.5" aria-label={`Add ${unit} note`}>
                        {BACKSTREET_CASH_NOTES[unit].map((note) => (
                          <button
                            key={`${unit}-${note}`}
                            type="button"
                            onClick={() => addCashNote(note, unit)}
                            aria-label={`Add ${unit === 'USD' ? `$${note}` : `${note.toLocaleString('en-US')} KHR`}`}
                            className={`min-h-11 rounded-xl border-2 text-base font-extrabold ${unit === 'USD'
                              ? 'border-green-600 bg-green-950 text-green-100 hover:bg-green-900'
                              : 'border-yellow-600 bg-yellow-950 text-yellow-100 hover:bg-yellow-900'}`}
                          >
                            +{unit === 'USD' ? `$${note}` : note.toLocaleString('en-US')}
                          </button>
                        ))}
                      </div>
                    </div>;
                  })}
                </div>
              </div>
            )}

            {tenderIndex === ABA_SETUP_TENDER && (
              <div className="rounded-2xl border-2 border-yellow-500 bg-neutral-900 p-4 text-white">
                <p className="text-lg font-bold">ABA is not switched on yet</p>
                <p className="mt-1 text-base text-neutral-300">An owner can enable it in Settings → Payment Methods → <b>Enable ABA (Manual)</b>. It then appears here as a payment type.</p>
                <p className="mt-3 rounded-lg bg-yellow-400 px-3 py-2 text-sm font-bold text-black">Never mark a QR payment as paid from a customer&apos;s screenshot. Check the bar&apos;s ABA app.</p>
              </div>
            )}

            {tenderIndex !== null && tenderIndex !== ABA_SETUP_TENDER && payments[tenderIndex] && (
              <div className="rounded-2xl border-2 border-neutral-700 bg-neutral-900 p-4">
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-sm font-bold uppercase tracking-[0.1em] text-neutral-300">{tenderLabel(tenderIndex)}</span>
                  {tenderIndex === abaIndex && <span className="text-sm font-semibold text-neutral-400">Manual confirmation</span>}
                </div>
                <div className="flex items-stretch gap-3">
                  <label className="block min-w-0 flex-1 rounded-xl border-2 border-yellow-400 bg-black px-3.5 py-2 ring-2 ring-inset ring-yellow-400">
                    <span className="text-sm font-bold text-yellow-400">Amount {inputCurrencyLabel}</span>
                    <input
                      type="number"
                      value={payments[tenderIndex].amount}
                      onFocus={() => setAmountTarget({ kind: 'payment', index: tenderIndex })}
                      onChange={(e) => updatePaymentAmount(tenderIndex, e.target.value)}
                      placeholder="0.00"
                      inputMode="decimal"
                      step={inputCurrencyStep}
                      min="0"
                      className="block w-full min-w-0 bg-transparent text-3xl font-extrabold text-white tabular-nums outline-none placeholder:text-neutral-600"
                    />
                  </label>
                  {restFor(tenderIndex) > 0 && (
                    <button type="button" onClick={() => allocateRemainingTo(tenderIndex)} className="rounded-xl border-2 border-white bg-black px-4 text-lg font-extrabold text-white hover:bg-neutral-800">
                      Rest {currencyFmt(restFor(tenderIndex))}
                    </button>
                  )}
                </div>
                {tenderIndex === abaIndex && (
                  <p className="mt-3 rounded-lg bg-yellow-400 px-3 py-2 text-base font-bold text-black">Check the payment arrived in the ABA app before pressing Pay.</p>
                )}
              </div>
            )}

            {/* Summary */}
            <div className="grid grid-cols-3 overflow-hidden rounded-2xl border-2 border-neutral-700" data-testid="payment-summary">
              <div className="bg-neutral-950 px-4 py-2.5">
                <p className="text-xs font-bold uppercase tracking-[0.08em] text-neutral-400">Received</p>
                <p className="text-3xl font-extrabold text-white tabular-nums">{currencyFmt(totalPayment)}</p>
              </div>
              <div className="border-s-2 border-neutral-700 bg-neutral-950 px-4 py-2.5">
                <p className="text-xs font-bold uppercase tracking-[0.08em] text-neutral-400">Still to pay</p>
                <p className={`text-3xl font-extrabold tabular-nums ${stillToPay > 0 ? 'text-red-400' : 'text-white'}`}>{currencyFmt(stillToPay)}</p>
              </div>
              <div className="border-s-2 border-neutral-700 bg-green-950 px-4 py-2.5">
                <p className="text-xs font-bold uppercase tracking-[0.08em] text-green-300">{t('changeReturned')}</p>
                <p className="text-3xl font-extrabold text-green-400 tabular-nums">
                  {currencyFmt(change)}
                  {change > 0 && <span className="ms-2 text-base font-semibold text-green-200">= {toRielDisplay(change)}</span>}
                </p>
              </div>
            </div>

            {/* Loyalty Wallet Section */}
            {loyaltySettings?.loyalty_enabled && effectiveCustomerId && walletBalance !== null && (
              <div className="space-y-1">
                <div className="flex min-h-12">
                  <button type="button" disabled={walletBalance <= 0} onClick={() => {
                    const allocatedElsewhere = payments.reduce((sum, payment) => sum + toStoredUnit(parseFloat(payment.amount) || 0), 0);
                    const maxWalletStored = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
                    const dueStored = Math.min(maxWalletStored, Math.max(0, remaining - allocatedElsewhere));
                    const dueDisplay = toDisplayUnit(dueStored);
                    setWalletAmount(dueDisplay > 0 ? String(dueDisplay) : '');
                    setAmountTarget({ kind: 'wallet' });
                  }} className={`touch-target w-36 shrink-0 justify-start rounded-s-xl border px-3 gap-2 text-sm font-semibold ${walletAmt > 0 ? 'bg-purple-600 text-white border-purple-600' : 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800/40 disabled:bg-muted disabled:text-muted-foreground disabled:border-border'}`}>
                    <Wallet size={15} /><span className="truncate">{t('loyaltyWallet')}</span>
                  </button>
                  <div className="flex flex-1 items-center border border-s-0 border-purple-200 dark:border-purple-800/40 rounded-e-xl bg-card focus-within:ring-2 focus-within:ring-purple-400">
                    <span className="ps-3 text-muted-foreground text-xs">{inputCurrencyLabel}</span>
                    <input
                      type="number"
                      value={walletAmount}
                      onFocus={() => setAmountTarget({ kind: 'wallet' })}
                      onChange={(e) => {
                        const v = e.target.value;
                        const maxWalletCurrencyStored = Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE));
                        const maxDisplay = toDisplayUnit(Math.min(maxWalletCurrencyStored, remaining));
                        const clamped = parseFloat(v) > maxDisplay ? String(maxDisplay) : v;
                        setWalletAmount(clamped);
                      }}
                      placeholder="0.00"
                      disabled={walletBalance <= 0}
                      inputMode="decimal"
                      className="min-w-0 flex-1 px-2 py-2 text-end text-base font-semibold outline-none rounded-e-xl disabled:bg-muted"
                      step={inputCurrencyStep}
                      min="0"
                      max={toDisplayUnit(Math.min(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE)), remaining))}
                    />
                  </div>
                </div>
                <p className="px-1 text-[11px] text-muted-foreground text-end">{walletBalance > 0 ? t('pointsApproxValue', { count: fmtNum(walletBalance), value: currencyFmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)) }) : t('noBalance')}</p>
              </div>
            )}


            {/* Less common actions */}
            <div className="flex flex-wrap gap-2.5">
              {!bill.split_group_id && discountMode !== 'none' && (
                <button type="button" onClick={() => setShowDiscount((open) => !open)} aria-expanded={showDiscount} className={secondaryChip(showDiscount)}>
                  <Percent size={16} />
                  {Number(bill.discount_amount) > 0 ? `${t('discount')}: -${currencyFmt(Number(bill.discount_amount))}` : t('discount')}
                </button>
              )}
              <button type="button" onClick={() => setExtraPanel((open) => open === 'split' ? null : 'split')} aria-expanded={extraPanel === 'split'} className={secondaryChip(extraPanel === 'split')}>Split bill</button>
              <button type="button" onClick={() => setExtraPanel((open) => open === 'details' ? null : 'details')} aria-expanded={extraPanel === 'details'} className={secondaryChip(extraPanel === 'details')}>Bill details</button>
            </div>

            {!bill.split_group_id && discountMode !== 'none' && (
              <div className="overflow-hidden rounded-xl">
                {showDiscount && (
                  <div className="bg-purple-50 dark:bg-purple-950/40 border-t border-purple-200 dark:border-purple-800/40 p-3 space-y-2">
                    <div className="flex rounded-lg overflow-hidden border border-purple-200 dark:border-purple-800/40">
                      {isDiscountTypeAllowed(discountMode, 'percentage') && (
                        <button
                          onClick={() => { setDiscountType('percentage'); }}
                          className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'percentage' ? 'bg-purple-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
                        >
                          <Percent size={14} />
                          {t('percentage')}
                        </button>
                      )}
                      {isDiscountTypeAllowed(discountMode, 'amount') && (
                        <button
                          onClick={() => { setDiscountType('amount'); }}
                          className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'amount' ? 'bg-purple-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
                        >
                          {t('flatAmount')}
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <span className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                        {discountType === 'percentage' ? '%' : inputCurrencyLabel}
                      </span>
                      <input
                        type="number"
                        value={discountValue}
                        onFocus={() => setAmountTarget({ kind: 'discount' })}
                        onChange={(e) => setDiscountValue(e.target.value)}
                        placeholder={discountType === 'percentage' ? '0' : '0.00'}
                        min="0"
                        max={discountType === 'percentage' ? 100 : toDisplayUnit(Number(bill.subtotal))}
                        step={getDiscountInputStep(unitAdapter.maxDecimals, discountType)}
                        inputMode={discountType === 'percentage' ? 'numeric' : 'decimal'}
                        className="w-full min-h-11 ps-8 pe-3 py-2 text-sm border border-purple-200 dark:border-purple-800/40 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
                      />
                    </div>
                    <input
                      type="text"
                      value={discountReason}
                      onChange={(e) => setDiscountReason(e.target.value)}
                      placeholder={t('discountReasonPlaceholder')}
                      className="w-full min-h-11 px-3 py-2 text-sm border border-purple-200 dark:border-purple-800/40 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
                    />
                    {discountRequiresApproval && parseFloat(discountValue) > 0 && (
                      <input
                        type="password"
                        value={discountPin}
                        onChange={(e) => setDiscountPin(e.target.value)}
                        placeholder={t('managerPin')}
                        maxLength={6}
                        className="w-full min-h-11 px-3 py-2 text-sm border border-purple-200 dark:border-purple-800/40 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
                      />
                    )}
                    <Button
                      onClick={() => handleApplyDiscount()}
                      disabled={applyingDiscount || discountValue === '' || isNaN(parseFloat(discountValue))}
                      className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                    >
                      {applyingDiscount
                        ? t('applyingDiscount')
                        : Number(bill.discount_amount) > 0 ? t('updateDiscount') : t('applyDiscount')}
                    </Button>
                    {Number(bill.discount_amount) > 0 && (
                      <Button variant="outline" className="w-full" onClick={async () => {
                        if (await confirm(t('removeDiscountConfirm'), { destructive: true, confirmLabel: t('remove') })) void handleApplyDiscount(0);
                      }}>
                        {t('remove')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {extraPanel === 'split' && (
              <div className="rounded-xl border-2 border-neutral-700 bg-neutral-900 p-3">
                {remainingMinor > 0 && (() => {
                  const shareMinor = Math.ceil(remainingMinor / people);
                  const shareDisplay = toDisplayUnit(shareMinor / minorFactor);
                  return <SplitEvenlyRow
                    people={people}
                    onPeopleChange={setPeople}
                    shareLabel={currencyFmt(shareMinor / minorFactor)}
                    onFill={() => {
                      setKhrTendered('');
                      setPaymentsTouched(true);
                      setPayments((current) => current.map((p) => p.method === 'cash' && p.payment_method_id === undefined ? { ...p, amount: formatInput(shareDisplay) } : { ...p, amount: '' }));
                    }}
                  />;
                })()}
                {remainingMinor <= 0 && <p className="text-sm text-neutral-400">Nothing left to split.</p>}
              </div>
            )}

            {extraPanel === 'details' && (
              <div className="rounded-xl border-2 border-neutral-700 bg-neutral-900 p-3">
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between text-muted-foreground">
                    <span>{t('subtotal')}</span>
                    <span>{currencyFmt(Number(bill.subtotal))}</span>
                  </div>
                  {Number(bill.discount_amount) > 0 && (
                    <div className="flex justify-between text-emerald-600 dark:text-emerald-400 font-medium">
                      <span>{t('discount')}</span>
                      <span>− {currencyFmt(Number(bill.discount_amount))}</span>
                    </div>
                  )}
                  <TaxBreakdown taxAmount={Number(bill.tax_amount)} taxBreakdown={resolveTaxComponents(bill).map((component) => ({
                    ...component,
                    rate: component.rate ?? 0,
                  }))} />
                  {Number(bill.delivery_charge) > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t('delivery')}</span>
                      <span>{currencyFmt(Number(bill.delivery_charge))}</span>
                    </div>
                  )}
                  {Number(bill.packaging_charge) > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t('packaging')}</span>
                      <span>{currencyFmt(Number(bill.packaging_charge))}</span>
                    </div>
                  )}
                  {Number(bill.service_charge) > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>{tReceipt('serviceCharge')}</span>
                      <span>{currencyFmt(Number(bill.service_charge))}</span>
                    </div>
                  )}
                  {Number(bill.round_off) !== 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t('roundOff')}</span>
                      <span>{Number(bill.round_off) > 0 ? '+' : ''}{currencyFmt(Number(bill.round_off))}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-foreground font-semibold border-t border-border pt-1.5 mt-1">
                    <span>{t('total')}</span>
                    <span>{currencyFmt(Number(bill.total))}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <aside className="mt-4 flex flex-col gap-2 rounded-2xl border-2 border-neutral-700 bg-neutral-900 p-3 self-start lg:mt-0 lg:sticky lg:top-0" aria-label="Cash amount keypad">
            <p className={`flex min-h-11 items-center justify-center rounded-xl px-2 text-base font-semibold ${tenderIndex === ABA_SETUP_TENDER ? 'bg-neutral-800 text-neutral-400' : 'bg-yellow-400 text-black'}`} data-testid="keypad-target">
              {tenderIndex === ABA_SETUP_TENDER ? 'Keypad off' : <>Typing into&nbsp;<b>{keypadTargetLabel}</b></>}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', ...(extraKey ? [extraKey] : []), 'Backspace'].map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={tenderIndex === ABA_SETUP_TENDER}
                  onClick={() => enterCashKey(key)}
                  aria-label={key}
                  className="min-h-[4.25rem] rounded-xl border-2 border-neutral-700 bg-neutral-800 text-3xl font-extrabold text-white hover:bg-neutral-700 disabled:opacity-40"
                >
                  {key === 'Backspace' ? '⌫' : key}
                </button>
              ))}
            </div>
            <button type="button" disabled={tenderIndex === ABA_SETUP_TENDER} onClick={() => enterCashKey('Clear')} className="min-h-14 w-full rounded-xl border-2 border-neutral-700 bg-neutral-800 text-lg font-bold text-white hover:bg-neutral-700 disabled:opacity-40">Clear</button>
          </aside>
        </div>

        <div className="px-5 pb-4 border-t-2 border-neutral-800 bg-black pt-3 space-y-2">
          {justPaid ? (
            <>
              {cartCustomer?.phone && (
                isWhatsAppReady ? (
                  <Button
                    onClick={handleSendWhatsApp}
                    disabled={sendingWa}
                    className="w-full bg-emerald-600 hover:bg-emerald-700"
                    size="lg"
                  >
                    <Send size={16} className="me-2" />
                    {sendingWa ? t('processingPayment') : t('sendViaWhatsApp')}
                  </Button>
                ) : (
                  <Button
                    onClick={handleShareWhatsApp}
                    variant="outline"
                    className="w-full"
                    size="lg"
                  >
                    <Send size={16} className="me-2" />
                    {tCommon('shareViaWhatsApp')}
                  </Button>
                )
              )}
              <Button onClick={onPaid} variant="outline" className="w-full" size="lg">
                {tCommon('done')}
              </Button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => handlePay(false)}
                disabled={processing || totalPaymentMinor < remainingMinor}
                className="flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl bg-green-500 text-2xl font-black text-black hover:bg-green-400 disabled:bg-neutral-800 disabled:text-neutral-400"
              >
                {processing
                  ? t('processingPayment')
                  : totalPaymentMinor < remainingMinor
                    ? `Still to pay ${currencyFmt(stillToPay)}`
                    : <>{t('pay')} {currencyFmt(remaining)} {paySubLabel && <span className="text-lg font-bold">{paySubLabel}</span>}</>}
              </button>
              {totalPaymentMinor > 0 && totalPaymentMinor < remainingMinor && (
                <Button onClick={() => handlePay(true)} disabled={processing} variant="outline" className="w-full min-h-12 border-2 border-neutral-500 bg-neutral-900 text-base font-bold text-white hover:bg-neutral-800" size="lg">
                  Record part payment · {currencyFmt(totalPayment)} (keep bill open)
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {ConfirmDialog}
    </div>
  );
}
