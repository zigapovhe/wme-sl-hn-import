'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeHN,
  buildHouseNumber,
  normalizeStreetName,
  buildCqlFilter
} = require('../wme-sl-hn-import.user.js');

test('normalizeHN collapses internal whitespace', () => {
  // The bug this guards: WME "12 a" vs eProstor "12a" made the audit report a
  // valid house number as missing, which invites deleting good data.
  assert.strictEqual(normalizeHN('12 a'), '12a');
  assert.strictEqual(normalizeHN('12a'), '12a');
  assert.strictEqual(normalizeHN('  12   A  '), '12a');
});

test('normalizeHN lowercases and trims', () => {
  assert.strictEqual(normalizeHN('12A'), '12a');
  assert.strictEqual(normalizeHN(' 7 '), '7');
});

test('normalizeHN keeps "/" as a distinguishing character', () => {
  // Deliberate: "12/1" and "121" are different addresses.
  assert.strictEqual(normalizeHN('12/1'), '12/1');
  assert.notStrictEqual(normalizeHN('12/1'), normalizeHN('121'));
});

test('normalizeHN handles null and undefined without throwing', () => {
  assert.strictEqual(normalizeHN(null), '');
  assert.strictEqual(normalizeHN(undefined), '');
  assert.strictEqual(normalizeHN(''), '');
});

test('normalizeHN accepts numbers', () => {
  assert.strictEqual(normalizeHN(12), '12');
});

test('buildHouseNumber joins number and suffix through the same rule', () => {
  assert.strictEqual(buildHouseNumber('12', 'A'), '12a');
  assert.strictEqual(buildHouseNumber('12', null), '12');
  assert.strictEqual(buildHouseNumber(' 12 ', ' b '), '12b');
});

test('buildHouseNumber agrees with normalizeHN, so both sides of a comparison match', () => {
  // These must never drift: one is used on the eProstor side, the other on the
  // WME side, and the audit compares their outputs directly.
  assert.strictEqual(buildHouseNumber('12', 'a'), normalizeHN('12 a'));
});

test('normalizeStreetName trims, like normalizeHN', () => {
  // A WME street typed with a stray space would otherwise key as "celovska_cesta_",
  // match nothing in the eProstor data, and drop the whole street from the audit.
  const expected = normalizeStreetName('Celovška cesta');
  assert.strictEqual(normalizeStreetName('Celovška cesta '), expected);
  assert.strictEqual(normalizeStreetName(' Celovška cesta'), expected);
  assert.strictEqual(normalizeStreetName('  Celovška cesta  '), expected);
});

test('normalizeStreetName lowercases and underscores whitespace', () => {
  assert.strictEqual(normalizeStreetName('Ulica prekomorskih brigad'),
    'ulica_prekomorskih_brigad');
  assert.strictEqual(normalizeStreetName('Celovška cesta'), 'celovška_cesta');
});

test('buildCqlFilter embeds the bounds and excludes apartments', () => {
  const filter = buildCqlFilter(1, 2, 3, 4);
  assert.match(filter, /E>=1/);
  assert.match(filter, /E<=3/);
  assert.match(filter, /N>=2/);
  assert.match(filter, /N<=4/);
  assert.match(filter, /ST_STANOVANJA IS NULL/);
});
