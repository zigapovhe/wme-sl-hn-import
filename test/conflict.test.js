'use strict';

// hasConflict was exported and allow-listed as test surface, but nothing imported it
// while the README claimed conflict detection was unit tested. These close that gap.

const test = require('node:test');
const assert = require('node:assert');

const { hasConflict, MAX_HN_CONFLICT_DISTANCE } = require('../wme-sl-hn-import.user.js');

// Coordinates are EPSG:3794 metres, so distances here are literal.
// `entry` is a street's WME house numbers, shaped as getVisibleHNsByStreet builds it.
const entry = (items) => ({
  set: new Set(items.filter(Boolean).map(i => i.num)),
  items
});

test('a different number close by is a conflict', () => {
  // The point of the check: eProstor says "12" here, but WME already has "14" almost
  // on the same spot, so one of them is wrong.
  assert.strictEqual(
    hasConflict('12', 100, 100, entry([{ num: '14', x: 100, y: 100 }])),
    true
  );
});

test('the same number close by is not a conflict', () => {
  // Same address, already present — that is "processed", not a conflict.
  assert.strictEqual(
    hasConflict('12', 100, 100, entry([{ num: '12', x: 100, y: 100 }])),
    false
  );
});

test('a different number far away is not a conflict', () => {
  assert.strictEqual(
    hasConflict('12', 100, 100, entry([{ num: '14', x: 100, y: 100 + MAX_HN_CONFLICT_DISTANCE + 5 }])),
    false
  );
});

test('the conflict threshold is inclusive at exactly MAX_HN_CONFLICT_DISTANCE', () => {
  assert.strictEqual(
    hasConflict('12', 100, 100, entry([{ num: '14', x: 100, y: 100 + MAX_HN_CONFLICT_DISTANCE }])),
    true,
    'exactly at the threshold counts as conflicting'
  );
  assert.strictEqual(
    hasConflict('12', 100, 100, entry([{ num: '14', x: 100, y: 100 + MAX_HN_CONFLICT_DISTANCE + 0.5 }])),
    false
  );
});

test('one conflicting neighbour among many is enough', () => {
  assert.strictEqual(
    hasConflict('12', 100, 100, entry([
      { num: '20', x: 900, y: 900 },
      { num: '22', x: 800, y: 800 },
      { num: '14', x: 103, y: 104 }
    ])),
    true
  );
});

test('missing or empty input is not a conflict', () => {
  assert.strictEqual(hasConflict('12', 100, 100, undefined), false);
  assert.strictEqual(hasConflict('12', 100, 100, null), false);
  assert.strictEqual(hasConflict('12', 100, 100, entry([])), false);
});

test('items without coordinates are skipped, not treated as co-located', () => {
  // Query point deliberately near the origin: if the null guard were dropped, null
  // would coerce to 0 in the arithmetic and land *within* the threshold, reporting a
  // phantom conflict. Testing this far from 0,0 cannot tell the two apart.
  assert.strictEqual(
    hasConflict('12', 5, 5, entry([{ num: '14', x: null, y: null }])),
    false
  );
  assert.strictEqual(
    hasConflict('12', 5, 5, entry([{ num: '14', x: undefined, y: undefined }])),
    false
  );
  assert.strictEqual(hasConflict('12', 5, 5, entry([null])), false);
});
