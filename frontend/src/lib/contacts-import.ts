export interface ContactRow {
  name: string;
  phone: string;
  email: string;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const NAME_HEADERS = ['name', 'full name', 'display name', 'first name', 'given name'];
const LAST_HEADERS = ['last name', 'family name', 'surname'];
const PHONE_HEADERS = ['phone', 'phone number', 'mobile', 'mobile phone', 'tel', 'telephone', 'phone 1 - value', 'cell'];
const EMAIL_HEADERS = ['email', 'e-mail', 'e-mail 1 - value', 'email address'];

function findColumn(header: string[], names: string[]): number {
  return header.findIndex((h) => names.includes(h));
}

export function parseContactsCsv(text: string): ContactRow[] {
  const rows = parseCsvRows(text.replace(/^﻿/, ''));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const nameCol = findColumn(header, NAME_HEADERS);
  const phoneCol = findColumn(header, PHONE_HEADERS);
  const hasHeader = nameCol >= 0 || phoneCol >= 0;
  const lastCol = findColumn(header, LAST_HEADERS);
  const emailCol = findColumn(header, EMAIL_HEADERS);
  const body = hasHeader ? rows.slice(1) : rows;
  const nameIdx = hasHeader ? nameCol : 0;
  const phoneIdx = hasHeader ? phoneCol : 1;

  return body.map((r) => {
    const first = nameIdx >= 0 ? (r[nameIdx] ?? '').trim() : '';
    const last = lastCol >= 0 ? (r[lastCol] ?? '').trim() : '';
    return {
      name: [first, last].filter(Boolean).join(' '),
      phone: phoneIdx >= 0 ? (r[phoneIdx] ?? '').trim() : '',
      email: emailCol >= 0 ? (r[emailCol] ?? '').trim() : '',
    };
  });
}

export function parseContactsVcf(text: string): ContactRow[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const cards = unfolded.split(/BEGIN:VCARD/i).slice(1);
  return cards.map((card) => {
    const lines = card.split(/\r?\n/);
    const value = (key: RegExp) => {
      const line = lines.find((l) => key.test(l));
      return line ? line.slice(line.indexOf(':') + 1).trim() : '';
    };
    let name = value(/^FN[;:]/i);
    if (!name) {
      const [last = '', first = ''] = value(/^N[;:]/i).split(';');
      name = [first, last].filter(Boolean).join(' ');
    }
    return { name, phone: value(/^TEL[;:]/i), email: value(/^EMAIL[;:]/i) };
  });
}

export function parseContactsFile(fileName: string, text: string): ContactRow[] {
  const rows = /\.vcf$/i.test(fileName) || /BEGIN:VCARD/i.test(text.slice(0, 200))
    ? parseContactsVcf(text)
    : parseContactsCsv(text);
  return rows.filter((r) => r.name);
}
