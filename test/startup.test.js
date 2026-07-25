'use strict';

// Boots the whole userscript against stubbed browser/WME globals. This is the only
// test that executes init(), which is where most of the file lives — it catches
// undefined identifiers and broken wiring, the class of mistake `node --check`
// cannot see.
//
// What it covers: layer creation, overlay visibility gating, and every registered
// event handler (updateLayerVisibility, onSelectionChanged, maybeAutoLoad).
//
// What it does NOT cover, verified by mutation testing:
//   - the render paths (applyFeatureFilter / renderAuditFindings). Nothing here loads
//     address data, so they never run; a typo there is also swallowed by their
//     error-isolation try/catch, so it degrades silently rather than throwing.
//   - redundant-work regressions, e.g. dropping the `shown` change-guard. That makes
//     extra SDK calls without throwing.
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
async function bootScript(storage = {}, whileStubbed = null) {
  const calls = [];
  const layers = new Map();

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
        layers.set(arg.layerName, { visible: false, features: [] });
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
      case 'Editing.getSelection': return null;
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
    GM_xmlhttpRequest() {}, GM_setClipboard() {},
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
    if (whileStubbed) await whileStubbed({ calls, layers, handlers, domHandlers });
  } finally {
    for (const k of Object.keys(globals)) global[k] = saved[k];
  }
  return { calls, layers, handlers, domHandlers };
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

test('on a fresh install every overlay starts hidden', async () => {
  const { layers } = await bootScript();
  for (const [name, layer] of layers) {
    assert.strictEqual(layer.visible, false, `${name} must start hidden`);
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
