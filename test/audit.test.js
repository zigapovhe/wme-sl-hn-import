'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  computeAuditFindings,
  findWrongStreetPairs,
  AUDIT_MAX_DISTANCE,
  MAX_HN_CONFLICT_DISTANCE
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

// One audit finding as computeAuditFindings emits it.
function auditFinding({ number, streetKeys, eX, eY, type = 'missing', hnId = '1', segmentId = 500 }) {
  return {
    hnId, number, segmentId, streetKeys, type,
    lon: 14 + eX / 100000, lat: 46 + eY / 100000,
    eX, eY
  };
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

test('house numbers within AUDIT_MAX_DISTANCE of the bbox edge are not judged', () => {
  // The eProstor query used exactly this box, so a pin near the edge can legitimately
  // match a point just outside it that was never returned. Judging that band reports
  // valid addresses as missing. An earlier version of this test asserted the opposite
  // and so pinned the bug in place.
  for (const [x, y, where] of [
    [BBOX.maxE, BBOX.maxN, 'exactly on the corner'],
    [BBOX.minE, BBOX.minN, 'exactly on the opposite corner'],
    [BBOX.maxE - 5, 500, 'just inside the east edge'],
    [BBOX.minE + 5, 500, 'just inside the west edge'],
    [500, BBOX.maxN - 5, 'just inside the north edge'],
    [500, BBOX.minN + 5, 'just inside the south edge']
  ]) {
    const findings = computeAuditFindings(
      [official('main_st', '12', 100, 100)],
      wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '99', x, y })] }),
      BBOX
    );
    assert.deepStrictEqual(findings, [], `should not judge a pin ${where}`);
  }
});

test('house numbers comfortably inside the bbox are judged', () => {
  const inset = AUDIT_MAX_DISTANCE + 1;
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '99', x: BBOX.minE + inset, y: BBOX.minN + inset })] }),
    BBOX
  );
  assert.strictEqual(findings.length, 1, 'just past the inset should still be audited');
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

test('a finding carries the projected coordinates the wrong-street pairing needs', () => {
  // Without these the pairing silently matches nothing, and every other test still passes.
  const findings = computeAuditFindings(
    [official('main_st', '12', 100, 100)],
    wmeIndex({ main_st: [wmeHn({ hnId: '1', num: '99', x: 250, y: 400 })] }),
    BBOX
  );
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].eX, 250);
  assert.strictEqual(findings[0].eY, 400);
});

test('an unmatched address pairs with a same-numbered house number on another street', () => {
  const feature = official('ulica_a', '5', 100, 100);
  const finding = auditFinding({ number: '5', streetKeys: ['ulica_b'], eX: 104, eY: 100 });
  const pairs = findWrongStreetPairs([feature], [finding]);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].feature, feature, 'pairs reference the inputs, not copies');
  assert.strictEqual(pairs[0].finding, finding);
  assert.strictEqual(pairs[0].distance, 4);
});

test('a house number beyond the conflict radius is not the same address', () => {
  const pairs = findWrongStreetPairs(
    [official('ulica_a', '5', 100, 100)],
    [auditFinding({
      number: '5', streetKeys: ['ulica_b'],
      eX: 100, eY: 100 + MAX_HN_CONFLICT_DISTANCE + 0.5
    })]
  );
  assert.deepStrictEqual(pairs, []);
});

test('exactly at the conflict radius still pairs', () => {
  const pairs = findWrongStreetPairs(
    [official('ulica_a', '5', 100, 100)],
    [auditFinding({
      number: '5', streetKeys: ['ulica_b'],
      eX: 100, eY: 100 + MAX_HN_CONFLICT_DISTANCE
    })]
  );
  assert.strictEqual(pairs.length, 1, 'inclusive, like the audit threshold');
});

test('an address already in WME is not waiting for anything', () => {
  const pairs = findWrongStreetPairs(
    [{ ...official('ulica_a', '5', 100, 100), processed: true }],
    [auditFinding({ number: '5', streetKeys: ['ulica_b'], eX: 104, eY: 100 })]
  );
  assert.deepStrictEqual(pairs, []);
});

test('a misplaced finding is a different diagnosis and does not pair', () => {
  const pairs = findWrongStreetPairs(
    [official('ulica_a', '5', 100, 100)],
    [auditFinding({ number: '5', streetKeys: ['ulica_b'], eX: 104, eY: 100, type: 'misplaced' })]
  );
  assert.deepStrictEqual(pairs, []);
});

test('a shared street name means the audit already judged it', () => {
  const pairs = findWrongStreetPairs(
    [official('ulica_a', '5', 100, 100)],
    [auditFinding({ number: '5', streetKeys: ['ulica_a', 'ulica_b'], eX: 104, eY: 100 })]
  );
  assert.deepStrictEqual(pairs, []);
});

test('a different number nearby is somebody else problem', () => {
  const pairs = findWrongStreetPairs(
    [official('ulica_a', '5', 100, 100)],
    [auditFinding({ number: '6', streetKeys: ['ulica_b'], eX: 104, eY: 100 })]
  );
  assert.deepStrictEqual(pairs, []);
});

test('one house number reddens only the nearest of two candidate addresses', () => {
  // Input order deliberately puts the farther one first, so passing proves the sort ran.
  const near = official('ulica_a', '5', 100, 100);
  const far = official('ulica_c', '5', 106, 100);
  const finding = auditFinding({ number: '5', streetKeys: ['ulica_b'], eX: 102, eY: 100 });
  const pairs = findWrongStreetPairs([far, near], [finding]);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].feature, near);
});

test('one address pairs with only one house number', () => {
  const feature = official('ulica_a', '5', 100, 100);
  const closer = auditFinding({ number: '5', streetKeys: ['ulica_b'], eX: 102, eY: 100, hnId: 'A' });
  const farther = auditFinding({ number: '5', streetKeys: ['ulica_c'], eX: 104, eY: 100, hnId: 'B' });
  const pairs = findWrongStreetPairs([feature], [farther, closer]);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].finding, closer);
});

test('empty and missing inputs pair nothing', () => {
  const feature = official('ulica_a', '5', 100, 100);
  const finding = auditFinding({ number: '5', streetKeys: ['ulica_b'], eX: 104, eY: 100 });
  assert.deepStrictEqual(findWrongStreetPairs([], []), []);
  assert.deepStrictEqual(findWrongStreetPairs(null, [finding]), []);
  assert.deepStrictEqual(findWrongStreetPairs([feature], null), []);
  assert.deepStrictEqual(findWrongStreetPairs([feature], []), []);
});

test('a legitimate same-numbered address on the next street does not redden anything', () => {
  // eProstor has both A 5 and B 5, 15 m apart at a corner. WME has one house number: 5,
  // correctly on B. A 5 is genuinely missing and must stay addable. No false red here
  // because the audit matches the house number to its own street, so it never emits a
  // finding for findWrongStreetPairs to pair with — the corner case resolves before the
  // pairing rule even runs, not because of anything in the pairing rule itself.
  const features = [official('ulica_a', '5', 100, 100), official('ulica_b', '5', 100, 115)];
  const findings = computeAuditFindings(
    features,
    wmeIndex({ ulica_b: [wmeHn({ hnId: '1', num: '5', x: 100, y: 115 })] }),
    BBOX
  );
  assert.deepStrictEqual(findings, [], 'the house number matches its own street');
  assert.deepStrictEqual(findWrongStreetPairs(features, findings), []);
});

test('end to end: a house number on the wrong street becomes a pair', () => {
  // eProstor must carry *something* on the wrong street, or the audit never judges it.
  const features = [official('ulica_a', '5', 100, 100), official('ulica_b', '7', 100, 200)];
  const findings = computeAuditFindings(
    features,
    wmeIndex({ ulica_b: [wmeHn({ hnId: '9', num: '5', x: 100, y: 104, segmentId: 777 })] }),
    BBOX
  );
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].type, 'missing');

  const pairs = findWrongStreetPairs(features, findings);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].feature, features[0]);
  assert.strictEqual(pairs[0].finding.segmentId, 777);
});

test('a wrong street absent from the loaded data cannot be detected', () => {
  // A stated limitation, kept honest: the audit only judges streets eProstor answered
  // for, so there is no finding to pair and the circle stays plainly addable.
  const features = [official('ulica_a', '5', 100, 100)];
  const findings = computeAuditFindings(
    features,
    wmeIndex({ ulica_b: [wmeHn({ hnId: '1', num: '5', x: 100, y: 104 })] }),
    BBOX
  );
  assert.deepStrictEqual(findings, []);
  assert.deepStrictEqual(findWrongStreetPairs(features, findings), []);
});
