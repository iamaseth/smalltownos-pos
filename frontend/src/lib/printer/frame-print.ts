/**
 * Prints a complete HTML document through Chrome's print path using a hidden
 * same-origin iframe.
 *
 * Why not a popup: popups opened after an await (payment, order save) lose the
 * click's user activation and get blocked, and closing a popup straight after
 * print() can cancel Chrome's print preview — nothing reaches the printer and
 * no error is shown. A frame needs no popup permission, waits for its content
 * and fonts, and is removed only after the print finished.
 *
 * With Chrome started with --kiosk-printing this prints silently to the
 * Windows default printer (the BackStreet thermal printer).
 */
export interface FramePrintOptions {
  /** Physical roll width for content-sized customer receipts. */
  receiptPaperWidthMm?: 58 | 80;
}

export async function printHtmlInFrame(html: string, options: FramePrintOptions = {}): Promise<void> {
  if (typeof document === 'undefined') throw new Error('Printing needs a browser');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Rendered but invisible: display:none frames print blank in Chrome.
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
  document.body.appendChild(frame);

  // Remove the frame only after Chrome says printing finished. Removing it
  // while the print dialog is open blanks the preview ("nothing to print").
  let removed = false;
  const removeFrame = () => { if (!removed) { removed = true; try { frame.remove(); } catch { /* gone */ } } };
  const safety = setTimeout(removeFrame, 10 * 60_000);

  try {
    const win = frame.contentWindow;
    const doc = frame.contentDocument ?? win?.document;
    if (!win || !doc) throw new Error('Could not open the print frame');
    doc.open();
    doc.write(html);
    doc.close();

    // Let layout, images and fonts settle so the first print is not blank.
    const pending = Array.from(doc.images).filter((img) => !img.complete);
    await Promise.race([
      Promise.all([
        ...pending.map((img) => new Promise<void>((resolve) => { img.onload = img.onerror = () => resolve(); })),
        (doc as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready ?? Promise.resolve(),
      ]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));

    // Customer receipts use a continuous roll. Ask Chrome for a page whose
    // height matches the rendered receipt instead of the printer driver's
    // multi-metre default roll length. This option is only passed by the
    // customer-bill browser path; kitchen tickets keep their existing sizing.
    if (options.receiptPaperWidthMm) {
      // Test and embedded print documents may expose only the minimal DOM surface.
      // Skip content-height sizing when querySelector is unavailable; printing still works.
      const receipt = typeof doc.querySelector === 'function'
        ? doc.querySelector<HTMLElement>('.bill-container')
        : null;
      if (receipt) {
        const contentHeightPx = Math.max(
          receipt.scrollHeight,
          receipt.getBoundingClientRect().height,
        );
        if (contentHeightPx > 0) {
          // Convert CSS pixels at 96dpi to millimetres and leave a small
          // trailing allowance for the printer's cutter.
          const pageHeightMm = Math.max(25, Math.ceil((contentHeightPx * 25.4) / 96 + 3));
          const pageStyle = doc.createElement('style');
          pageStyle.media = 'print';
          pageStyle.textContent = `
            @page { size: ${options.receiptPaperWidthMm}mm ${pageHeightMm}mm; margin: 0; }
            @media print {
              html, body {
                width: ${options.receiptPaperWidthMm}mm !important;
                height: auto !important;
                min-height: 0 !important;
                margin: 0 !important;
                padding: 0 !important;
              }
            }
          `;
          doc.head.appendChild(pageStyle);
        }
      }
    }

    win.addEventListener('afterprint', () => {
      clearTimeout(safety);
      // Small delay so Chrome finishes handing the job to the printer.
      setTimeout(removeFrame, 1000);
    }, { once: true });
    win.focus();
    win.print(); // Chrome blocks here until the dialog closes, or prints at once in kiosk mode
  } catch (error) {
    clearTimeout(safety);
    removeFrame();
    throw error;
  }
}
