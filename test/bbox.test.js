'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeFetchBbox } = require('../wme-sl-hn-import.user.js');

// Stand-in for proj4: multiplies by 1000 so projected metres stay easy to read.
// The real projection is proj4's business, not this function's.
const project = (from, to, [lon, lat]) => [lon * 1000, lat * 1000];

function segment(coords) {
  return { geometry: { coordinates: coords } };
}

test('bbox spans all segments and is grown by the buffer', () => {
  const bbox = computeFetchBbox(
    [segment([[10, 20], [11, 21]]), segment([[9, 19], [10, 20]])],
    500,
    project
  );
  assert.deepStrictEqual(bbox, {
    minE: 9000 - 500,
    minN: 19000 - 500,
    maxE: 11000 + 500,
    maxN: 21000 + 500
  });
});

test('a zero buffer still yields the tight extent', () => {
  const bbox = computeFetchBbox([segment([[10, 20], [12, 22]])], 0, project);
  assert.deepStrictEqual(bbox, { minE: 10000, minN: 20000, maxE: 12000, maxN: 22000 });
});

test('bounds are widened to whole metres, never narrowed', () => {
  // floor on the minimum and ceil on the maximum, so rounding can only ever
  // request slightly more area than needed — never miss an address at the edge.
  const fractional = (from, to, [lon, lat]) => [lon + 0.4, lat + 0.4];
  const bbox = computeFetchBbox([segment([[10, 20], [10, 20]])], 0, fractional);
  assert.strictEqual(bbox.minE, 10, 'min floored');
  assert.strictEqual(bbox.maxE, 11, 'max ceiled');
});

test('segments without usable geometry are ignored', () => {
  const bbox = computeFetchBbox(
    [{}, { geometry: null }, { geometry: { coordinates: 'nope' } }, segment([[10, 20]])],
    0,
    project
  );
  assert.deepStrictEqual(bbox, { minE: 10000, minN: 20000, maxE: 10000, maxN: 20000 });
});

test('null when nothing has geometry', () => {
  assert.strictEqual(computeFetchBbox([], 500, project), null);
  assert.strictEqual(computeFetchBbox(null, 500, project), null);
  assert.strictEqual(computeFetchBbox([{}, { geometry: null }], 500, project), null);
});

test('negative coordinates are handled', () => {
  const bbox = computeFetchBbox([segment([[-5, -3], [2, 4]])], 100, project);
  assert.deepStrictEqual(bbox, {
    minE: -5000 - 100,
    minN: -3000 - 100,
    maxE: 2000 + 100,
    maxN: 4000 + 100
  });
});
