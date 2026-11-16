/**
 * AI recipe helper: Google calls are mocked; checks mapping to inventory, unit safety and missing configuration.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/ai-recipe-helper.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ai-recipe-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, assertOrThrow, assertEqualOrThrow, getResults, resetCounters, seedOwnerUser } = require('./helpers/test-setup');
const { createSupply } = require('../main/services/supplies');
const { suggestRecipe, findPhotos, getAiHelperStatus } = require('../main/services/ai-recipe-helper');

async function rejects(fn: () => Promise<unknown>): Promise<{ statusCode?: number; message: string }> {
  try { await fn(); } catch (error: any) { return { statusCode: error.statusCode, message: String(error.message) }; }
  return { message: '' };
}

async function main() {
  console.log('AI recipe helper test');
  console.log('='.repeat(50));
  resetCounters();
  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;
  createSupply(db, { name: 'Gin', baseUnit: 'ml', actorUserId: actor });
  createSupply(db, { name: 'Tonic', baseUnit: 'ml', actorUserId: actor });
  createSupply(db, { name: 'Cune Crianza', baseUnit: 'ml', groupName: 'Red wine', actorUserId: actor });
  createSupply(db, { name: 'Lime', baseUnit: 'each', actorUserId: actor });

  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.GOOGLE_SEARCH_API_KEY;
  delete process.env.GOOGLE_SEARCH_CX;
  assertEqualOrThrow(getAiHelperStatus().recipes, false, 'recipes helper reports not configured');
  assertEqualOrThrow((await rejects(() => suggestRecipe(db, { name: 'Gin and tonic' }))).statusCode, 503, 'missing key gives a clear 503');
  assertEqualOrThrow((await rejects(() => findPhotos({ query: 'gin' }))).statusCode, 503, 'missing search config gives a clear 503');

  const realFetch = globalThis.fetch;
  let lastUrl = '';
  let lastBody = '';
  (globalThis as any).fetch = async (url: string, init: any) => {
    lastUrl = String(url);
    lastBody = String(init?.body ?? '');
    if (lastUrl.includes('generativelanguage')) {
      const answer = {
        yield: 1,
        notes: 'Classic build',
        items: [
          { ingredient: 'gin', quantity: 40, unit: 'ml' },
          { ingredient: 'Tonic', quantity: 0.15, unit: 'l' },
          { ingredient: 'Red wine', quantity: 150, unit: 'ml' },
          { ingredient: 'Lime', quantity: 30, unit: 'ml' },
          { ingredient: 'Ice', quantity: 100, unit: 'g' },
          { ingredient: 'Gin', quantity: 5, unit: 'ml' },
        ],
      };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [
      { title: 'Coca-Cola can', link: 'https://example.com/coke.jpg', displayLink: 'example.com', image: { thumbnailLink: 'https://t.example.com/coke.jpg' } },
      { title: 'insecure', link: 'http://example.com/x.jpg' },
    ] }), { status: 200 });
  };

  process.env.GOOGLE_AI_API_KEY = 'test-key';
  const suggestion = await suggestRecipe(db, { name: 'Gin and tonic', category: 'Cocktails' });
  assertOrThrow(lastUrl.includes('generativelanguage.googleapis.com'), 'recipe request goes to Google AI');
  assertOrThrow(lastBody.includes('Cune Crianza') && lastBody.includes('Red wine'), 'prompt lists the real inventory and groups');
  assertEqualOrThrow(suggestion.items.length, 3, 'matched ingredients are returned once each');
  assertEqualOrThrow(suggestion.items[0].name, 'Gin', 'names match case-insensitively to inventory');
  assertEqualOrThrow(suggestion.items[2].group_name, 'Red wine', 'a group name becomes an any-in-group line');
  assertEqualOrThrow(suggestion.not_in_inventory.length, 2, 'unknown ingredients and unit mismatches are reported, not added');
  assertOrThrow(suggestion.not_in_inventory.some((i: any) => i.name === 'Ice'), 'Ice is reported as missing from inventory');
  assertOrThrow(suggestion.not_in_inventory.some((i: any) => i.name === 'Lime'), 'ml quantity for an each item is not silently accepted');

  process.env.GOOGLE_SEARCH_API_KEY = 'k';
  process.env.GOOGLE_SEARCH_CX = 'cx';
  const photos = await findPhotos({ query: 'Coca-Cola can' });
  assertOrThrow(lastUrl.includes('searchType=image'), 'photo search asks Google for images');
  assertEqualOrThrow(photos.length, 1, 'only https images are offered');
  assertEqualOrThrow(photos[0].thumbnail_url, 'https://t.example.com/coke.jpg', 'thumbnail is returned');

  (globalThis as any).fetch = async () => new Response('{}', { status: 500 });
  assertEqualOrThrow((await rejects(() => suggestRecipe(db, { name: 'x' }))).statusCode, 502, 'Google errors become a clear 502');
  (globalThis as any).fetch = async () => { throw new Error('offline'); };
  assertEqualOrThrow((await rejects(() => suggestRecipe(db, { name: 'x' }))).statusCode, 502, 'offline fails gracefully');
  assertEqualOrThrow((await rejects(() => suggestRecipe(db, { name: '  ' }))).statusCode, 400, 'a name is required');
  globalThis.fetch = realFetch;

  const { passed, failed, total } = getResults();
  console.log(`\nPassed: ${passed}/${total}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
