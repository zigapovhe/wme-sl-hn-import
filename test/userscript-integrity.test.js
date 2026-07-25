'use strict';

// These tests protect the thing the test suite could plausibly break: the script
// must still run as a userscript. They assert on the file's text, because the
// Tampermonkey entry path is deliberately not executed under Node.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'wme-sl-hn-import.user.js');
const source = fs.readFileSync(SCRIPT_PATH, 'utf8');

test('the userscript metadata block is intact', () => {
  assert.match(source, /^\/\/ ==UserScript==/, 'must start with the metadata block');
  assert.match(source, /\/\/ ==\/UserScript==/);
  for (const key of ['@name', '@version', '@match', '@grant', '@require']) {
    assert.ok(source.includes(key), `metadata must still declare ${key}`);
  }
});

test('the version is a plain semver string Tampermonkey can compare', () => {
  const m = source.match(/^\/\/ @version\s+(.+)$/m);
  assert.ok(m, '@version must be present');
  assert.match(m[1].trim(), /^\d+\.\d+\.\d+$/);
});

test('the WME entry point is still wired up', () => {
  // If this disappears the script silently does nothing in the browser.
  assert.match(source, /SDK_INITIALIZED/);
  assert.match(source, /getWmeSdk\(/);
});

test('the entry point is gated on a browser check, not on absence of Node', () => {
  // Intent, not exact text: the gate must key off unsafeWindow/window (always
  // present in Tampermonkey) rather than something like `typeof module ===
  // 'undefined'`, which bundlers can make false.
  assert.match(source, /IN_USERSCRIPT_ENV/);
  assert.match(source, /typeof unsafeWindow !== 'undefined'/);
  assert.ok(
    !/if \(typeof module === 'undefined'\)/.test(source),
    'must not gate startup on the absence of a module system'
  );
});

test('requiring the script produces no side effects beyond exports', () => {
  // A fresh require must not throw and must not define browser globals.
  delete require.cache[require.resolve(SCRIPT_PATH)];
  const exported = require(SCRIPT_PATH);
  assert.strictEqual(typeof exported.computeAuditFindings, 'function');
  assert.strictEqual(typeof globalThis.window, 'undefined', 'must not create a window global');
  assert.strictEqual(typeof globalThis.wmeSDK, 'undefined', 'must not leak wmeSDK');
});

test('module is only touched behind a typeof guard', () => {
  // Load-bearing for Tampermonkey: `module` is undefined there, so an unguarded
  // `module.exports =` would throw at startup and kill the whole script.
  assert.ok(source.includes('module.exports'), 'the test surface should exist');
  assert.match(source, /typeof module !== 'undefined'/);
});

test('only pure functions are exported', () => {
  const exported = require(SCRIPT_PATH);
  const allowed = new Set([
    'normalizeHN', 'buildHouseNumber', 'normalizeStreetName', 'buildCqlFilter',
    'hasConflict', 'computeAuditFindings', 'computeFetchBbox',
    'AUDIT_MAX_DISTANCE', 'MAX_HN_CONFLICT_DISTANCE'
  ]);
  for (const key of Object.keys(exported)) {
    assert.ok(allowed.has(key), `unexpected export "${key}" — keep SDK/DOM code private`);
  }
});
