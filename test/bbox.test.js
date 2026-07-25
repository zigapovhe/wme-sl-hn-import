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

const { isSelectionInsideBbox, NON_ADDRESSABLE_ROAD_TYPES } = require('../wme-sl-hn-import.user.js');

test('a selection fully inside the box counts as covered', () => {
  const bbox = { minE: 0, minN: 0, maxE: 100000, maxN: 100000 };
  assert.strictEqual(isSelectionInsideBbox([segment([[10, 20], [11, 21]])], bbox, project), true);
});

test('a selection reaching outside the box is not covered', () => {
  const bbox = { minE: 0, minN: 0, maxE: 10500, maxN: 100000 };
  assert.strictEqual(isSelectionInsideBbox([segment([[10, 20], [11, 21]])], bbox, project), false);
});

test('coverage is false unless at least one point was verified', () => {
  // The bug this guards: returning true after examining nothing claimed coverage that
  // was never checked, and auto-load silently stopped fetching.
  const bbox = { minE: 0, minN: 0, maxE: 100000, maxN: 100000 };
  assert.strictEqual(isSelectionInsideBbox([], bbox, project), false, 'empty selection');
  assert.strictEqual(isSelectionInsideBbox([{}], bbox, project), false, 'segment with no geometry');
  assert.strictEqual(isSelectionInsideBbox([{ geometry: { coordinates: [] } }], bbox, project), false,
    'geometry with no points');
});

test('NaN coordinates are not treated as covered', () => {
  const bbox = { minE: 0, minN: 0, maxE: 100000, maxN: 100000 };
  const nanProject = () => [NaN, NaN];
  assert.strictEqual(isSelectionInsideBbox([segment([[10, 20]])], bbox, nanProject), false);
});

test('no bbox means nothing is covered', () => {
  assert.strictEqual(isSelectionInsideBbox([segment([[10, 20]])], null, project), false);
});

test('pedestrian road types are excluded from house-number attachment', () => {
  // Ids from the SDK ROAD_TYPE constant. WALKWAY (9) is the one that was missing and
  // is the most common pedestrian geometry in Slovenian residential areas.
  for (const [id, name] of [[5, 'WALKING_TRAIL'], [9, 'WALKWAY'], [10, 'PEDESTRIAN_BOARDWALK'],
                            [16, 'STAIRWAY'], [18, 'RAILROAD'], [19, 'RUNWAY_TAXIWAY']]) {
    assert.ok(NON_ADDRESSABLE_ROAD_TYPES.has(id), `${name} (${id}) must be excluded`);
  }
  for (const [id, name] of [[1, 'STREET'], [2, 'PRIMARY_STREET'], [17, 'PRIVATE_ROAD']]) {
    assert.ok(!NON_ADDRESSABLE_ROAD_TYPES.has(id), `${name} (${id}) must remain addressable`);
  }
});
