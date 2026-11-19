/**
 * Minimal text-only PDF writer (A4, Helvetica and Courier for aligned tables, WinAnsi).
 * Enough for management reports without adding a PDF dependency.
 */

export type PdfLine = { text: string; bold?: boolean; mono?: boolean; size?: number; gap?: number };

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 48;

function toWinAnsi(text: string): string {
  const replacements: Record<string, string> = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '*', '·': '-' };
  return [...text].map((ch) => {
    if (replacements[ch]) return replacements[ch];
    const code = ch.codePointAt(0) ?? 63;
    return code < 32 || code > 255 ? '?' : ch;
  }).join('');
}

function escapePdfString(text: string): string {
  return toWinAnsi(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildTextPdf(lines: PdfLine[]): Buffer {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = PAGE_HEIGHT - MARGIN;
  const flush = () => { pages.push(ops.join('\n')); ops = []; y = PAGE_HEIGHT - MARGIN; };
  for (const line of lines) {
    const size = line.size ?? 10;
    const advance = size * 1.35 + (line.gap ?? 0);
    if (y - advance < MARGIN) flush();
    y -= advance;
    ops.push(`BT /${line.mono ? (line.bold ? 'F4' : 'F3') : line.bold ? 'F2' : 'F1'} ${size} Tf ${MARGIN} ${y.toFixed(1)} Td (${escapePdfString(line.text)}) Tj ET`);
  }
  if (ops.length || pages.length === 0) flush();

  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const fontMono = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const fontMonoBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];
  for (const content of pages) {
    const stream = Buffer.from(content, 'latin1');
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R /F3 ${fontMono} 0 R /F4 ${fontMonoBold} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Pads cells for Courier rows: first column left-aligned, the rest right-aligned. */
export function pdfRow(cells: Array<string | number>, widths: number[]): string {
  return cells.map((cell, index) => {
    const text = String(cell);
    const width = widths[index] ?? 12;
    const clipped = text.length > width ? `${text.slice(0, width - 1)}.` : text;
    return index === 0 ? clipped.padEnd(width) : clipped.padStart(width);
  }).join(' ');
}
