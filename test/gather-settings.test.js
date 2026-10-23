import test from 'node:test';
import assert from 'node:assert/strict';
import { readGatherSettings, saveGatherSettings, GATHER_STORAGE_KEY } from '../ui/gather-storage.js';
import { validateGatherSettings } from '../src/gather-settings.js';

const settings = { url: 'https://api.v2.gather.town/example', secret: 'whsec_TEST_ONLY_12345678901234567890' };
test('browser credentials require both fields on every storage read', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readGatherSettings(storage), null);
  saveGatherSettings(storage, settings); assert.deepEqual(readGatherSettings(storage), settings);
  values.clear(); assert.equal(readGatherSettings(storage), null);
  for (const value of ['{', 'null', '{}', JSON.stringify({ url: settings.url }), JSON.stringify({ secret: settings.secret })]) {
    values.set(GATHER_STORAGE_KEY, value); assert.equal(readGatherSettings(storage), null);
  }
});
test('unavailable browser storage is treated as missing configuration', () => {
  const storage = { getItem() { throw Error('storage denied'); } };
  assert.equal(readGatherSettings(storage), null);
});
test('Gather settings validate URL and secret without exposing supplied values', () => {
  assert.deepEqual(validateGatherSettings(settings), settings);
  for (const value of [{}, { ...settings, url: 'http://localhost/private' }, { ...settings, secret: 'PRIVATE' }, { ...settings, url: 'https://user:PRIVATE@example.com' }]) {
    assert.throws(() => validateGatherSettings(value), error => !error.message.includes('PRIVATE'));
  }
});
