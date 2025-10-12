// ==UserScript==
// @name         WME Quick HN Importer - Slovenia
// @namespace    http://tampermonkey.net/
// @version      0.8
// @description  Display Slovenian house numbers on WME map for easy reference (Script tab UI, UX improvements; GML only)
// @author       ThatByte
// @include      /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor.*$/
// @connect      storitve.eprostor.gov.si
// @require      https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js
// @grant        GM_xmlhttpRequest
// ==/UserScript==

/* global W, OpenLayers, I18n, proj4, getWmeSdk */

(function () {
  'use strict';

  let wmeSDK;

  // LocalStorage helpers
  const LS = {
    getBuffer()       { return Number(localStorage.getItem('qhn-buffer') ?? '200'); },
    setBuffer(v)      { localStorage.setItem('qhn-buffer', String(v)); },
    getLayerVisible() { return localStorage.getItem('qhn-layer-visible') === '1'; },
    setLayerVisible(v){ localStorage.setItem('qhn-layer-visible', v ? '1' : '0'); }
  };

  // Toast helper
  const toast = (msg, type = 'info') => {
    try {
      if (wmeSDK?.Notifications?.show) {
        wmeSDK.Notifications.show({ text: msg, type, timeout: 3500 });
      } else {
        console.info(`[QHN] ${msg}`);
      }
    } catch (_) { console.info(`[QHN] ${msg}`); }
  };

  // EPSG:3794 once
  if (!proj4.defs['EPSG:3794']) {
    proj4.defs(
      'EPSG:3794',
      '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
    );
  }

  // Boot when WME + SDK are ready
  function bootstrap() {
    if (!document.getElementById('edit-panel') || !W || !W.map || !W.model) {
      setTimeout(bootstrap, 250);
      return;
    }

    if (wmeSDK.State.isReady) {
      init();
    } else {
      wmeSDK.Events.once({ eventName: 'wme-ready' }).then(init);
    }
  }

  function init() {
    let currentStreetId = null;
    let streetNames = {};
    let streets = {};
    let lastFeatures = [];
    let isLoading = false;

    // Map layer
    const layer = new OpenLayers.Layer.Vector('SL-HN', {
      uniqueName: 'quick-hn-sl-importer',
      styleMap: new OpenLayers.StyleMap({
        default: new OpenLayers.Style(
          {
            fillColor: '${fillColor}',
            fillOpacity: '${opacity}',
            fontColor: '#111111',
            fontWeight: 'bold',
            strokeColor: '#ffffff',
            strokeOpacity: '${opacity}',
            strokeWidth: 2,
            pointRadius: '${radius}',
            label: '${number}',
            title: '${title}',
          },
          {
            context: {
              fillColor: f => f.attributes && f.attributes.street === currentStreetId ? '#99ee99' : '#cccccc',
              radius:   f => (f.attributes && f.attributes.number) ? Math.max(f.attributes.number.length * 6, 10) : 10,
              // fade = selected street + already in WME
              opacity:  f => (currentStreetId && f.attributes?.street === currentStreetId && f.attributes?.processed) ? 0.3 : 1,
              title:    f => (f.attributes && f.attributes.number && f.attributes.street)
                             ? `${streetNames[f.attributes.street]} ${f.attributes.number}` : ''
            }
          }
        ),
      }),
    });

    try {
      I18n.translations[I18n.currentLocale()].layers.name['quick-hn-sl-importer'] = 'Quick HN Importer';
    } catch (_) {}
    layer.setVisibility(false);
    W.map.addLayer(layer);

    // Small inline loader
    const loading = document.createElement('div');
    loading.style.position = 'absolute';
    loading.style.bottom = '35px';
    loading.style.width = '100%';
    loading.style.pointerEvents = 'none';
    loading.style.display = 'none';
    loading.innerHTML =
      '<div style="margin:0 auto; max-width:300px; text-align:center; background:rgba(0, 0, 0, 0.5); color:white; border-radius:3px; padding:5px 15px;"><i class="fa fa-pulse fa-spinner"></i> Loading address points</div>';
    document.getElementById('map').appendChild(loading);

    // Script tab UI
    wmeSDK.Sidebar.registerScriptTab().then(({ tabLabel, tabPane }) => {
      tabLabel.innerText = 'SL-HN';
      tabLabel.title = 'Quick HN Importer (Slovenia)';

      tabPane.innerHTML = `
        <div id="qhn-pane" style="padding:10px;">
          <h2 style="margin-top:0;">Quick HN Importer 🇸🇮</h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px 0;">
            <button id="hn-load" class="wz-button">Load visible selection</button>
            <button id="hn-clear" class="wz-button wz-button--secondary">Clear</button>
          </div>
          <div style="display:flex;gap:12px;align-items:center;">
            <wz-checkbox id="hn-toggle">Show layer</wz-checkbox>
            <wz-checkbox id="qhn-missing">Show only missing</wz-checkbox>
            <span style="font-size:12px;">Buffer (m): <input id="qhn-buffer" type="number" min="0" step="50" style="width:80px;margin-left:6px"></span>
          </div>
          <div id="hn-status" style="margin-top:10px;font-size:12px;color:#666;line-height:1.4;">
            <b>Instructions</b><br/>
            1) Select a segment • 2) Click “Load visible selection” • Green = selected street • Faded = already in WME
          </div>
        </div>
      `;

      // Elements
      const btnLoad    = tabPane.querySelector('#hn-load');
      const btnClear   = tabPane.querySelector('#hn-clear');
      const chkVis     = tabPane.querySelector('#hn-toggle');
      const chkMissing = tabPane.querySelector('#qhn-missing');
      const bufferEl   = tabPane.querySelector('#qhn-buffer');
      const statusDiv  = tabPane.querySelector('#hn-status');

      // wz-checkbox utils
      const isChecked  = (el) => el?.hasAttribute('checked');
      const setChecked = (el, v) => v ? el.setAttribute('checked','') : el.removeAttribute('checked');

      // Load persisted
      bufferEl.value = String(LS.getBuffer());
      if (LS.getLayerVisible()) {
        setChecked(chkVis, true);
        layer.setVisibility(true);
      }

      bufferEl.addEventListener('change', () => {
        const val = Number(bufferEl.value);
        if (!Number.isFinite(val) || val < 0) { bufferEl.value = String(LS.getBuffer()); return; }
        LS.setBuffer(val);
      });

      // Toggle layer
      chkVis.addEventListener('click', () => {
        const on = isChecked(chkVis);
        setChecked(chkVis, !on);
        layer.setVisibility(!on);
        LS.setLayerVisible(!on);
      });

      // Apply filter
      chkMissing.addEventListener('click', () => {
        setChecked(chkMissing, !isChecked(chkMissing));
        applyFeatureFilter();
      });

      // Load flow
      btnLoad.addEventListener('click', async () => {
        if (isLoading) return;
        isLoading = true;
        btnLoad.disabled = true;
        btnLoad.textContent = 'Loading…';

        layer.removeAllFeatures();
        streets = {};
        streetNames = {};
        currentStreetId = null;
        lastFeatures = [];

        await updateLayer(statusDiv).catch(()=>{});
        layer.setVisibility(true);
        setChecked(chkVis, true);
        LS.setLayerVisible(true);

        btnLoad.disabled = false;
        btnLoad.textContent = 'Load visible selection';
        isLoading = false;
      });

      btnClear.addEventListener('click', () => {
        layer.removeAllFeatures();
        layer.setVisibility(false);
        setChecked(chkVis, false);
        LS.setLayerVisible(false);
        streets = {};
        streetNames = {};
        currentStreetId = null;
        lastFeatures = [];
        statusDiv.innerHTML = `<b>Instructions</b><br/>
          1) Select a segment • 2) Click “Load visible selection” • Green = selected street • Faded = already in WME`;
      });

      function applyFeatureFilter() {
        const onlyMissing = isChecked(chkMissing);
        layer.removeAllFeatures();
        if (!lastFeatures.length) return;
        layer.addFeatures(onlyMissing ? lastFeatures.filter(f => !f.attributes?.processed) : lastFeatures);
      }

      // --- Data (GML) ---
      function updateLayer(statusDiv) {
        return new Promise((resolve) => {
          const selection = W.selectionManager.getSegmentSelection();
          if (!selection.segments || selection.segments.length === 0) {
            toast('Select a segment first.', 'warning');
            statusDiv.textContent = 'No segment selected.';
            resolve();
            return;
          }

          loading.style.display = null;

          // bounds of selected segments
          let bounds = null;
          selection.segments.forEach(seg => {
            bounds == null
              ? (bounds = seg.attributes.geometry.getBounds())
              : bounds.extend(seg.attributes.geometry.getBounds());
          });

          // user buffer
          const buffer = LS.getBuffer();
          const b = bounds.clone();
          b.left -= buffer; b.right += buffer; b.bottom -= buffer; b.top += buffer;

          // to EPSG:3794 for WFS
          const bl = proj4('EPSG:3857', 'EPSG:3794', [b.left,  b.bottom]);
          const tr = proj4('EPSG:3857', 'EPSG:3794', [b.right, b.top]);

          const urlGml = 'https://storitve.eprostor.gov.si/ows-ins-wfs/ows?'
            + 'service=WFS&version=2.0.0&request=GetFeature&typeNames=ad:Address&outputFormat=GML32&'
            + `bbox=${bl[0]},${bl[1]},${tr[0]},${tr[1]},urn:ogc:def:crs:EPSG::3794`;

          const currentHNs = getSelectionHNs();

          GM_xmlhttpRequest({
            method: 'GET',
            url: urlGml,
            onload: function (response) {
              try {
                // parse GML
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(response.responseText, 'text/xml');
                const addresses = xmlDoc.getElementsByTagNameNS(
                  'http://inspire.ec.europa.eu/schemas/ad/4.0',
                  'Address'
                );

                const features = [];

                for (let i = 0; i < addresses.length; i++) {
                  const address = addresses[i];

                  // coords
                  const pos = address.getElementsByTagNameNS('http://www.opengis.net/gml/3.2', 'pos')[0];
                  if (!pos) continue;
                  const coords = pos.textContent.trim().split(' ');
                  const [x3794, y3794] = coords.map(parseFloat);
                  const [wx, wy] = proj4('EPSG:3794', 'EPSG:3857', [x3794, y3794]);

                  // house number
                  const designators = address.getElementsByTagNameNS(
                    'http://inspire.ec.europa.eu/schemas/ad/4.0',
                    'designator'
                  );
                  let hn = null;
                  for (let j = 0; j < designators.length; j++) {
                    const val = designators[j].textContent.trim();
                    if (val) { hn = val; break; }
                  }
                  if (!hn) continue;

                  // street name
                  const components = address.getElementsByTagNameNS(
                    'http://inspire.ec.europa.eu/schemas/ad/4.0',
                    'component'
                  );
                  let streetName = null;
                  for (let k = 0; k < components.length; k++) {
                    const href  = components[k].getAttributeNS('http://www.w3.org/1999/xlink', 'href');
                    const title = components[k].getAttributeNS('http://www.w3.org/1999/xlink', 'title');
                    if (href && href.includes('ThoroughfareName')) { streetName = title; break; }
                  }
                  if (!streetName) continue;

                  const streetId = streetName.toLowerCase().replace(/\s+/g, '_');
                  if (!streets[streetName]) {
                    streets[streetName]   = streetId;
                    streetNames[streetId] = streetName;
                  }

                  features.push(
                    new OpenLayers.Feature.Vector(new OpenLayers.Geometry.Point(wx, wy), {
                      number: hn,
                      street: streetId,
                      processed: currentHNs.indexOf(hn) !== -1,
                    })
                  );
                }

                // pick best match across selected segments
                const allStreetIds = new Set();
                selection.segments.forEach(seg => {
                  (seg.attributes.streetIDs || []).forEach(id => allStreetIds.add(id));
                  if (seg.attributes.primaryStreetID) allStreetIds.add(seg.attributes.primaryStreetID);
                });
                const selectedNames = W.model.streets.getByIds([...allStreetIds])
                  .map(s => s?.attributes?.name)
                  .filter(Boolean);

                let best = null, bestCount = -1;
                selectedNames.forEach(name => {
                  const sid = streets[name];
                  if (!sid) return;
                  const count = features.reduce((n,f)=> n + (f.attributes?.street === sid ? 1 : 0), 0);
                  if (count > bestCount) { best = sid; bestCount = count; }
                });
                currentStreetId = best || null;

                if (!features.length) {
                  loading.style.display = 'none';
                  statusDiv.textContent = 'No address points in view.';
                  resolve();
                  return;
                }

                // render
                lastFeatures = features;
                layer.removeAllFeatures();
                if (chkMissing.hasAttribute('checked')) {
                  layer.addFeatures(lastFeatures.filter(f => !f.attributes?.processed));
                } else {
                  layer.addFeatures(lastFeatures);
                }

                loading.style.display = 'none';
                statusDiv.textContent = `Loaded ${lastFeatures.length} address points. Green = selected street`;
                resolve();
              } catch (err) {
                fail(err);
              }
            },
            onerror: fail
          });

          function fail(err) {
            console.error('[Quick HN Importer] WFS error:', err);
            loading.style.display = 'none';
            statusDiv.textContent = 'Error fetching WFS data. See console.';
            toast('Error fetching WFS data.', 'error');
            resolve();
          }
        });
      }

      // HNs already on selected segments
      function getSelectionHNs() {
        const selectedSegIds = W.selectionManager
          .getSegmentSelection()
          .segments.map(s => s.attributes.id);
        return W.model.segmentHouseNumbers
          .getObjectArray()
          .filter(hn => selectedSegIds.indexOf(hn.attributes.segID) !== -1)
          .map(hn => hn.attributes.number);
      }
    });
  }

  // SDK init
  (("unsafeWindow" in window ? window.unsafeWindow : window).SDK_INITIALIZED).then(() => {
    wmeSDK = getWmeSdk({ scriptId: 'quick-hn-sl-importer', scriptName: 'Quick HN Importer (SI)' });
    bootstrap();
  });
})();
