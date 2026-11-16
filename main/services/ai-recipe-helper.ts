import { getDatabase } from '../db';
import { convertQuantity, SUPPLY_UNITS, type SupplyUnit } from './units';

export class AiRecipeHelperError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AiRecipeHelperError';
  }
}

export interface AiSuggestedItem {
  supply_id: string | null;
  group_name: string | null;
  name: string;
  quantity: number;
  unit: SupplyUnit;
}

export interface AiRecipeSuggestion {
  yield_quantity: number;
  items: AiSuggestedItem[];
  not_in_inventory: Array<{ name: string; quantity: number; unit: string }>;
  notes: string;
}

export interface AiPhotoCandidate {
  title: string;
  image_url: string;
  thumbnail_url: string;
  source: string;
}

const MAX_INVENTORY_NAMES = 300;
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MODEL = 'gemini-2.5-flash';

function nameKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function getAiHelperStatus(): { recipes: boolean; photos: boolean } {
  return {
    recipes: Boolean(process.env.GOOGLE_AI_API_KEY?.trim()),
    photos: Boolean(process.env.GOOGLE_SEARCH_API_KEY?.trim() && process.env.GOOGLE_SEARCH_CX?.trim()),
  };
}

function notConfigured(missing: string): AiRecipeHelperError {
  return new AiRecipeHelperError(503, `AI helper is not set up: ${missing} is missing on the server`);
}

async function callGoogle(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new AiRecipeHelperError(502, 'Could not reach Google. Check the internet connection and try again');
  }
  if (!response.ok) {
    throw new AiRecipeHelperError(502, `Google returned an error (${response.status})`);
  }
  try {
    return await response.json();
  } catch {
    throw new AiRecipeHelperError(502, 'Google returned an unreadable answer');
  }
}

function cleanName(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim().slice(0, 120) : '';
  if (!text) throw new AiRecipeHelperError(400, `${field} is required`);
  return text;
}

export async function suggestRecipe(
  db: ReturnType<typeof getDatabase>,
  input: { name: unknown; category?: unknown },
): Promise<AiRecipeSuggestion> {
  const apiKey = process.env.GOOGLE_AI_API_KEY?.trim();
  if (!apiKey) throw notConfigured('GOOGLE_AI_API_KEY');
  const name = cleanName(input.name, 'name');
  const category = typeof input.category === 'string' ? input.category.trim().slice(0, 120) : '';

  const supplies = db.prepare(`
    SELECT id, name, base_unit, group_name FROM supplies WHERE deleted_at IS NULL AND is_active = 1 ORDER BY name LIMIT ?
  `).all(MAX_INVENTORY_NAMES) as Array<{ id: string; name: string; base_unit: SupplyUnit; group_name: string | null }>;
  const bySupply = new Map(supplies.map((s) => [nameKey(s.name), s]));
  const byGroup = new Map<string, { group: string; unit: SupplyUnit }>();
  for (const s of supplies) {
    if (s.group_name) byGroup.set(nameKey(s.group_name), { group: s.group_name, unit: s.base_unit });
  }
  const inventoryNames = [...new Set([...supplies.map((s) => s.name), ...[...byGroup.values()].map((g) => g.group)])];

  const prompt = [
    `Write a standard single-serving recipe for the menu item "${name}"${category ? ` (menu category: ${category})` : ''} for a small bar and restaurant in Kampot, Cambodia.`,
    'Use typical portion sizes for a bar or restaurant, not a home cook.',
    'Prefer ingredients from this inventory list and copy their names exactly:',
    inventoryNames.join('; ') || '(inventory is empty)',
    'If an ingredient is not in the list, still include it with a plain generic name.',
    `Units must be one of: ${SUPPLY_UNITS.join(', ')}. Keep the list to the main ingredients.`,
  ].join('\n');

  const model = (process.env.GOOGLE_AI_MODEL?.trim() || DEFAULT_MODEL).replace(/[^a-zA-Z0-9._-]/g, '');
  const payload = await callGoogle(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              yield: { type: 'NUMBER' },
              notes: { type: 'STRING' },
              items: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: { ingredient: { type: 'STRING' }, quantity: { type: 'NUMBER' }, unit: { type: 'STRING' } },
                  required: ['ingredient', 'quantity', 'unit'],
                },
              },
            },
            required: ['items'],
          },
        },
      }),
    },
  ) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  let parsed: { yield?: unknown; notes?: unknown; items?: unknown };
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new AiRecipeHelperError(502, 'The AI answer could not be read. Try again');
  }
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];

  const result: AiRecipeSuggestion = {
    yield_quantity: Number(parsed.yield) > 0 ? Number(parsed.yield) : 1,
    items: [],
    not_in_inventory: [],
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 500) : '',
  };
  const seen = new Set<string>();
  for (const raw of rawItems as Array<{ ingredient?: unknown; quantity?: unknown; unit?: unknown }>) {
    const ingredient = typeof raw?.ingredient === 'string' ? raw.ingredient.trim() : '';
    const quantity = Number(raw?.quantity);
    const unit = String(raw?.unit ?? '').trim().toLowerCase();
    if (!ingredient || !Number.isFinite(quantity) || quantity <= 0) continue;
    const supply = bySupply.get(nameKey(ingredient));
    const group = supply ? undefined : byGroup.get(nameKey(ingredient));
    const baseUnit = supply?.base_unit ?? group?.unit;
    const unitOk = (SUPPLY_UNITS as readonly string[]).includes(unit);
    let convertible = false;
    if (baseUnit && unitOk) {
      try { convertQuantity(quantity, unit as SupplyUnit, baseUnit); convertible = true; } catch { convertible = false; }
    }
    if (!baseUnit || !convertible) {
      result.not_in_inventory.push({ name: ingredient, quantity, unit });
      continue;
    }
    const key = supply ? supply.id : `group:${nameKey(ingredient)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.items.push({
      supply_id: supply ? supply.id : null,
      group_name: group ? group.group : null,
      name: supply ? supply.name : (group as { group: string }).group,
      quantity,
      unit: unit as SupplyUnit,
    });
  }
  return result;
}

export async function findPhotos(input: { query: unknown }): Promise<AiPhotoCandidate[]> {
  const key = process.env.GOOGLE_SEARCH_API_KEY?.trim();
  const cx = process.env.GOOGLE_SEARCH_CX?.trim();
  if (!key) throw notConfigured('GOOGLE_SEARCH_API_KEY');
  if (!cx) throw notConfigured('GOOGLE_SEARCH_CX');
  const query = cleanName(input.query, 'query');
  const params = new URLSearchParams({ key, cx, q: query, searchType: 'image', num: '6', safe: 'active', imgType: 'photo' });
  const payload = await callGoogle(`https://customsearch.googleapis.com/customsearch/v1?${params.toString()}`, { method: 'GET' }) as {
    items?: Array<{ title?: string; link?: string; displayLink?: string; image?: { thumbnailLink?: string } }>;
  };
  const photos: AiPhotoCandidate[] = [];
  for (const item of payload.items ?? []) {
    if (typeof item.link !== 'string' || !item.link.startsWith('https://')) continue;
    const thumbnail = item.image?.thumbnailLink;
    photos.push({
      title: String(item.title ?? '').slice(0, 120),
      image_url: item.link,
      thumbnail_url: typeof thumbnail === 'string' && thumbnail.startsWith('https://') ? thumbnail : item.link,
      source: String(item.displayLink ?? ''),
    });
  }
  return photos;
}
