'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  computeAuditFindings,
  AUDIT_MAX_DISTANCE
} = require('../wme-sl-hn-import.user.js');

// Coordinates are EPSG:3794 metres, so distances in these fixtures are literal.
const BBOX = { minE: 0, minN: 0, maxE: 1000, maxN: 1000 };

// One eProstor address point.
function official(street, number, eX, eY) {
  return { street, number, eX, eY, lon: 14 + eX / 100000, lat: 46 + eY / 100000 };
}

// A WME-side index as getVisibleHNsByStreet builds it: street key -> { items }.
// `streets` maps a street key to the house numbers indexed under it.
function wmeIndex(streets) {
  const map = new Map();
  for (const [streetKey, items] of Object.entries(streets)) {
    map.set(streetKey, { set: new Set(items.map(i => i.num)), items });
  }
  return map;
}

function wmeHn({ hnId, num, x, y, segmentId = 500 }) {
  return { hnId, num, x, y, segmentId, lon: 14 + x / 100000, lat: 46 + y / 100000 };
}

test('a house number matching eProstor in number and position is not flagged', () => {
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '12', x: 100, y: 100 })] }),
    BBOX
  );
  assert.deepStrictEqual(findings, []);
});

test('a number absent from that street is flagged missing', () => {
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '99', x: 100, y: 100 })] }),
    BBOX
  );
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].type, 'missing');
  assert.strictEqual(findings[0].number, '99');
  assert.strictEqual(findings[0].hnId, '1');
});

test('a number that exists but sits too far away is flagged misplaced, not missing', () => {
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '12', x: 100, y: 100 + AUDIT_MAX_DISTANCE + 5 })] }),
    BBOX
  );
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].type, 'misplaced');
});

test('the distance threshold is inclusive at exactly AUDIT_MAX_DISTANCE', () => {
  const atLimit = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '12', x: 100, y: 100 + AUDIT_MAX_DISTANCE })] }),
    BBOX
  );
  assert.deepStrictEqual(atLimit, [], 'exactly at the threshold counts as matched');

  const justOver = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '12', x: 100, y: 100 + AUDIT_MAX_DISTANCE + 0.5 })] }),
    BBOX
  );
  assert.strictEqual(justOver.length, 1);
  assert.strictEqual(justOver[0].type, 'misplaced');
});

test('whitespace differences do not produce false findings', () => {
  // Regression: eProstor "12a" vs an editor typing "12 a".
  const findings = computeAuditFindings(
    [official('main_st', '12a', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '12a', x: 100, y: 100 })] }),
    BBOX
  );
  assert.deepStrictEqual(findings, []);
});

test('a house number matched under any of its street names is not flagged', () => {
  // Dual-named segments index the same HN under primary AND alternate names.
  // Matching under either must be enough, or every such segment is a false positive.
  const sameHn = wmeHn({ hnId: '1', num: '12', x: 100, y: 100 });
  const findings = computeAuditFindings(
    [official('alt_st', '12', 100, 100)],
    wmeIndex({ primary_st: [sameHn], alt_st: [sameHn] }),
    BBOX
  );
  assert.deepStrictEqual(findings, []);
});

test('a dual-named house number is reported once, not once per name', () => {
  const sameHn = wmeHn({ hnId: '1', num: '99', x: 100, y: 100 });
  const findings = computeAuditFindings(
    [official('primary_st', '12', 100, 100), official('alt_st', '12', 100, 100)],
    wmeIndex({ primary_st: [sameHn], alt_st: [sameHn] }),
    BBOX
  );
  assert.strictEqual(findings.length, 1);
});

test('streets absent from eProstor are skipped, never flagged', () => {
  // We have no reference data for that street, so we cannot claim anything.
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ unknown_st: [wmeHn({ hnId: '1', num: '5', x: 100, y: 100 })] }),
    BBOX
  );
  assert.deepStrictEqual(findings, []);
});

test('house numbers outside the fetched bbox are not flagged', () => {
  // The bug this guards: panning re-audits with a viewport-scoped WME set while
  // the eProstor set stays frozen to the fetched bbox, which mass-flagged valid
  // house numbers as missing.
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '99', x: 5000, y: 5000 })] }),
    BBOX
  );
  assert.deepStrictEqual(findings, []);
});

test('a house number exactly on the bbox edge is still audited', () => {
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '99', x: BBOX.maxE, y: BBOX.maxN })] }),
    BBOX
  );
  assert.strictEqual(findings.length, 1);
});

test('house numbers without an id are skipped rather than merged', () => {
  // Regression: String(undefined) is the truthy string "undefined", which
  // collapsed every id-less house number into one finding with a colliding id.
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({
      main_st: [
        wmeHn({ hnId: null, num: '97', x: 100, y: 100 }),
        wmeHn({ hnId: null, num: '98', x: 200, y: 200 })
      ]
    }),
    BBOX
  );
  assert.deepStrictEqual(findings, []);
});

test('findings carry what the UI needs to render and act', () => {
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '42', num: '99', x: 100, y: 100, segmentId: 777 })] }),
    BBOX
  );
  const f = findings[0];
  assert.strictEqual(f.segmentId, 777, 'needed to select the owning segment');
  assert.ok(Number.isFinite(f.lon) && Number.isFinite(f.lat), 'needed to place the marker');
  assert.deepStrictEqual(f.streetKeys, ['main_st'], 'needed for the selected-street filter');
});

test('no findings without a loaded bbox', () => {
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '99', x: 100, y: 100 })] }),
    null
  );
  assert.deepStrictEqual(findings, []);
});

test('no findings without eProstor data', () => {
  const index = wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '99', x: 100, y: 100 })] });
  assert.deepStrictEqual(computeAuditFindings([], index, BBOX), []);
  assert.deepStrictEqual(computeAuditFindings(null, index, BBOX), []);
});

test('empty or missing WME index yields no findings', () => {
  const features = [official('main_st', '12', 100, 100)];
  assert.deepStrictEqual(computeAuditFindings(features, new Map(), BBOX), []);
  assert.deepStrictEqual(computeAuditFindings(features, null, BBOX), []);
});

test('several unmatched house numbers each produce their own finding', () => {
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({
      main_st: [
        wmeHn({ hnId: '1', num: '97', x: 100, y: 100 }),
        wmeHn({ hnId: '2', num: '98', x: 150, y: 150 }),
        wmeHn({ hnId: '3', num: '12', x: 100, y: 100 })
      ]
    }),
    BBOX
  );
  assert.strictEqual(findings.length, 2);
  assert.deepStrictEqual(findings.map(f => f.number).sort(), ['97', '98']);
});
