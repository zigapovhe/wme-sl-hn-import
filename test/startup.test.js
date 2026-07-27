'use strict';

// Boots the whole userscript against stubbed browser/WME globals. This is the only
// test that executes init(), which is where most of the file lives — it catches
// undefined identifiers and broken wiring, the class of mistake `node --check`
// cannot see.
//
// What it covers: layer creation, overlay visibility gating, every registered event
// handler (updateLayerVisibility, onSelectionChanged, maybeAutoLoad), and auto-load's
// fetch dedup end to end — the decision itself is unit-tested in autoload.test.js, but
// only a boot can show that the runtime feeds it the right state.
//
// What it does NOT cover, verified by mutation testing:
//   - the render paths (applyFeatureFilter / renderAuditFindings). Nothing here loads
//     address data, so they never run; a typo there is also swallowed by their
//     error-isolation try/catch, so it degrades silently rather than throwing.
//   - redundant-work regressions, e.g. dropping the `shown` change-guard. That makes
//     extra SDK calls without throwing.
//   - auto-load's fix-street and self-selection guards. Both need the dialog open,
//     which needs loaded address data and a map click on a circle.
// Those still need a pass in the real editor.
//
// If you hit a failure here after adding a browser or SDK call these stubs don't
// provide, the test fails on the missing stub, not on a real bug — add the stub below.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'wme-sl-hn-import.user.js');

// storage: localStorage contents to boot with. Defaults to empty, i.e. a first-run
// install with every overlay off.
// whileStubbed: optional callback run after boot but *before* the stubs are removed.
// Anything that calls back into the script (firing an event handler, for instance)
// must go here — the script reads globals like localStorage at call time.
// options.selection: what Editing.getSelection returns (default null, i.e. nothing
// selected). options.segments: id -> segment object handed back by Segments.getById.
async function bootScript(storage = {}, whileStubbed = null, options = {}) {
  const calls = [];
  const layers = new Map();
  const requests = []; // every GM_xmlhttpRequest the script issued

  // Click handlers registered on panel elements, so tests can fire them. Without
  // this, every checkbox and button handler is dead code as far as the suite is
  // concerned — which is how a `ReferenceError` in the NavPoints toggle once shipped.
  const domHandlers = [];

  const element = () => new Proxy(function () {}, {
    get: (t, k) => {
      if (k === 'style') return {};
      if (k === 'classList') return { add() {}, remove() {}, toggle() {} };
      if (k === 'querySelector' || k === 'closest') return () => element();
      if (k === 'querySelectorAll') return () => [];
      if (k === 'hasAttribute') return () => false;
      if (k === 'addEventListener') return (type, handler) => domHandlers.push({ type, handler });
      if (k === 'innerHTML' || k === 'textContent' || k === 'value') return '';
      return element();
    },
    set: () => true,
    apply: () => element()
  });

  const handlers = new Map(); // eventName -> [handler], so tests can fire them

  function handleSdkCall(name, arg) {
    calls.push(name);
    switch (name) {
      case 'Events.on':
        if (!handlers.has(arg.eventName)) handlers.set(arg.eventName, []);
        handlers.get(arg.eventName).push(arg.eventHandler);
        return undefined;
      case 'Map.addLayer':
        // visible starts undefined, NOT false. Seeding false made "starts hidden"
        // assertions pass even if the script never hid anything — the test could not
        // tell "explicitly hidden" from "never touched".
        // styleContext is kept because only the SDK's renderer ever calls those
        // functions, so nothing else here would execute them.
        layers.set(arg.layerName, {
          visible: undefined,
          features: [],
          styleContext: arg.styleContext,
          styleRules: arg.styleRules
        });
        return undefined;
      case 'Map.setLayerVisibility':
        if (layers.has(arg.layerName)) layers.get(arg.layerName).visible = arg.visibility;
        return undefined;
      case 'Map.addFeaturesToLayer':
        if (layers.has(arg.layerName)) layers.get(arg.layerName).features = arg.features;
        return undefined;
      case 'Map.removeFeaturesFromLayer':
        if (layers.has(arg.layerName)) layers.get(arg.layerName).features = [];
        return undefined;
      case 'Map.getZoomLevel': return 19;
      case 'Map.getMapExtent': return [14, 46, 15, 47];
      case 'Map.getMapPixelFromLonLat': return { x: 0, y: 0 };
      case 'Editing.getSelection': return options.selection || null;
      case 'DataModel.Segments.getById':
        return (options.segments || {})[arg && arg.segmentId] || undefined;
      case 'Events.once': return Promise.resolve();
      case 'Sidebar.registerScriptTab':
        return Promise.resolve({ tabLabel: element(), tabPane: element() });
      case 'DataModel.HouseNumbers.fetchHouseNumbers': return Promise.resolve([]);
      default:
        return name.endsWith('getAll') ? [] : undefined;
    }
  }

  // Callable at any depth, so DataModel.Segments.getAll() resolves like the real SDK.
  const deepStub = (segments) => new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : deepStub(segments.concat(String(k)))),
    apply: (t, self, args) => handleSdkCall(segments.join('.'), args[0])
  });

  const saved = {};
  const globals = {
    window: { location: { href: 'https://www.waze.com/editor' }, SDK_INITIALIZED: Promise.resolve() },
    document: {
      createElement: () => element(), createTextNode: () => element(),
      getElementById: () => element(), querySelector: () => element(),
      querySelectorAll: () => [], addEventListener() {}, body: element(), head: element()
    },
    getWmeSdk: () => deepStub([]),
    I18n: { translations: { en: { layers: { name: {} } } }, currentLocale: () => 'en' },
    proj4: Object.assign((from, to, c) => [c[0] * 1000, c[1] * 1000], { defs: () => {} }),
    // Needed by the toast renderer. Without it every toast fails inside its own
    // try/catch, so that path would look exercised while never actually running.
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    // Fails every request, on purpose: the interesting question for auto-load is what
    // it does *after* a fetch it could not use.
    //
    // The failure is non-retryable by default — a rejected query, which is what a real
    // non-2xx looks like: an HTML error page where JSON was expected. A retryable failure
    // here would arm the retry backoff in every test that fetches, and those timers fire
    // seconds later, long after the drain below has put the stubs back.
    // options.fetchFailure = 'timeout-then-ok' opts into the retry path instead: the first
    // attempt times out, the next succeeds.
    GM_xmlhttpRequest(req) {
      requests.push(req);
      const attempt = requests.length;
      setTimeout(() => {
        if (options.fetchFailure === 'timeout-then-ok') {
          if (attempt === 1) { req.ontimeout && req.ontimeout(); return; }
          req.onload && req.onload({
            status: 200,
            responseText: JSON.stringify({ features: [], numberReturned: 0, numberMatched: 0 })
          });
          return;
        }
        req.onload && req.onload({ status: 400, responseText: '<html>Bad Request</html>' });
      }, 0);
    },
    GM_setClipboard() {},
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem() {}
    }
  };
  globals.unsafeWindow = globals.window;
  globals.proj4.defs['EPSG:3794'] = true;

  for (const [k, v] of Object.entries(globals)) { saved[k] = global[k]; global[k] = v; }
  try {
    // The script body only defines things; layer creation and panel wiring happen in
    // promise callbacks off SDK_INITIALIZED, so the stubs must stay installed until
    // the microtask queue drains.
    new Function('module', fs.readFileSync(SCRIPT_PATH, 'utf8'))({});
    await new Promise(resolve => setTimeout(resolve, 50));
    if (whileStubbed) {
      await whileStubbed({ calls, layers, handlers, domHandlers, requests });
      // Firing handlers arms timers (NavPoints debounces renders by 300 ms, auto-load
      // by 400 ms). Drain them BEFORE removing the stubs, or they fire against
      // torn-down globals and throw a TypeError that nothing surfaces. Only needed on
      // this path — a plain boot arms nothing.
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    for (const k of Object.keys(globals)) global[k] = saved[k];
  }
  return { calls, layers, handlers, domHandlers, requests };
}

test('the script boots without throwing', async () => {
  await assert.doesNotReject(bootScript);
});

test('startup creates every overlay layer', async () => {
  const { layers } = await bootScript();
  // qhnsl-navpoints included deliberately: NavPoints lives outside init(), and this
  // asserts that wiring survives.
  for (const name of ['qhnsl-sdk', 'qhnsl-streetnames', 'qhnsl-audit', 'qhnsl-navpoints']) {
    assert.ok(layers.has(name), `expected layer ${name} to be created`);
  }
});

test('on a fresh install the registry overlays are explicitly hidden', async () => {
  const { layers } = await bootScript();
  // Explicitly false, not merely "not true": the script must actively hide these, so
  // nothing shows before a load. NavPoints is excluded on purpose — it never calls
  // setLayerVisibility at creation and stays an empty layer until enabled.
  for (const name of ['qhnsl-sdk', 'qhnsl-streetnames', 'qhnsl-audit']) {
    assert.strictEqual(layers.get(name).visible, false, `${name} must be explicitly hidden`);
  }
});

test('a persisted visible layer is shown at startup', async () => {
  // Also the only path that runs updateLayerVisibility during boot, so it covers the
  // overlay registry's visibility loop.
  const { layers } = await bootScript({ 'qhnsl-layer-visible': '1' });
  assert.strictEqual(layers.get('qhnsl-sdk').visible, true);
});

test('street names ride the base gate and default on', async () => {
  const { layers } = await bootScript({ 'qhnsl-layer-visible': '1' });
  assert.strictEqual(layers.get('qhnsl-streetnames').visible, true, 'default on with base visible');

  const off = await bootScript({ 'qhnsl-layer-visible': '1', 'qhnsl-street-names': '0' });
  assert.strictEqual(off.layers.get('qhnsl-streetnames').visible, false, 'respects its own toggle');

  const noBase = await bootScript({ 'qhnsl-street-names': '1' });
  assert.strictEqual(noBase.layers.get('qhnsl-streetnames').visible, false,
    'never visible while the base layer is hidden');
});

test('the audit layer follows its own toggle, default off', async () => {
  const off = await bootScript({ 'qhnsl-layer-visible': '1' });
  assert.strictEqual(off.layers.get('qhnsl-audit').visible, false, 'off by default');

  const on = await bootScript({ 'qhnsl-layer-visible': '1', 'qhnsl-audit': '1' });
  assert.strictEqual(on.layers.get('qhnsl-audit').visible, true);
});

test('startup registers map and selection event handlers', async () => {
  const { handlers } = await bootScript();
  for (const evt of ['wme-map-zoom-changed', 'wme-map-move-end', 'wme-selection-changed']) {
    assert.ok(handlers.has(evt), `expected a handler for ${evt}`);
  }
});

test('firing every registered handler throws nothing', async () => {
  // This is the test that actually exercises updateLayerVisibility, onSelectionChanged
  // and maybeAutoLoad. Without it, a typo in any of them passes unnoticed: the script
  // body only *defines* those functions, so booting alone never calls them.
  await bootScript({ 'qhnsl-layer-visible': '1', 'qhnsl-audit': '1' }, ({ handlers }) => {
    for (const [eventName, list] of handlers) {
      for (const handler of list) {
        assert.doesNotThrow(() => handler({ x: 0, y: 0 }), `handler for ${eventName} threw`);
      }
    }
  });
});

test('auto-load enabled: selection handlers run without throwing', async () => {
  // maybeAutoLoad's body was dead under test because no fixture enabled it, so its
  // guards (coverage check, self-selection deferral) were never executed here.
  await bootScript(
    { 'qhnsl-layer-visible': '1', 'qhnsl-autoload': '1' },
    ({ handlers }) => {
      for (const handler of handlers.get('wme-selection-changed') || []) {
        assert.doesNotThrow(() => handler({}), 'a selection handler threw with auto-load on');
      }
    }
  );
});

test('audit markers are drawn larger than the house-number circles', async () => {
  // The reason the audit markers were reported as barely visible: they were a fixed 11
  // px while the circles around them size to their label, 12 px and up. A marker
  // smaller than its neighbours reads as background, and — since handleMapClick picks
  // the nearest centre — is harder to hit as well.
  //
  // Asserts the relationship, not the constants, so the margin can be tuned freely.
  // Also the only test that executes the style-context functions at all: the SDK's
  // renderer is their only caller in the browser, so a typo in one is otherwise
  // invisible here and degrades silently in WME.
  const { layers } = await bootScript();
  const audit = layers.get('qhnsl-audit').styleContext;
  const hn = layers.get('qhnsl-sdk').styleContext;
  assert.ok(audit && hn, 'both layers should expose a styleContext');

  for (const number of ['4', '12', '12a', '137b']) {
    const feature = { properties: { number, type: 'missing' } };
    const auditR = audit.getAuditRadius({ feature });
    const hnR = hn.getRadius({ feature });
    assert.ok(Number.isFinite(auditR), `audit radius for "${number}" should be a number`);
    assert.ok(auditR > hnR,
      `audit marker for "${number}" must be bigger than the circle (${auditR} vs ${hnR})`);
  }

  // Both variants must stay visible in their own right: the hollow one was a 0.15
  // opacity fill, which is what made it vanish against the basemap.
  const misplaced = { properties: { number: '12', type: 'misplaced' } };
  assert.ok(audit.getAuditFillOpacity({ feature: misplaced }) >= 0.5,
    'the misplaced fill must be opaque enough to read against the basemap');
});

test('a failed auto-load is not retried on the next selection change', () => {
  // decideAutoLoad's dedup is unit-tested; what this covers is the wiring, which the
  // pure test cannot see: that the runtime keys on the box we *asked* for rather than
  // the box eProstor answered for. Keyed on the latter, a failed fetch left "nothing
  // loaded" behind and every further selection change refired the whole paginated
  // request chain at a service that had just failed.
  const segment = {
    id: 's1',
    geometry: { coordinates: [[14.5, 46.05], [14.501, 46.051]] },
    primaryStreetId: null,
    alternateStreetIds: []
  };
  return bootScript(
    { 'qhnsl-layer-visible': '1', 'qhnsl-autoload': '1' },
    async ({ handlers, requests }) => {
      const fire = async () => {
        for (const h of handlers.get('wme-selection-changed') || []) h({});
        await new Promise(r => setTimeout(r, 600)); // past the 400 ms auto-load debounce
      };

      await fire();
      assert.strictEqual(requests.length, 1, 'the first selection should fetch once');

      await fire();
      assert.strictEqual(requests.length, 1,
        'the same area must not be re-fetched after its fetch failed');
    },
    { selection: { objectType: 'segment', ids: ['s1'] }, segments: { s1: segment } }
  );
});

test('a timed-out page is re-issued rather than losing the load', () => {
  // decideFetchRetry decides the policy and is unit-tested; what this covers is the
  // wiring the pure test cannot see — that a timeout actually re-issues the request, at
  // the SAME startIndex, and that the load then completes instead of rejecting.
  const segment = {
    id: 's1',
    geometry: { coordinates: [[14.5, 46.05], [14.501, 46.051]] },
    primaryStreetId: null,
    alternateStreetIds: []
  };
  return bootScript(
    { 'qhnsl-layer-visible': '1', 'qhnsl-autoload': '1' },
    async ({ handlers, requests }) => {
      for (const h of handlers.get('wme-selection-changed') || []) h({});
      await new Promise(r => setTimeout(r, 600)); // past the 400 ms auto-load debounce
      assert.strictEqual(requests.length, 1, 'the first attempt goes out');

      // Polled rather than slept: the retry lands one backoff after the failure, which is
      // itself one debounce after this handler fired, and a fixed sleep that has to cover
      // both is either flaky or needlessly slow.
      const deadline = Date.now() + 2000;
      while (requests.length < 2 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      assert.strictEqual(requests.length, 2, 'the timed-out page is re-issued');
      assert.strictEqual(requests[1].url, requests[0].url,
        'at the same startIndex — a retry that moved on would skip a page');
    },
    {
      selection: { objectType: 'segment', ids: ['s1'] },
      segments: { s1: segment },
      fetchFailure: 'timeout-then-ok'
    }
  );
});

test('every panel click handler runs without throwing', () => {
  // Fires each checkbox/button handler the panel registered. This is what catches a
  // helper that moved out of scope: the handler bodies are never otherwise executed.
  return bootScript({ 'qhnsl-layer-visible': '1', 'qhnsl-audit': '1' }, ({ domHandlers }) => {
    assert.ok(domHandlers.length >= 5,
      `expected the panel to register several handlers, got ${domHandlers.length}`);
    for (const { type, handler } of domHandlers) {
      assert.doesNotThrow(() => handler({ preventDefault() {}, stopPropagation() {}, target: {} }),
        `a "${type}" handler threw`);
    }
  });
});
