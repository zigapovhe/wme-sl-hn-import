'use strict';

// Auto-load's decision table. This logic used to live inline in runAutoLoad, where
// none of it was reachable from a test: the startup harness stubs Editing.getSelection
// to null, so the guards below never got as far as returning an answer.
//
// 'drop' means forget this selection change entirely; 'defer' means re-arm and ask
// again once the self-selection window closes.

const test = require('node:test');
const assert = require('node:assert');

const { decideAutoLoad } = require('../wme-sl-hn-import.user.js');

// A genuine, uncovered selection with nothing suppressing it: the case that must load.
const BASE = {
  enabled: true,
  isLoading: false,
  dialogOpen: false,
  selectedIds: ['s1'],
  selfSelectionIds: null,
  now: 10_000,
  suppressUntil: 0,
  selectionCovered: false
};

const decide = (over) => decideAutoLoad({ ...BASE, ...over });

test('a genuine selection outside the fetched area loads', () => {
  assert.strictEqual(decide({}), 'load');
});

test('the off switch and an in-flight load both win over everything', () => {
  assert.strictEqual(decide({ enabled: false }), 'drop');
  assert.strictEqual(decide({ isLoading: true }), 'drop');
});

test('an empty selection drops', () => {
  assert.strictEqual(decide({ selectedIds: [] }), 'drop');
});

test('an already-fetched area drops', () => {
  assert.strictEqual(decide({ selectionCovered: true }), 'drop');
});

test('the script selecting segments itself never triggers a load', () => {
  // The regression this guards: markSelfSelection only opened a 2-second window, and
  // runAutoLoad *deferred* past it rather than dropping. Our own setSelection therefore
  // came back around ~2s later and loaded against the selection the script had made —
  // wiping the fix-street dialog or the audit findings the user was inspecting.
  assert.strictEqual(
    decide({ selectedIds: ['s1', 's2'], selfSelectionIds: ['s1', 's2'], now: 0, suppressUntil: 2000 }),
    'drop'
  );
  // Still ours once the window has expired — time is not what makes it genuine.
  assert.strictEqual(
    decide({ selectedIds: ['s1', 's2'], selfSelectionIds: ['s1', 's2'], now: 9_999_999 }),
    'drop'
  );
});

test('self-selection is compared as a set, not by order or type', () => {
  assert.strictEqual(decide({ selectedIds: ['b', 'a'], selfSelectionIds: ['a', 'b'] }), 'drop');
  assert.strictEqual(decide({ selectedIds: [1, 2], selfSelectionIds: ['1', '2'] }), 'drop');
  // A subset is a different selection: the user deselected one of ours.
  assert.strictEqual(decide({ selectedIds: ['a'], selfSelectionIds: ['a', 'b'] }), 'load');
});

test('a genuine selection during the suppression window defers rather than drops', () => {
  // Every house-number add calls markSelfSelection. Dropping outright here meant
  // click-add-move-on work suppressed auto-load indefinitely.
  assert.strictEqual(
    decide({ selectedIds: ['other'], selfSelectionIds: ['s1'], now: 0, suppressUntil: 2000 }),
    'defer'
  );
  assert.strictEqual(
    decide({ selectedIds: ['other'], selfSelectionIds: ['s1'], now: 2001, suppressUntil: 2000 }),
    'load'
  );
});

test('the self-selection marker is consumed, not permanent', () => {
  // The runtime clears the marker once it has seen the event its own setSelection
  // raised. Without that, the user deliberately re-selecting that same segment later —
  // clicking the one an audit marker just centred on — would be dropped as "ours"
  // forever, and auto-load would look broken for exactly that street.
  assert.strictEqual(decide({ selectedIds: ['s1'], selfSelectionIds: null }), 'load');
});

test('nothing loads while the fix-street dialog is open', () => {
  // The dialog renames whatever is selected NOW and its own text tells the user to
  // adjust the selection on the map. That adjustment is a genuine selection change, so
  // no suppression window covers it — and loading calls clearFixStreetState, which
  // takes the dialog away mid-decision.
  assert.strictEqual(decide({ dialogOpen: true }), 'drop');
  // Including after the user has adjusted our selection, which is the real-world path.
  assert.strictEqual(
    decide({ dialogOpen: true, selectedIds: ['s9'], selfSelectionIds: ['s1', 's2'] }),
    'drop'
  );
  // And it must not merely defer: a deferred run fires 2s later, dialog still open.
  assert.notStrictEqual(
    decide({ dialogOpen: true, now: 0, suppressUntil: 2000, selectedIds: ['s9'] }),
    'defer'
  );
});
