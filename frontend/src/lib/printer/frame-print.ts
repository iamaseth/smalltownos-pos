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
  /** Fixed driver page length for paginated browser-mode reports. */
  receiptPageLengthMm?: number;
  /** Repeated heading on each fixed-length report page. */
  reportPageLabel?: string;
}

const isPreferredBreak = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === '' || (/^[A-Z][A-Z0-9 ,&/()#.-]+$/.test(trimmed) && trimmed.length > 2);
};

/** Split whole receipt lines, preferring blank lines and section headings. */
export function paginateReportLines(lines: string[], capacity: number): string[][] {
  if (capacity < 1 || lines.length <= capacity) return [lines];
  const pages: string[][] = [];
  let start = 0;
  while (start < lines.length) {
    const hardEnd = Math.min(lines.length, start + capacity);
    if (hardEnd === lines.length) {
      pages.push(lines.slice(start));
      break;
    }
    let end = hardEnd;
    const earliest = start + Math.max(1, Math.floor(capacity * 0.6));
    for (let candidate = hardEnd; candidate > earliest; candidate -= 1) {
      if (isPreferredBreak(lines[candidate] ?? '')) {
        end = candidate;
        break;
      }
      if ((lines[candidate - 1] ?? '').trim() === '') {
        end = candidate;
        break;
      }
    }
    pages.push(lines.slice(start, end));
    start = end;
  }
  return pages;
}

/**
 * Splits rendered rows into pages of at most `capacityPx`, preferring to break before a
 * dashed rule or a section heading in the last 40% of a page. A row taller than a page
 * gets a page to itself.
 */
export function paginateRichRows(rows: HTMLElement[], capacityPx: number): HTMLElement[][] {
  const heights = rows.map((r) => {
    const style = r.ownerDocument.defaultView?.getComputedStyle(r);
    const margin = style ? (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0) : 0;
    return r.getBoundingClientRect().height + margin;
  });
  const total = heights.reduce((a, h) => a + h, 0);
  if (!(capacityPx > 0) || total <= capacityPx) return [rows];
  const isBreak = (r: HTMLElement) => r.classList.contains('r-rule') || r.classList.contains('r-section');
  const pages: HTMLElement[][] = [];
  let start = 0;
  while (start < rows.length) {
    let used = 0;
    let end = start;
    while (end < rows.length && (used + heights[end] <= capacityPx || end === start)) { used += heights[end]; end += 1; }
    if (end < rows.length) {
      let acc = 0;
      for (let k = start; k < end; k += 1) {
        acc += heights[k];
        if (k > start && isBreak(rows[k]) && acc - heights[k] >= capacityPx * 0.6) { end = k; }
      }
    }
    pages.push(rows.slice(start, end));
    start = end;
  }
  return pages;
}

function paginateReceiptReport(doc: Document, options: FramePrintOptions): void {
  const pageLength = options.receiptPageLengthMm;
  const paperWidth = options.receiptPaperWidthMm;
  const root = doc.querySelector<HTMLElement>('.receipt-report');
  if (!pageLength || !paperWidth || !root) return;
  const lineNodes = Array.from(root.querySelectorAll<HTMLElement>('.receipt-line'));
  if (!lineNodes.length) return;

  const ruler = doc.createElement('div');
  ruler.style.cssText = 'position:absolute;visibility:hidden;width:1mm;height:100mm;padding:0;margin:0;border:0;';
  doc.body.appendChild(ruler);
  const pxPerMm = ruler.getBoundingClientRect().height / 100;
  ruler.remove();
  const lineHeight = lineNodes[0].getBoundingClientRect().height;
  if (!(pxPerMm > 0) || !(lineHeight > 0)) throw new Error('Could not measure receipt report line height');

  // The driver page is fixed; reserve 8 mm for the repeated header/footer.
  const label = options.reportPageLabel || doc.title || 'Report';
  // Rich cashier receipts (rows of different sizes) move the row elements onto pages so
  // big totals and bold lines keep their look; plain-text reports re-flow as text.
  const rich = root.dataset.rich === '1';
  const pages: (string[] | HTMLElement[])[] = rich
    ? paginateRichRows(lineNodes, (pageLength - 8) * pxPerMm)
    : paginateReportLines(lineNodes.map((line) => line.textContent ?? ''), Math.max(1, Math.floor(((pageLength - 8) * pxPerMm) / lineHeight)));
  root.replaceChildren(...pages.map((pageLines, index) => {
    const page = doc.createElement('section');
    page.className = 'receipt-page';
    const header = doc.createElement('div');
    header.className = 'receipt-page-header';
    header.textContent = `${label} · page ${index + 1} of ${pages.length}`;
    let content: HTMLElement;
    if (rich) {
      content = doc.createElement('div');
      content.append(...(pageLines as HTMLElement[]));
    } else {
      content = doc.createElement('pre');
      content.textContent = (pageLines as string[]).join('\n');
    }
    content.className = 'receipt-page-content';
    page.append(header, content);
    if (index < pages.length - 1) {
      const footer = doc.createElement('div');
      footer.className = 'receipt-page-footer';
      footer.textContent = 'continued →';
      page.appendChild(footer);
    }
    return page;
  }));

  const style = doc.createElement('style');
  style.media = 'print';
  style.textContent = `
    @page { size: ${paperWidth}mm ${pageLength}mm; margin: 0; }
    @media print {
      html, body { width: ${paperWidth}mm !important; height: auto !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; display: block !important; }
      .receipt-report { margin: 0 !important; padding: 0 !important; }
      .receipt-page { box-sizing: border-box; width: ${paperWidth}mm; height: ${pageLength}mm; margin: 0; padding: 1mm 0; break-after: page; page-break-after: always; overflow: hidden; }
      .receipt-page:last-child { break-after: auto; page-break-after: auto; }
      .receipt-page-header, .receipt-page-footer { font: 10px/1.25 'Courier New', monospace; white-space: nowrap; }
      .receipt-page-content { margin: 0; padding: 0; font: 12px/1.25 'Courier New', monospace; white-space: pre; }
      .receipt-report[data-rich="1"] .receipt-page-content { font: inherit; white-space: normal; padding: 0 3mm; }
      .receipt-page-footer { text-align: right; }
    }
  `;
  doc.head.appendChild(style);
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

    if (options.receiptPageLengthMm) paginateReceiptReport(doc, options);

    // Customer receipts use a continuous roll. Ask Chrome for a page whose
    // height matches the rendered receipt instead of the printer driver's
    // multi-metre default roll length. This option is only passed by the
    // customer-bill browser path; kitchen tickets keep their existing sizing.
    if (options.receiptPaperWidthMm && !options.receiptPageLengthMm) {
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
