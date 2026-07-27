'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyFetchFailure,
  decideFetchRetry,
  fetchRetryDelay
} = require('../wme-sl-hn-import.user.js');

// The policy the transport asks: retry this page, settle for what arrived, or give up.
// Defaults match a first attempt with a healthy budget and nothing collected yet.
function verdict(overrides) {
  return decideFetchRetry({
    retryable: true, attempt: 1, retriesUsed: 0, haveFeatures: false, ...overrides
  });
}

test('a timeout is worth another attempt', () => {
  const { retryable, reason } = classifyFetchFailure('timeout');
  assert.strictEqual(retryable, true);
  assert.strictEqual(reason, 'timed out');
});

test('a transport error is worth another attempt', () => {
  const { retryable, reason } = classifyFetchFailure('error');
  assert.strictEqual(retryable, true);
  assert.strictEqual(reason, 'request failed');
});

test('a server error is worth another attempt', () => {
  // 5xx is the server having a bad moment, which is the same class as a timeout.
  for (const status of [500, 502, 503, 504]) {
    const { retryable } = classifyFetchFailure('load', status);
    assert.strictEqual(retryable, true, `HTTP ${status}`);
  }
  assert.strictEqual(classifyFetchFailure('load', 503).reason, 'returned a server error');
});

test('a rejected query is not worth another attempt', () => {
  // Repeating a request the server refused cannot help, and would spend budget a
  // genuinely flaky page might need.
  for (const status of [400, 403, 404, 414]) {
    const { retryable } = classifyFetchFailure('load', status);
    assert.strictEqual(retryable, false, `HTTP ${status}`);
  }
  assert.strictEqual(
    classifyFetchFailure('load', 400).reason,
    'rejected the request (HTTP 400)',
    'the status is in the message, since this one needs reporting rather than retrying'
  );
});

test('an unreadable body is not worth another attempt', () => {
  // A 200 that will not parse, or parses without a features array.
  const { retryable, reason } = classifyFetchFailure('load', 200);
  assert.strictEqual(retryable, false);
  assert.strictEqual(reason, 'returned an unreadable response');
});

test('a failure with no status at all is treated as unreadable', () => {
  assert.deepStrictEqual(
    classifyFetchFailure('load'),
    { retryable: false, reason: 'returned an unreadable response' }
  );
});

test('a retryable first failure is retried', () => {
  assert.strictEqual(verdict({}), 'retry');
});

test('attempts are capped per page', () => {
  // Two retries: attempts 1 and 2 may be retried, the third is the last.
  assert.strictEqual(verdict({ attempt: 2 }), 'retry');
  assert.strictEqual(verdict({ attempt: 3 }), 'fail');
  assert.strictEqual(verdict({ attempt: 3, haveFeatures: true }), 'partial');
});

test('the per-load budget outranks the per-page allowance', () => {
  // The bound that matters: without it, every page of a 30-page load could retry to its
  // own limit and turn one click into a 47-minute wait.
  assert.strictEqual(verdict({ attempt: 1, retriesUsed: 4 }), 'fail');
  assert.strictEqual(verdict({ attempt: 1, retriesUsed: 4, haveFeatures: true }), 'partial');
  assert.strictEqual(verdict({ attempt: 1, retriesUsed: 3 }), 'retry', 'not yet spent');
});

test('a non-retryable failure stops immediately, whatever the budget', () => {
  assert.strictEqual(verdict({ retryable: false }), 'fail');
  assert.strictEqual(verdict({ retryable: false, haveFeatures: true }), 'partial');
});

test('pages already collected are kept rather than thrown away', () => {
  // The whole point of the partial verdict: one flaky page late in a long load used to
  // cost the user every page before it.
  assert.strictEqual(verdict({ attempt: 9, retriesUsed: 9, haveFeatures: true }), 'partial');
  assert.strictEqual(verdict({ attempt: 9, retriesUsed: 9, haveFeatures: false }), 'fail');
});

test('the backoff grows and then holds', () => {
  assert.strictEqual(fetchRetryDelay(1), 1000);
  assert.strictEqual(fetchRetryDelay(2), 3000);
  // Clamped, so the table may be shorter than the retry count without the later waits
  // collapsing to undefined.
  assert.strictEqual(fetchRetryDelay(3), 3000);
  assert.strictEqual(fetchRetryDelay(99), 3000);
});

test('a nonsense attempt number still yields a usable delay', () => {
  assert.strictEqual(fetchRetryDelay(0), 1000);
  assert.strictEqual(fetchRetryDelay(-5), 1000);
});
