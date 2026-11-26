/**
 * BackStreet: print why an item was given free on the bill receipt.
 *
 * Items made free with the "Free" button carry order_items.comp_reason.
 * The receipt shows it as an item note, e.g. "Free – Event", so the
 * printed bill explains why the line is $0.
 */
export const FREE_REASON_RECEIPT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  entertainer: 'Entertainer / band',
  event: 'Event',
  event_person: 'Event person',
  owner_comp: 'Owner',
  complaint: 'Complaint',
  wrong_item: 'Wrong item',
  staff_meal: 'Staff meal',
  friends_owner: 'Friends / owner',
  too_slow: 'Took too long',
  other: 'Other',
});

/** "Free – Event" for a comped item, or '' when the item was not made free. */
export function freeReasonText(compReason: unknown): string {
  if (typeof compReason !== 'string' || !compReason.trim()) return '';
  const key = compReason.trim();
  return `Free – ${FREE_REASON_RECEIPT_LABELS[key] ?? key.replace(/_/g, ' ')}`;
}

/** The item's printed note with the free reason in front, joined by " · ". */
export function withFreeReason(specialInstructions: unknown, compReason: unknown): string {
  const note = typeof specialInstructions === 'string' ? specialInstructions.trim() : '';
  const free = freeReasonText(compReason);
  if (!free) return note;
  return note ? `${free} · ${note}` : free;
}
