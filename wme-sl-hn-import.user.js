// ==UserScript==
// @name         WME Quick HN Importer - Slovenia
// @namespace    https://github.com/zigapovhe/wme-sl-hn-import
// @version      2.4.0
// @description  Quickly add Slovenian house numbers with clickable overlays
// @author       ThatByte
// @downloadURL  https://raw.githubusercontent.com/zigapovhe/wme-sl-hn-import/main/wme-sl-hn-import.user.js
// @updateURL    https://raw.githubusercontent.com/zigapovhe/wme-sl-hn-import/main/wme-sl-hn-import.user.js
// @supportURL   https://github.com/zigapovhe/wme-sl-hn-import/issues
// @icon         https://raw.githubusercontent.com/zigapovhe/wme-sl-hn-import/main/icon48.png
// @icon64       https://raw.githubusercontent.com/zigapovhe/wme-sl-hn-import/main/icon64.png
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/*
// @exclude      https://www.waze.com/user/editor*
// @connect      ipi.eprostor.gov.si
// @connect      raw.githubusercontent.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @license      MIT
// @noframes
// ==/UserScript==

/*
 * Click handling and nearest segment matching based on work by
 * Tom 'Glodenox' Puttemans (https://github.com/Glodenox/wme-quick-hn-importer)
 */

/* global I18n, proj4, getWmeSdk, unsafeWindow */

(function () {
  'use strict';

  let wmeSDK;
  const SDK_LAYER_NAME = 'qhnsl-sdk';
  const SDK_STREETNAMES_LAYER_NAME = 'qhnsl-streetnames';
  const SDK_AUDIT_LAYER_NAME = 'qhnsl-audit';
  const SDK_NAVPOINTS_LAYER_NAME = 'qhnsl-navpoints';

  const MAX_CLICK_DISTANCE_PX = 25;

  // Below this zoom the overlays are hidden: the markers would overlap into noise.
  const MIN_OVERLAY_ZOOM = 18;

  // Auto-load debounce: click-dragging across several segments should cost one fetch.
  const AUTO_LOAD_DEBOUNCE_MS = 400;

  // How long after a map move/zoom a click is treated as part of that gesture rather
  // than a deliberate click on a marker.
  const CLICK_AFTER_MOVE_GRACE_MS = 250;
  const MAX_HN_CONFLICT_DISTANCE = 10;

  // A WME house number counts as matched only if eProstor has that number on the
  // same street within this many metres. Above it, the number is reported as
  // misplaced rather than missing.
  const AUDIT_MAX_DISTANCE = 30;

  // Waze road types house numbers should never attach to, using the ids from the
  // SDK's ROAD_TYPE constant:
  //   5  WALKING_TRAIL         10 PEDESTRIAN_BOARDWALK
  //   9  WALKWAY               16 STAIRWAY
  //   18 RAILROAD              19 RUNWAY_TAXIWAY
  // WALKWAY (9) is the non-routable pedestrian type and the most common pedestrian
  // geometry in Slovenian residential areas — without it a courtyard path that
  // happens to be nearer than the real street could take the house number, and
  // could then be renamed by the fix-street flow, which shares this matching.
  const NON_ADDRESSABLE_ROAD_TYPES = new Set([5, 9, 10, 16, 18, 19]);

  // A name-matched segment counts as "suspiciously far" when it is farther than
  // FAR_STREET_MIN_DISTANCE meters AND more than FAR_STREET_RATIO times farther
  // than the closest segment of any name. Both must hold: the floor keeps
  // driveway-adjacent houses quiet, the ratio keeps remote farmhouses quiet.
  const FAR_STREET_MIN_DISTANCE = 50;
  const FAR_STREET_RATIO = 2;

  // EProstor API configuration
  const EPROSTOR_API = 'https://ipi.eprostor.gov.si/wfs-si-gurs-rn/ogc/features/collections/SI.GURS.RN:REGISTER_NASLOVOV/items';
  const EPROSTOR_LIMIT = 1000;
  const EPROSTOR_MAX_PAGES = 30; // hard cap: 30 pages × 1000 addresses per load

  // Shown in the status box on startup and after Clear
  const INSTRUCTIONS_HTML = `<b>Instructions</b><br/>
    1) Select a segment • 2) Click "Load selected street" • 3) <b>Click house numbers on map to add them</b><br/>
    Green = selected street • Orange = other streets • Red = possible wrong HN • Faded = already in WME`;

  // Common Slovenian street name abbreviations
  const ABBREVIATIONS = {
    'c.': 'cesta',
    'ul.': 'ulica',
    'nab.': 'nabrežje',
    'trg.': 'trg'
  };

  const LS = {
    getBuffer()       { return Number(localStorage.getItem('qhnsl-buffer') ?? '500'); },
    setBuffer(v)      { localStorage.setItem('qhnsl-buffer', String(v)); },
    getLayerVisible() { return localStorage.getItem('qhnsl-layer-visible') === '1'; },
    setLayerVisible(v){ localStorage.setItem('qhnsl-layer-visible', v ? '1' : '0'); },
    getSelectedOnly() { return localStorage.getItem('qhnsl-selected-only') === '1'; },
    setSelectedOnly(v){ localStorage.setItem('qhnsl-selected-only', v ? '1' : '0'); },
    getNavPoints()    { return localStorage.getItem('qhnsl-navpoints') === '1'; },
    setNavPoints(v)   { localStorage.setItem('qhnsl-navpoints', v ? '1' : '0'); },
    getStreetNames()  { return localStorage.getItem('qhnsl-street-names') !== '0'; }, // default on
    setStreetNames(v) { localStorage.setItem('qhnsl-street-names', v ? '1' : '0'); },
    getAudit()        { return localStorage.getItem('qhnsl-audit') === '1'; },
    setAudit(v)       { localStorage.setItem('qhnsl-audit', v ? '1' : '0'); },
    getAutoLoad()     { return localStorage.getItem('qhnsl-autoload') === '1'; },
    setAutoLoad(v)    { localStorage.setItem('qhnsl-autoload', v ? '1' : '0'); }
  };

  const TOAST_COLORS = {
    info:    { bg: '#e7f1ff', border: '#5b9bd5', text: '#12385e' },
    success: { bg: '#d4edda', border: '#28a745', text: '#155724' },
    warning: { bg: '#fff3cd', border: '#ffc107', text: '#7a5b00' },
    error:   { bg: '#f8d7da', border: '#dc3545', text: '#721c24' }
  };
  const TOAST_TIMEOUT_MS = 4000;

  // Self-rolled because the SDK has no notifications API: its class list is
  // BigJunctions … Sidebar, States, Streets, Venues, with nothing for toasts. The
  // previous wmeSDK.Notifications.show call could never fire, so every message the
  // script tried to show — including "result truncated, reduce the buffer" — went only
  // to the console where nobody was looking. Built with plain DOM, like the
  // fix-street dialog, so it depends on nothing else being installed.
  let toastHost = null;
  const toast = (msg, type = 'info') => {
    console.info(`[SL-HN] ${msg}`); // keep the console trail for debugging
    try {
      if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.style.cssText = 'position:fixed;top:70px;right:16px;z-index:10001;'
          + 'display:flex;flex-direction:column;gap:6px;align-items:flex-end;'
          + 'pointer-events:none;max-width:340px;';
        document.body.appendChild(toastHost);
      }

      const colors = TOAST_COLORS[type] || TOAST_COLORS.info;
      const el = document.createElement('div');
      el.textContent = msg; // textContent, not innerHTML: messages interpolate street names
      el.style.cssText = `background:${colors.bg};border:1px solid ${colors.border};`
        + `color:${colors.text};border-radius:4px;padding:8px 12px;font-size:12px;`
        + 'box-shadow:0 2px 6px rgba(0,0,0,0.2);opacity:0;transition:opacity 150ms;';
      toastHost.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = '1'; });

      setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 200);
      }, TOAST_TIMEOUT_MS);
    } catch (e) {
      console.debug('[SL-HN] toast render failed:', e);
    }
  };

  // True in Tampermonkey, false when this file is require()d by the test suite,
  // which has no DOM, no @require'd proj4 and no WME SDK. Everything gated on it
  // is browser-only setup; the pure logic below stays reachable either way.
  const IN_USERSCRIPT_ENV = typeof unsafeWindow !== 'undefined' || typeof window !== 'undefined';

  // EPSG:3794 definition (Slovenia D96/TM)
  if (IN_USERSCRIPT_ENV && typeof proj4 !== 'undefined' && !proj4.defs['EPSG:3794']) {
    proj4.defs(
      'EPSG:3794',
      '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
    );
  }

  // The join key for street names on both sides of every comparison. Trimmed for the
  // same reason normalizeHN is: a WME street typed with a trailing space would key as
  // "celovska_cesta_", match nothing in the eProstor data, and silently drop the whole
  // street out of the audit while its circles stayed clickable.
  function normalizeStreetName(name) {
    return String(name).trim().toLowerCase().replace(/\s+/g, '_');
  }

  // Escape HTML special characters for safe attribute insertion
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Expand abbreviations and normalize for comparison
  function normalizeForComparison(name) {
    let normalized = String(name).toLowerCase().trim();

    for (const [abbrev, full] of Object.entries(ABBREVIATIONS)) {
      const escapedAbbrev = abbrev.replace(/\./g, '\\.');
      const regex = new RegExp('(^|\\s)' + escapedAbbrev + '(?=\\s|$)', 'gi');
      normalized = normalized.replace(regex, '$1' + full);
    }

    // Remove extra whitespace
    normalized = normalized.replace(/\s+/g, ' ');

    return normalized;
  }

  function removeDiacritics(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // Calculate similarity between two strings (0-1)
  function calculateSimilarity(str1, str2) {
    const s1 = normalizeForComparison(str1);
    const s2 = normalizeForComparison(str2);

    // Exact match after normalization
    if (s1 === s2) return 1.0;

    // Match without diacritics
    if (removeDiacritics(s1) === removeDiacritics(s2)) return 0.95;

    // Levenshtein distance based similarity
    const distance = levenshteinDistance(s1, s2);
    const maxLen = Math.max(s1.length, s2.length);
    const similarity = 1 - (distance / maxLen);

    return similarity;
  }

  // Levenshtein distance implementation
  function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }

    return dp[m][n];
  }

  function getHNGeometry(hn) {
    if (!hn?.geometry?.coordinates) return null;
    return { x: hn.geometry.coordinates[0], y: hn.geometry.coordinates[1] };
  }

  function getSelectedSegments() {
    const sel = wmeSDK.Editing.getSelection();
    if (!sel || sel.objectType !== 'segment') return [];
    return sel.ids
      .map(id => wmeSDK.DataModel.Segments.getById({ segmentId: id }))
      .filter(Boolean);
  }

  // The single normalization rule for comparing house numbers. Both sides of
  // every comparison must go through this: eProstor writes "12a" where an editor
  // may have typed "12 a", and a mismatch makes the audit report valid data as
  // missing. Internal whitespace is collapsed; "/" is deliberately kept, since
  // it can distinguish genuinely different addresses.
  function normalizeHN(value) {
    return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
  }

  // Build house number string from components
  function buildHouseNumber(stevilka, dodatek) {
    let hn = String(stevilka || '').trim();
    if (dodatek) {
      hn += String(dodatek).trim();
    }
    return normalizeHN(hn);
  }

  // Check if a house number has a nearby conflict (different HN within threshold distance)
  function hasConflict(hn, wx, wy, entry) {
    if (!entry?.items?.length) return false;
    for (const it of entry.items) {
      if (!it || it.x == null || it.y == null) continue;
      if (it.num !== hn) {
        const dx = wx - it.x, dy = wy - it.y;
        if (dx * dx + dy * dy <= MAX_HN_CONFLICT_DISTANCE * MAX_HN_CONFLICT_DISTANCE) {
          return true;
        }
      }
    }
    return false;
  }

  // Reverse audit: WME house numbers with no eProstor counterpart.
  // Pure by design — every input is a parameter, so the test suite can exercise it
  // without a browser, an SDK or a network. Keep it that way: read no closure state.
  //   features:        eProstor points, each { street, number, eX, eY }
  //   selectionHNMap:  WME house numbers, street key -> { items: [...] }
  //   loadedBbox:      EPSG:3794 area eProstor was fetched for, or null
  function computeAuditFindings(features, selectionHNMap, loadedBbox) {
    const findings = [];
    if (!features || !features.length || !selectionHNMap) return findings;
    // Without a known fetch area we cannot tell "absent from eProstor" from
    // "outside what we asked eProstor about".
    if (!loadedBbox) return findings;

    // eProstor side: street -> number -> [projected points]
    const official = new Map();
    features.forEach(f => {
      if (!f.street || !f.number) return;
      let byNum = official.get(f.street);
      if (!byNum) { byNum = new Map(); official.set(f.street, byNum); }
      const num = normalizeHN(f.number);
      let pts = byNum.get(num);
      if (!pts) { pts = []; byNum.set(num, pts); }
      pts.push({ eX: f.eX, eY: f.eY });
    });

    // WME side: one record per house number. The same HN is indexed under a
    // segment's primary AND alternate names, so fold by id first — otherwise
    // every dual-named segment becomes a false positive.
    const wmeHns = new Map();
    selectionHNMap.forEach((entry, streetKey) => {
      entry.items.forEach(it => {
        if (!it.hnId) return;
        let rec = wmeHns.get(it.hnId);
        if (!rec) {
          rec = {
            hnId: it.hnId, num: it.num, x: it.x, y: it.y,
            lon: it.lon, lat: it.lat, segmentId: it.segmentId,
            streetKeys: new Set()
          };
          wmeHns.set(it.hnId, rec);
        }
        rec.streetKeys.add(streetKey);
      });
    });

    const maxSq = AUDIT_MAX_DISTANCE * AUDIT_MAX_DISTANCE;

    wmeHns.forEach(rec => {
      if (rec.lon == null || rec.lat == null) return;
      // Compare like with like. selectionHNMap is scoped to the current viewport,
      // which drifts as the user pans, while `official` is frozen to the fetched
      // bbox. Auditing a house number outside that bbox would flag valid data as
      // missing purely because we never asked eProstor about it.
      if (rec.x == null || rec.y == null) return;
      // Inset by AUDIT_MAX_DISTANCE, not flush to the fetched box. A pin just inside
      // the edge can legitimately match an eProstor point just outside it — which the
      // CQL filter never returned — so judging that band produces false "missing".
      if (rec.x < loadedBbox.minE + AUDIT_MAX_DISTANCE || rec.x > loadedBbox.maxE - AUDIT_MAX_DISTANCE ||
          rec.y < loadedBbox.minN + AUDIT_MAX_DISTANCE || rec.y > loadedBbox.maxN - AUDIT_MAX_DISTANCE) return;
      let audited = false;
      let numberExistsSomewhere = false;
      let matched = false;

      for (const key of rec.streetKeys) {
        const byNum = official.get(key);
        if (!byNum) continue; // street not in eProstor data: out of scope
        audited = true;
        const pts = byNum.get(rec.num);
        if (!pts || !pts.length) continue; // number absent on this street
        numberExistsSomewhere = true;
        if (pts.some(p => {
          const dx = p.eX - rec.x;
          const dy = p.eY - rec.y;
          return dx * dx + dy * dy <= maxSq;
        })) { matched = true; break; }
      }

      if (!audited || matched) return;
      findings.push({
        hnId: rec.hnId,
        number: rec.num,
        segmentId: rec.segmentId,
        lon: rec.lon,
        lat: rec.lat,
        streetKeys: Array.from(rec.streetKeys),
        type: numberExistsSomewhere ? 'misplaced' : 'missing'
      });
    });

    return findings;
  }

  // The EPSG:3794 box to ask eProstor about: the selected segments' extent, grown by
  // `buffer` metres. Returns null when no segment has usable geometry.
  // proj4 is passed in so this stays testable without the @require'd global.
  function computeFetchBbox(segments, buffer, project = proj4) {
    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    for (const seg of segments || []) {
      const coords = seg?.geometry?.coordinates;
      if (!Array.isArray(coords)) continue;
      for (const [lon, lat] of coords) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (minLon === Infinity) return null;

    const [blE, blN] = project('EPSG:4326', 'EPSG:3794', [minLon, minLat]);
    const [trE, trN] = project('EPSG:4326', 'EPSG:3794', [maxLon, maxLat]);
    return {
      minE: Math.floor(blE - buffer),
      minN: Math.floor(blN - buffer),
      maxE: Math.ceil(trE + buffer),
      maxN: Math.ceil(trN + buffer)
    };
  }

  // True when every point of every selected segment lies inside `bbox` (EPSG:3794),
  // i.e. we already hold reference data covering that selection.
  //
  // Answers false unless it actually verified at least one point. Claiming coverage
  // after examining nothing — no geometry, or NaN coordinates where every comparison
  // is false — made auto-load silently stop fetching.
  // proj4 is injectable so this stays testable outside the browser.
  function isSelectionInsideBbox(segments, bbox, project = proj4) {
    if (!bbox) return false;
    let checked = 0;
    for (const seg of segments || []) {
      const coords = seg?.geometry?.coordinates;
      if (!Array.isArray(coords)) continue;
      for (const pt of coords) {
        const [e, n] = project('EPSG:4326', 'EPSG:3794', [pt[0], pt[1]]);
        if (!Number.isFinite(e) || !Number.isFinite(n)) return false;
        checked++;
        if (e < bbox.minE || e > bbox.maxE || n < bbox.minN || n > bbox.maxN) return false;
      }
    }
    return checked > 0;
  }

  // Grid size for the location component of a feature key. Anything coarser than a
  // town and finer than the distance between towns works.
  const FEAT_KEY_GRID_M = 1000;

  // Identifies one address for the "added this session but not yet saved" set.
  //
  // The location component is load-bearing: keyed on street name and number alone,
  // "Glavna cesta 12" in one town collided with "Glavna cesta 12" in another. Adding
  // the first without saving then made the second look already-added — its circle
  // faded, "Show only missing" hid it, and clicking did nothing, so a genuinely
  // absent house number could not be added at all until the editor was saved.
  //
  // Derived from the address's own EPSG:3794 coordinates, so it is stable for a given
  // address regardless of where the grid boundaries fall.
  function makeFeatKey(streetId, number, eX, eY) {
    const cell = (Number.isFinite(eX) && Number.isFinite(eY))
      ? `${Math.floor(eX / FEAT_KEY_GRID_M)}:${Math.floor(eY / FEAT_KEY_GRID_M)}`
      : 'nocoords';
    return `${streetId}|${number}|${cell}`;
  }

  // Build CQL filter for coordinate bounds (excludes apartments)
  function buildCqlFilter(minE, minN, maxE, maxN) {
    return `E>=${minE} AND E<=${maxE} AND N>=${minN} AND N<=${maxN} AND ST_STANOVANJA IS NULL`;
  }

  // Fetch addresses from EProstor API with pagination. shouldAbort (optional)
  // is checked between pages so a Clear / newer Load stops the request chain.
  //
  // Resolves { features, complete }. `complete` is false when the result is a partial
  // answer for the requested box — the page cap was hit, or a page came back invalid
  // after earlier pages succeeded. Callers must not treat a partial result as
  // authoritative coverage: the reverse audit would report addresses in the
  // never-fetched remainder as missing from eProstor.
  function fetchAddresses(minE, minN, maxE, maxN, shouldAbort) {
    return new Promise((resolve, reject) => {
      const allFeatures = [];
      let startIndex = 0;
      let pageCount = 0;

      function fetchPage() {
        if (typeof shouldAbort === 'function' && shouldAbort()) {
          resolve({ features: allFeatures, complete: false }); // caller discards stale results anyway
          return;
        }
        if (++pageCount > EPROSTOR_MAX_PAGES) {
          console.warn(`[SL-HN] EProstor result truncated at ${EPROSTOR_MAX_PAGES} pages — reduce the buffer`);
          toast('Too many addresses in area — result truncated, reduce the buffer', 'warning');
          resolve({ features: allFeatures, complete: false });
          return;
        }
        const filter = buildCqlFilter(minE, minN, maxE, maxN);
        const url = EPROSTOR_API +
          '?f=application/json' +
          '&limit=' + EPROSTOR_LIMIT +
          '&startIndex=' + startIndex +
          '&filter=' + encodeURIComponent(filter) +
          '&filter-lang=cql-text';

        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          timeout: 30000,
          onload: function (response) {
            try {
              const data = JSON.parse(response.responseText);

              if (!data.features || !Array.isArray(data.features)) {
                if (allFeatures.length > 0) {
                  // Keep what we have, but it is not the whole box.
                  console.warn('[SL-HN] EProstor returned an invalid page; result is partial');
                  resolve({ features: allFeatures, complete: false });
                } else {
                  reject(new Error('Invalid API response'));
                }
                return;
              }

              allFeatures.push(...data.features);

              // Check if there are more pages: trust numberMatched when the
              // server provides it, otherwise assume a full page means more.
              const returned = data.numberReturned || data.features.length;
              const total = typeof data.numberMatched === 'number' ? data.numberMatched : null;
              const hasMore = total != null
                ? startIndex + returned < total
                : returned >= EPROSTOR_LIMIT;
              if (hasMore && returned > 0) {
                startIndex += returned;
                fetchPage();
              } else {
                resolve({ features: allFeatures, complete: true });
              }
            } catch (err) {
              reject(err);
            }
          },
          onerror: function (err) {
            reject(err);
          },
          ontimeout: function () {
            reject(new Error('EProstor request timed out after 30s'));
          }
        });
      }

      fetchPage();
    });
  }

  // Copy text to clipboard
  function copyToClipboard(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      toast(`Copied "${text}" to clipboard`, 'success');
    } else {
      navigator.clipboard.writeText(text).then(() => {
        toast(`Copied "${text}" to clipboard`, 'success');
      }).catch(() => {
        toast('Failed to copy to clipboard', 'error');
      });
    }
  }

  // ---- Fix-street floating dialog (shown when an official street name has no WME match) ----
  let fixStreetDialogEl = null;

  function closeFixStreetDialog() {
    if (fixStreetDialogEl) {
      fixStreetDialogEl.remove();
      fixStreetDialogEl = null;
    }
  }

  function showFixStreetDialog({ officialName, hnCount, segmentCount, nearestStreetName, farInfo, onRename, onAddAnyway, onCancel }) {
    closeFixStreetDialog();

    const escapedOfficial = escapeHtml(officialName);
    const headerHtml = farInfo
      ? `⚠️ Official street <b>"${escapedOfficial}"</b> is about ${Math.round(farInfo.farDistance)} m away — the nearest segment (${Math.round(farInfo.nearestDistance)} m) has a different name`
      : `⚠️ Official street <b>"${escapedOfficial}"</b> not found in WME`;

    const addAnywayLabel = farInfo
      ? `Add to "${escapedOfficial}" ${Math.round(farInfo.farDistance)} m away anyway`
      : (nearestStreetName
        ? `Add to "${escapeHtml(nearestStreetName)}" anyway`
        : 'Add to unnamed segment anyway');

    const primaryBtnStyle = 'font-size:12px;padding:4px 10px;cursor:pointer;border:1px solid #28a745;border-radius:3px;background:#d4edda;color:#155724;font-weight:bold;';
    const plainBtnStyle = 'font-size:12px;padding:4px 10px;cursor:pointer;border:1px solid #ccc;border-radius:3px;background:#f8f8f8;color:#333;';

    const div = document.createElement('div');
    div.id = 'qhnsl-fix-street-dialog';
    div.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:10000;'
      + 'background:#fff;border:1px solid #ffc107;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,0.35);'
      + 'padding:12px 16px;font-size:13px;max-width:440px;font-family:inherit;';
    div.innerHTML = `
      <div style="margin-bottom:6px;">${headerHtml}</div>
      <div style="font-size:12px;color:#555;margin-bottom:10px;">
        ${hnCount} house number${hnCount === 1 ? '' : 's'} belong${hnCount === 1 ? 's' : ''} to it (highlighted blue) •
        ${segmentCount} segment${segmentCount === 1 ? '' : 's'} selected<br/>
        Adjust the segment selection on the map if needed, then rename.
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="fix-rename-btn" style="${primaryBtnStyle}">✓ Rename selected segments</button>
        <button class="fix-copy-btn" style="${plainBtnStyle}">📋 Copy name</button>
        <button class="fix-add-anyway-btn" style="${plainBtnStyle}">${addAnywayLabel}</button>
        <button class="fix-cancel-btn" style="${plainBtnStyle}">✕ Cancel</button>
      </div>`;

    div.querySelector('.fix-rename-btn').addEventListener('click', onRename);
    div.querySelector('.fix-copy-btn').addEventListener('click', () => copyToClipboard(officialName));
    div.querySelector('.fix-add-anyway-btn').addEventListener('click', onAddAnyway);
    div.querySelector('.fix-cancel-btn').addEventListener('click', onCancel);

    document.body.appendChild(div);
    fixStreetDialogEl = div;
  }

  // City for a segment that has no street of its own (e.g. a freshly drawn road
  // saved without an address): borrow a real city from another selected segment,
  // else WME's top city, else the empty "no city" entry for the current country.
  function resolveFallbackCityId(segments) {
    // City id borrowed from the selection but not confirmed as a real city
    let borrowedCityId = null;
    for (const seg of segments) {
      const street = seg.primaryStreetId
        ? wmeSDK.DataModel.Streets.getById({ streetId: seg.primaryStreetId })
        : null;
      if (!street?.cityId) continue;
      const city = wmeSDK.DataModel.Cities.getById({ cityId: street.cityId });
      if (city && !city.isEmpty) return street.cityId;
      if (borrowedCityId === null) borrowedCityId = street.cityId;
    }

    const topCity = wmeSDK.DataModel.Cities.getTopCity();
    if (topCity && !topCity.isEmpty) return topCity.id;
    if (borrowedCityId !== null) return borrowedCityId;
    if (topCity) return topCity.id; // empty top city beats creating one

    const countryId = wmeSDK.DataModel.Countries.getTopCountry()?.id;
    if (!countryId) return null;
    const emptyCity = wmeSDK.DataModel.Cities.getCity({ cityName: '', countryId })
      || wmeSDK.DataModel.Cities.addCity({ cityName: '', countryId });
    return emptyCity?.id ?? null;
  }

  // Rename all currently selected segments to the given street name via WME SDK.
  // Returns the number of segments successfully renamed.
  function updateSegmentStreetName(newStreetName, onSuccess) {
    const selectedSegments = getSelectedSegments();
    if (selectedSegments.length === 0) {
      toast('No segment selected', 'warning');
      return 0;
    }

    let renamed = 0;
    let failed = 0;
    let fallbackCityId; // resolved lazily when first needed

    selectedSegments.forEach(segment => {
      try {
        // Resolve the city from the segment's current primary street
        const currentStreet = segment.primaryStreetId
          ? wmeSDK.DataModel.Streets.getById({ streetId: segment.primaryStreetId })
          : null;
        let cityId = currentStreet?.cityId;

        // Segments saved without any address have no street to take the city
        // from — fall back to a city borrowed from the rest of the selection
        if (!cityId) {
          if (fallbackCityId === undefined) fallbackCityId = resolveFallbackCityId(selectedSegments);
          cityId = fallbackCityId;
        }

        if (!cityId) {
          console.warn('[SL-HN] Segment has no resolvable city, skipping:', segment.id);
          failed++;
          return;
        }

        // Get existing street with this name in this city, or create it
        let street = wmeSDK.DataModel.Streets.getStreet({
          cityId: cityId,
          streetName: newStreetName
        });
        if (!street) {
          console.debug('[SL-HN] Street not found, creating new street:', newStreetName);
          street = wmeSDK.DataModel.Streets.addStreet({
            streetName: newStreetName,
            cityId: cityId
          });
        }

        // SDK v2.359 moved the address fields into an `addressData` envelope. The old
        // top-level shape still works but is deprecated, and SegmentAddressData makes
        // ids and raw names mutually exclusive (`primaryStreetId?: never` in the raw
        // variant), so the two can never be mixed by accident.
        //
        // Do not "simplify" this to the raw variant, i.e. addressData: { streetName }.
        // It looks like it would let WME resolve or create the street and delete the
        // city lookup above, but the API rejects it:
        //   ValidationError: cityName is required for raw address updates
        //                    (use empty string for no city)
        // So the city still has to be resolved — as a name rather than an id, saving
        // nothing — and an empty or wrong cityName strips the city off the segment.
        // Verified against a live segment that already had both street and city.
        wmeSDK.DataModel.Segments.updateAddress({
          segmentId: segment.id,
          addressData: { primaryStreetId: street.id }
        });
        console.debug('[SL-HN] Updated segment', segment.id, 'to street ID:', street.id);
        renamed++;
      } catch (err) {
        console.error('[SL-HN] Error renaming segment', segment.id, err);
        failed++;
      }
    });

    if (renamed === 0) {
      toast('Could not rename any segment. See console.', 'error');
      return 0;
    }

    if (failed > 0) {
      toast(`Renamed ${renamed} of ${renamed + failed} segments to "${newStreetName}"`, 'warning');
    } else {
      toast(`Updated street to "${newStreetName}"`, 'success');
    }

    if (typeof onSuccess === 'function') {
      onSuccess();
    }
    return renamed;
  }

  // Returns { segment, distance } with distance in approximate meters, or null.
  function findNearestSegment(feature, streetName, matchName) {
    const point = { x: feature.lon, y: feature.lat };
    // WGS84 → meters scaling around the feature's latitude; plenty accurate
    // for comparing segments within a loaded area a few km across.
    const M_PER_DEG_LAT = 111320;
    const mPerDegLon = M_PER_DEG_LAT * Math.cos(feature.lat * Math.PI / 180);
    const allSegments = wmeSDK.DataModel.Segments.getAll()
      .filter(segment => !NON_ADDRESSABLE_ROAD_TYPES.has(segment.roadType));
    let candidateSegments = allSegments;

    if (matchName) {
      const matchingStreetIds = wmeSDK.DataModel.Streets.getAll()
        .filter(street => street.name?.toLowerCase() === streetName.toLowerCase())
        .map(street => street.id);

      if (matchingStreetIds.length === 0) {
        return null;
      }

      candidateSegments = allSegments.filter(segment => {
        const primaryMatch = matchingStreetIds.includes(segment.primaryStreetId);
        const altMatch = (segment.alternateStreetIds || []).some(id => matchingStreetIds.includes(id));
        return primaryMatch || altMatch;
      });
    }

    if (candidateSegments.length === 0) {
      return null;
    }

    let nearestSegment = null;
    let minDistance = Infinity;

    candidateSegments.forEach(segment => {
      const coords = segment.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const distance = pointToLineDistance(point, coords, mPerDegLon, M_PER_DEG_LAT);
      if (distance < minDistance) {
        minDistance = distance;
        nearestSegment = segment;
      }
    });

    return nearestSegment ? { segment: nearestSegment, distance: minDistance } : null;
  }

  // sx/sy scale lon/lat into meters so the returned distance is in meters.
  function pointToLineDistance(point, coords, sx = 1, sy = 1) {
    const px = point.x * sx;
    const py = point.y * sy;
    let minDist = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[i + 1];
      const dist = pointToSegmentDistance(px, py, x1 * sx, y1 * sy, x2 * sx, y2 * sy);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }

  function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
      const dpx = px - x1;
      const dpy = py - y1;
      return Math.sqrt(dpx * dpx + dpy * dpy);
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));

    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;

    const dpx = px - closestX;
    const dpy = py - closestY;
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }

  // The three map overlays, all created hidden. Style only — no state, no wiring —
  // so this stays out of init(), which is about behaviour.
  //
  // Note the absence of setLayerZIndex on the HN and audit layers: an explicit
  // index on the HN layer buried it under WME's own layers until a selection change
  // made OpenLayers recompute and discard the value, so circles appeared only after
  // deselecting. OL's own ordering works. Audit/HN overlap is resolved by picking
  // the nearest marker in handleMapClick, not by stacking.
  function createOverlayLayers() {
    // House-number circles: green on the selected street, orange elsewhere, red for
    // a conflict, blue while the fix-street flow highlights a street.
    wmeSDK.Map.addLayer({
      layerName: SDK_LAYER_NAME,
      zIndexing: true,
      styleContext: {
        getFillColor: ({ feature }) => {
          const p = feature.properties;
          if (p.fixHighlight) return '#4da6ff';
          if (p.conflict) return '#ff6666';
          return p.isSelectedStreet ? '#99ee99' : '#fb9c4f';
        },
        getOpacity: ({ feature }) => {
          const p = feature.properties;
          if (p.fixHighlight || p.conflict) return 1;
          return (p.isSelectedStreet && p.processed) ? 0.3 : 1;
        },
        getRadius: ({ feature }) => {
          const num = feature.properties.number;
          return num ? Math.max(String(num).length * 7, 12) : 12;
        },
        getLabel: ({ feature }) => String(feature.properties.number ?? '')
      },
      styleRules: [{
        style: {
          graphicName: 'circle',
          pointRadius: '${getRadius}',
          fillColor: '${getFillColor}',
          fillOpacity: '${getOpacity}',
          strokeColor: '#ffffff',
          strokeWidth: 2,
          strokeOpacity: '${getOpacity}',
          label: '${getLabel}',
          fontColor: '#111111',
          fontWeight: 'bold',
          labelOutlineColor: '#ffffff',
          labelOutlineWidth: 0
        }
      }]
    });

    // Label-only: one reference street name floated over each street's cluster of
    // house-number points.
    wmeSDK.Map.addLayer({
      layerName: SDK_STREETNAMES_LAYER_NAME,
      zIndexing: true, // required, or setLayerZIndex on this layer has no effect
      styleContext: {
        getLabel: ({ feature }) => String(feature.properties.name ?? '')
      },
      styleRules: [{
        style: {
          pointRadius: 0,
          fillOpacity: 0,
          strokeOpacity: 0,
          label: '${getLabel}',
          fontColor: '#1a3d7c',
          fontSize: '13px',
          fontWeight: 'bold',
          labelOutlineColor: '#ffffff',
          labelOutlineWidth: 3
        }
      }]
    });

    // Reverse-audit markers. Solid = number not on that street at all; hollow =
    // number exists but the WME pin sits more than AUDIT_MAX_DISTANCE away.
    wmeSDK.Map.addLayer({
      layerName: SDK_AUDIT_LAYER_NAME,
      zIndexing: true,
      styleContext: {
        getAuditFill: ({ feature }) => feature.properties.type === 'missing' ? '#b04ce6' : '#ffffff',
        getAuditFillOpacity: ({ feature }) => feature.properties.type === 'missing' ? 1 : 0.15,
        getAuditLabel: ({ feature }) => String(feature.properties.number ?? '')
      },
      styleRules: [{
        style: {
          graphicName: 'circle',
          pointRadius: 11,
          fillColor: '${getAuditFill}',
          fillOpacity: '${getAuditFillOpacity}',
          strokeColor: '#b04ce6',
          strokeWidth: 3,
          strokeOpacity: 1,
          label: '${getAuditLabel}',
          fontColor: '#3d0a4d',
          fontWeight: 'bold',
          labelOutlineColor: '#ffffff',
          labelOutlineWidth: 2
        }
      }]
    });

    for (const layerName of [SDK_LAYER_NAME, SDK_STREETNAMES_LAYER_NAME, SDK_AUDIT_LAYER_NAME]) {
      wmeSDK.Map.setLayerVisibility({ layerName, visibility: false });
    }
  }

  // wz-checkbox exposes its state as an attribute, not a .checked property. Module
  // scope because both the main panel and the NavPoints overlay need them.
  const isChecked  = (el) => el?.hasAttribute('checked');
  const setChecked = (el, v) => v ? el.setAttribute('checked', '') : el.removeAttribute('checked');

  // NavPoints overlay: dashed line from each Waze house-number pin to its anchor on
  // the segment. Self-contained by construction — it takes the sidebar pane and
  // otherwise touches only module-scope helpers, so it lives outside init() rather
  // than adding 167 lines to that scope. Keep it dependency-free.
  function setupNavPoints(tabPane) {
    const chkNavPoints = tabPane.querySelector('#qhnsl-navpoints');
    if (!chkNavPoints) return;

    let lastNavIds = [];
    let currentRenderId = 0;
    let renderTimer = null;

    wmeSDK.Map.addLayer({
      layerName: SDK_NAVPOINTS_LAYER_NAME,
      zIndexing: true,
      styleContext: {
        getColor: ({ feature }) => {
          const p = feature.properties;
          if (p.forced)  return p.touched ? '#ff9933' : '#ff3333';
          return p.touched ? '#ffffff' : '#ffdd00';
        },
        getLabel: ({ feature }) => String(feature.properties.number ?? '')
      },
      styleRules: [
        {
          predicate: (featureProperties) => featureProperties.kind === 'line',
          style: {
            strokeColor: '${getColor}',
            strokeWidth: 2,
            strokeOpacity: 0.9,
            strokeDashstyle: 'dash',
            fill: false
          }
        },
        {
          predicate: (featureProperties) => featureProperties.kind === 'label',
          style: {
            label: '${getLabel}',
            fontColor: '#111111',
            fontSize: '12px',
            fontWeight: 'bold',
            fontFamily: '"Open Sans", Arial, sans-serif',
            labelOutlineColor: '${getColor}',
            labelOutlineWidth: 3,
            labelOutlineOpacity: 1,
            pointRadius: 0,
            stroke: false,
            fill: false
          }
        }
      ]
    });

    function clearNavLayer() {
      if (!lastNavIds.length) return;
      try {
        wmeSDK.Map.removeFeaturesFromLayer({ layerName: SDK_NAVPOINTS_LAYER_NAME, featureIds: lastNavIds });
      } catch (e) {
        console.debug('[SL-HN] NavPoints clearLayer:', e);
      }
      lastNavIds = [];
    }

    async function renderNavPoints() {
      // Bump the generation BEFORE bailing out, or an in-flight render started at a
      // higher zoom finishes its await, still passes its own generation check, and
      // draws NavPoints onto a map that has since zoomed out past the threshold.
      // The checkbox handler already does this; these early exits must match.
      if (!LS.getNavPoints()) { currentRenderId++; clearNavLayer(); return; }
      if (wmeSDK.Map.getZoomLevel() < MIN_OVERLAY_ZOOM) { currentRenderId++; clearNavLayer(); return; }

      const myRenderId = ++currentRenderId;

      const segIds = wmeSDK.DataModel.Segments.getAll()
        .filter(s => s.hasHouseNumbers)
        .map(s => s.id);

      if (!segIds.length) { clearNavLayer(); return; }

      let allHns;
      try {
        allHns = await wmeSDK.DataModel.HouseNumbers.fetchHouseNumbers({ segmentIds: segIds });
      } catch (err) {
        console.warn('[SL-HN] NavPoints fetch failed:', err);
        return;
      }

      if (myRenderId !== currentRenderId) return;

      const features = [];
      for (const hn of allHns) {
        const touched = hn.updatedBy != null;
        const forced = hn.isForced === true;
        if (hn.fractionPoint?.coordinates && hn.geometry?.coordinates) {
          features.push({
            type: 'Feature',
            id: `navp-${hn.id}-line`,
            geometry: {
              type: 'LineString',
              coordinates: [hn.fractionPoint.coordinates, hn.geometry.coordinates]
            },
            properties: { kind: 'line', touched, forced }
          });
        }
        if (hn.geometry?.coordinates) {
          features.push({
            type: 'Feature',
            id: `navp-${hn.id}-label`,
            geometry: hn.geometry,
            properties: { kind: 'label', number: hn.number, touched, forced }
          });
        }
      }

      if (lastNavIds.length) {
        try {
          wmeSDK.Map.removeFeaturesFromLayer({ layerName: SDK_NAVPOINTS_LAYER_NAME, featureIds: lastNavIds });
        } catch (e) {
          console.debug('[SL-HN] NavPoints swap-clear:', e);
        }
      }

      if (features.length) {
        try {
          wmeSDK.Map.addFeaturesToLayer({ layerName: SDK_NAVPOINTS_LAYER_NAME, features });
        } catch (e) {
          console.warn('[SL-HN] NavPoints addFeaturesToLayer:', e);
          lastNavIds = [];
          return;
        }
      }

      lastNavIds = features.map(f => f.id);
    }

    function scheduleRender() {
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = setTimeout(() => {
        renderTimer = null;
        renderNavPoints().catch(err => console.warn('[SL-HN] NavPoints render failed:', err));
      }, 300);
    }

    chkNavPoints.addEventListener('click', () => {
      const on = !isChecked(chkNavPoints);
      setChecked(chkNavPoints, on);
      LS.setNavPoints(on);
      if (on) {
        scheduleRender();
      } else {
        currentRenderId++; // invalidate any in-flight render so it can't re-add features
        clearNavLayer();
      }
    });

    if (LS.getNavPoints()) scheduleRender();

    const NAVPOINTS_TRIGGER_EVENTS = [
      'wme-map-zoom-changed',
      'wme-map-move-end',
      'wme-house-number-added',
      'wme-house-number-deleted',
      'wme-house-number-moved',
      'wme-house-number-updated',
      'wme-map-data-loaded'
    ];
    NAVPOINTS_TRIGGER_EVENTS.forEach(eventName => {
      wmeSDK.Events.on({
        eventName,
        eventHandler: () => {
          if (LS.getNavPoints()) scheduleRender();
        }
      });
    });
  }

  function init() {
    let currentStreetId = null;
    // EPSG:3794 bbox eProstor was last fetched for. Outside it we have no reference
    // data, so the audit must stay silent rather than claim a number is missing.
    // Auto-load also uses it to tell whether a selection is already covered.
    let lastLoadedBbox = null;
    let autoLoadTimer = null;
    // When the map last panned or zoomed, so a click belonging to that gesture can be
    // told apart from a deliberate one.
    let lastMapMovedAt = 0;
    // The script's own setSelection calls raise wme-selection-changed. Without a
    // suppression window auto-load re-enters on them and reloads underneath the
    // user — closing the fix-street dialog mid-decision, or wiping the audit
    // findings on the very click meant to inspect one.
    let suppressAutoLoadUntil = 0;
    function markSelfSelection() {
      suppressAutoLoadUntil = Date.now() + 2000;
    }
    let streetNames = {};
    let streets = {};
    let lastFeatures = [];
    let fixStreetHighlightStreetId = null; // official street ID whose HNs are highlighted during fix-street flow
    let lastAuditFindings = [];
    let isLoading = false;
    let currentLoadId = 0;

    // One record per map overlay, replacing three parallel sets of variables.
    //   wanted — the user's toggle for this overlay
    //   shown  — what we last told the SDK, so we only call it on a real change
    //   ids    — the feature ids currently on the layer
    // Per-overlay quirks (the zoom toast, lifting labels above other scripts) stay
    // at their call sites rather than becoming fields here.
    // Namespaced deliberately: `hn` alone is used ~78 times in this file to mean
    // "house number", so a bare `hn` overlay would shadow and mislead.
    const overlays = {
      hn:     { name: SDK_LAYER_NAME,             wanted: false,               shown: false, ids: [] },
      labels: { name: SDK_STREETNAMES_LAYER_NAME, wanted: LS.getStreetNames(), shown: false, ids: [] },
      audit:  { name: SDK_AUDIT_LAYER_NAME,       wanted: LS.getAudit(),       shown: false, ids: [] }
    };

    // Replace a layer's features in one step.
    //
    // Failures are contained here rather than at each call site. Rendering is
    // display-only, but applyFeatureFilter runs inside addHouseNumberToSegment's try
    // block — so an escaping throw would report a house number that was genuinely
    // added as a failure. Two of the three call sites wrapped this; the house-number
    // one did not, which is exactly the kind of gap a central guarantee closes.
    //
    // Ids are recorded before the add: if it throws part-way, some features may
    // already be on the layer, and later removing an id that was never added is
    // harmless, while leaving an orphan behind is not.
    function setOverlayFeatures(overlay, features) {
      try {
        if (overlay.ids.length) {
          wmeSDK.Map.removeFeaturesFromLayer({ layerName: overlay.name, featureIds: overlay.ids });
          overlay.ids = [];
        }
        if (!features.length) return;
        overlay.ids = features.map(f => f.id);
        wmeSDK.Map.addFeaturesToLayer({ layerName: overlay.name, features });
      } catch (e) {
        console.warn(`[SL-HN] rendering ${overlay.name} failed:`, e);
      }
    }
    let streetNameSpan = null;
    let currentStreetDiv = null;
    let streetAnalysisDiv = null;
    let auditSummaryDiv = null;

    // Track unsaved house-number edits this session. fetchHouseNumbers reflects the
    // SAVED state only: it keeps returning pending-deleted HNs and omits pending-added
    // ones until the editor saves. We layer our own edits on top, keyed by the stable
    // houseNumberId the SDK events provide.
    const deletedHnIds = new Set();     // HNs deleted this session (still in saved model until save)
    const sessionAddedKeys = new Set(); // feature keys we added this session (not yet in saved model)
    const hnIdToAddedKey = new Map();   // added houseNumberId -> feature key, to undo on later delete
    let pendingAddKey = null;           // set just before addHouseNumber, consumed by the added event
    const featKey = makeFeatKey;

    let chkMissing = null;
    let chkSelectedOnly = null;

    let applyFeatureFilter = () => {};
    let analyzeStreetMatches = () => {};
    // Assigned when the panel is built. Needed out here so updateLayerVisibility can
    // re-render the audit when its layer becomes visible or hidden.
    let renderAuditFindings = () => {};

    try {
      I18n.translations[I18n.currentLocale()].layers.name['quick-hn-sl-importer'] = 'Quick HN Importer';
    } catch (_) {}

    createOverlayLayers();

    // Baseline z-index: above WME's own labels but below the segment-interaction
    // layer, so segments stay clickable even if the click-through step below never
    // succeeds.
    try { wmeSDK.Map.setLayerZIndex({ layerName: SDK_STREETNAMES_LAYER_NAME, zIndex: 1000 }); } catch (_) {}

    // The label layer is display-only (dot clicks go through wme-map-mouse-click,
    // not the layer). Mark its DOM node pointer-events:none so it never swallows
    // segment clicks, then — and only then — lift it above every other overlay
    // (WME Toolbox speed limits, etc.). Raising the z-index before neutralizing
    // pointer events would block segment selection across the whole map.
    //
    // OpenLayers recomputes every layer's z-index whenever a layer is added or
    // removed, so a script loading after us silently drops our labels back down.
    // Re-assert on each redraw/pan/zoom instead of setting this once.
    let labelLayerDiv = null;
    function liftLabelLayer() {
      try {
        // A cached node that has been detached (map re-init, another script
        // re-adding layers) must be re-resolved: writing pointer-events to the dead
        // node while lifting the live layer to z-index 10000 would put a
        // full-viewport click-swallowing div over the whole editor.
        if (labelLayerDiv && !labelLayerDiv.isConnected) labelLayerDiv = null;
        if (!labelLayerDiv) {
          // W.map is a WMEMap wrapper; the OpenLayers map (with .layers) is behind getOLMap().
          const wmeMap = (unsafeWindow || window).W?.map;
          const layers = wmeMap?.getOLMap?.()?.layers;
          const layer = layers?.find(l => [l?.name, l?.uniqueName].some(
            n => typeof n === 'string' && n.includes(SDK_STREETNAMES_LAYER_NAME)));
          if (!layer?.div) return;
          labelLayerDiv = layer.div;
        }
        labelLayerDiv.style.pointerEvents = 'none';
        wmeSDK.Map.setLayerZIndex({ layerName: SDK_STREETNAMES_LAYER_NAME, zIndex: 10000 });
      } catch (_) {}
    }
    liftLabelLayer();

    function updateLayerVisibility() {
      const auditWasShown = overlays.audit.shown;
      const zoomOk = wmeSDK.Map.getZoomLevel() >= MIN_OVERLAY_ZOOM;
      // hn is the base gate; the other two ride it plus their own toggle.
      const hnVisible = overlays.hn.wanted && zoomOk;
      const desired = new Map([
        [overlays.hn, hnVisible],
        [overlays.labels, hnVisible && overlays.labels.wanted],
        [overlays.audit, hnVisible && overlays.audit.wanted]
      ]);

      for (const [overlay, visible] of desired) {
        if (visible === overlay.shown) continue;
        // Record only after the SDK accepted it. Setting `shown` first meant one
        // failed call left the flag lying forever — and since the loop skips on
        // `visible === overlay.shown`, nothing would ever retry. handleMapClick trusts
        // `shown`, so it would hit-test circles the user cannot see and a click on
        // apparently empty map would add a house number.
        try {
          wmeSDK.Map.setLayerVisibility({ layerName: overlay.name, visibility: visible });
        } catch (e) {
          console.warn(`[SL-HN] could not change visibility of ${overlay.name}:`, e);
          continue;
        }
        overlay.shown = visible;
        // Only the base layer explains itself: hiding the other two is always a
        // deliberate toggle, never a surprise.
        if (overlay === overlays.hn && overlays.hn.wanted && !visible && lastFeatures.length > 0) {
          toast(`Zoom in to level ${MIN_OVERLAY_ZOOM}+ to see house numbers`, 'info');
        }
      }

      // Runs on every pan/zoom, not just on change: reclaims the top spot if another
      // script's layer load reshuffled z-indexes since the last time we looked.
      if (desired.get(overlays.labels)) liftLabelLayer();

      // The audit renders only while its layer is shown, so a flip either way needs a
      // re-render: to populate markers on becoming visible, and to drop the summary
      // on becoming hidden.
      if (overlays.audit.shown !== auditWasShown) renderAuditFindings();
    }

    const onMapMoved = () => {
      lastMapMovedAt = Date.now();
      updateLayerVisibility();
    };
    wmeSDK.Events.on({ eventName: 'wme-map-zoom-changed', eventHandler: onMapMoved });
    wmeSDK.Events.on({ eventName: 'wme-map-move-end', eventHandler: onMapMoved });
    wmeSDK.Events.on({ eventName: 'wme-selection-changed', eventHandler: onSelectionChanged });

    // Get current WME street name from selection
    function getWmeStreetName() {
      const selectedSegments = getSelectedSegments();
      if (selectedSegments.length === 0) return null;

      const seg = selectedSegments[0];
      const primaryStreetId = seg.primaryStreetId;
      if (!primaryStreetId) return null;

      const street = wmeSDK.DataModel.Streets.getById({ streetId: primaryStreetId });
      return street?.name || null;
    }

    // Analyze street name matches and update UI
    analyzeStreetMatches = function() {
      if (!streetAnalysisDiv) return;
      if (!lastFeatures.length) {
        streetAnalysisDiv.style.display = 'none';
        return;
      }

      const wmeStreetName = getWmeStreetName();

      // Count addresses per official street name
      const streetCounts = {};
      lastFeatures.forEach(f => {
        const name = streetNames[f.street];
        if (!name) return;
        streetCounts[name] = (streetCounts[name] || 0) + 1;
      });

      // Sort by count descending
      // Always order by number of loaded HNs (desc), then alphabetically for stability
      const sorted = Object.entries(streetCounts)
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

      if (sorted.length === 0) {
        streetAnalysisDiv.style.display = 'none';
        return;
      }

      // Check how many match current WME street
      const matchCount = wmeStreetName ? (streetCounts[wmeStreetName] || 0) : 0;
      const hasMismatch = wmeStreetName && matchCount === 0 && sorted.length > 0;

      // Find fuzzy match if there's a mismatch
      let suggestedMatch = null;
      let suggestionSimilarity = 0;

      if (hasMismatch && wmeStreetName) {
        for (const [name] of sorted) {
          const similarity = calculateSimilarity(wmeStreetName, name);
          if (similarity > 0.7 && similarity > suggestionSimilarity) {
            suggestedMatch = name;
            suggestionSimilarity = similarity;
          }
        }
      }

      // Build HTML
      let html = '';

      if (hasMismatch) {
        html += `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:8px;margin-bottom:8px;">`;
        html += `<b style="color:#856404;">⚠️ No matching addresses found!</b><br/>`;
        html += `<span style="font-size:11px;color:#856404;">WME street name doesn't match any official names</span>`;
        html += `</div>`;

        if (suggestedMatch) {
          const escapedSuggested = escapeHtml(suggestedMatch);
          html += `<div style="background:#d4edda;border:1px solid #28a745;border-radius:4px;padding:8px;margin-bottom:8px;">`;
          html += `<b style="color:#155724;">💡 Possible match found:</b><br/>`;
          html += `<div style="margin:4px 0;font-size:12px;">`;
          html += `<span style="color:#666;">WME:</span> <span style="color:#dc3545;text-decoration:line-through;">${escapeHtml(wmeStreetName)}</span><br/>`;
          html += `<span style="color:#666;">Official:</span> <b style="color:#155724;">${escapedSuggested}</b>`;
          html += `</div>`;
          html += `<div style="display:flex;gap:6px;margin-top:6px;">`;
          html += `<button class="wz-button update-street-btn" data-street="${escapedSuggested}" style="font-size:11px;padding:2px 8px;">✓ Use official name</button>`;
          html += `<button class="copy-street-btn" data-street="${escapedSuggested}" style="font-size:11px;padding:2px 8px;background:#f8f8f8;border:1px solid #ccc;border-radius:3px;cursor:pointer;">📋 Copy</button>`;
          html += `</div>`;
          html += `</div>`;
        }
      }

      html += `<div style="font-size:12px;margin-bottom:4px;"><b>Official streets in area:</b></div>`;
      html += `<div style="max-height:150px;overflow-y:auto;border:1px solid #ddd;border-radius:4px;background:#fafafa;">`;

      sorted.forEach(([name, _count], index) => {
        const isMatch = name === wmeStreetName;
        const isSuggestion = name === suggestedMatch;
        const escapedName = escapeHtml(name);

        let rowStyle = 'padding:4px 8px;font-size:11px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;';
        if (isMatch) rowStyle += 'background:#d4edda;';
        else if (isSuggestion) rowStyle += 'background:#fff3cd;';
        else if (index % 2 === 0) rowStyle += 'background:#f8f8f8;';

        html += `<div style="${rowStyle}">`;
        html += `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapedName}">`;
        if (isMatch) html += '✓ ';
        if (isSuggestion) html += '→ ';
        html += `${escapedName}</span>`;
        html += `<span style="margin-left:8px;white-space:nowrap;display:flex;align-items:center;gap:4px;">`;
        // Always show the update button - if already matched, show as disabled-looking but still clickable
        const btnStyle = isMatch
          ? 'padding:1px 4px;font-size:10px;cursor:default;border:1px solid #ccc;border-radius:2px;background:#e9e9e9;color:#999;'
          : 'padding:1px 4px;font-size:10px;cursor:pointer;border:1px solid #28a745;border-radius:2px;background:#d4edda;color:#155724;';
        html += `<button class="update-street-btn" data-street="${escapedName}" style="${btnStyle}" title="${isMatch ? 'Already set' : 'Use this name'}">${isMatch ? '✓' : '→'}</button>`;
        html += `<button class="copy-street-btn" data-street="${escapedName}" style="padding:1px 4px;font-size:10px;cursor:pointer;border:1px solid #ccc;border-radius:2px;background:#fff;" title="Copy to clipboard">📋</button>`;
        html += `</span>`;
        html += `</div>`;
      });

      html += `</div>`;
      html += `<div style="font-size:10px;color:#888;margin-top:4px;">→ = apply name • 📋 = copy</div>`;

      streetAnalysisDiv.innerHTML = html;
      streetAnalysisDiv.style.display = 'block';

      // Add click handlers for copy buttons
      streetAnalysisDiv.querySelectorAll('.copy-street-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const streetName = btn.getAttribute('data-street');
          copyToClipboard(streetName);
        });
      });

      // Add click handlers for update buttons
      streetAnalysisDiv.querySelectorAll('.update-street-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const streetName = btn.getAttribute('data-street');

          // Skip only when EVERY selected segment already carries this name —
          // the rename applies to the whole selection, so a mixed selection
          // whose first segment happens to be correct must still proceed.
          const selectedSegments = getSelectedSegments();
          const allAlreadySet = selectedSegments.length > 0 && selectedSegments.every(seg => {
            const street = seg.primaryStreetId
              ? wmeSDK.DataModel.Streets.getById({ streetId: seg.primaryStreetId })
              : null;
            return street?.name === streetName;
          });
          if (allAlreadySet) {
            toast('Street name already set', 'info');
            return;
          }

          updateSegmentStreetName(streetName, () => {
            // After successful update, refresh the current street state
            // Find the street ID for the new street name
            const newStreetId = streets[streetName];
            if (newStreetId) {
              currentStreetId = newStreetId;
              showCurrentStreet(streetName);
            }

            // Re-analyze and redraw with updated state
            setTimeout(() => {
              analyzeStreetMatches();
              applyFeatureFilter();
            }, 100);
          });
        });
      });
    };

    // Show/hide the "Current street" badge — the only place its DOM is touched.
    function showCurrentStreet(name) {
      if (streetNameSpan && currentStreetDiv) {
        streetNameSpan.textContent = name;
        currentStreetDiv.style.display = 'block';
      }
    }

    function hideCurrentStreet() {
      if (streetNameSpan && currentStreetDiv) {
        streetNameSpan.textContent = '—';
        currentStreetDiv.style.display = 'none';
      }
    }

    // Map a set of WME street IDs to the loaded register street with the most
    // house numbers. Shared by selection changes and the initial load.
    function findBestMatchingStreetId(wmeStreetIds, featureList) {
      const names = Array.from(wmeStreetIds)
        .map(id => wmeSDK.DataModel.Streets.getById({ streetId: id })?.name)
        .filter(Boolean);

      let bestId = null;
      let bestCount = -1;
      names.forEach(name => {
        const sid = streets[name];
        if (!sid) return;
        const count = featureList.reduce((n, f) => n + (f.street === sid ? 1 : 0), 0);
        if (count > bestCount) {
          bestCount = count;
          bestId = sid;
        }
      });
      return bestId;
    }

    function onSelectionChanged() {
      if (!lastFeatures.length) return;

      const selectedSegments = getSelectedSegments();
      if (selectedSegments.length === 0) {
        return;
      }

      const selectedStreetIds = new Set();

      selectedSegments.forEach(seg => {
        const psid = seg.primaryStreetId;
        if (psid && psid > 0) selectedStreetIds.add(psid);
        (seg.alternateStreetIds || []).forEach(id => {
          if (id && id > 0) selectedStreetIds.add(id);
        });
      });

      const newStreetId = selectedStreetIds.size > 0
        ? findBestMatchingStreetId(selectedStreetIds, lastFeatures)
        : null;

      if (!newStreetId) {
        currentStreetId = null;
        hideCurrentStreet();
        applyFeatureFilter();
        analyzeStreetMatches();
        return;
      }

      // Always update state and refresh UI, even if street is the same
      // (because we might be on a different segment with the same street)
      currentStreetId = newStreetId;

      if (streetNames[currentStreetId]) {
        showCurrentStreet(streetNames[currentStreetId]);
      }

      applyFeatureFilter();
      analyzeStreetMatches();
    }


    // Single source of truth for which loaded HNs are currently drawn on the map.
    // Used by both the layer redraw and the click hit-test so that circles hidden
    // by the checkbox filters are never clickable.
    function isFeatureVisible(feat) {
      if (chkMissing?.hasAttribute('checked') && feat.processed) return false;
      if (chkSelectedOnly?.hasAttribute('checked') && currentStreetId
          && feat.street !== currentStreetId && feat.street !== fixStreetHighlightStreetId) return false;
      return true;
    }

    // Mirrors isFeatureVisible for audit markers, so the checkbox filters hide them
    // and — because the hit-test consults this too — a filtered-out marker can no
    // longer hijack a click and drag the user onto a street they filtered away.
    function isAuditFindingVisible(finding) {
      if (chkSelectedOnly?.hasAttribute('checked') && currentStreetId) {
        const keys = finding.streetKeys || [];
        if (!keys.includes(currentStreetId)) return false;
      }
      return true;
    }

    function onAuditFindingClick(finding) {
      // Close any open fix-street dialog first, exactly as onFeatureClick does. That
      // dialog's Rename button acts on the *current* selection, and this function is
      // about to change it — leaving the dialog open would rename the segment the user
      // clicked to inspect, into a street name they never chose for it.
      clearFixStreetState();

      try {
        wmeSDK.Map.setMapCenter({ lonLat: { lon: finding.lon, lat: finding.lat } });
      } catch (e) {
        console.debug('[SL-HN] setMapCenter failed:', e);
      }
      try {
        markSelfSelection();
        wmeSDK.Editing.setSelection({
          selection: { ids: [finding.segmentId], objectType: 'segment' }
        });
      } catch (e) {
        console.warn('[SL-HN] could not select segment for audit finding:', e);
        return;
      }
      const what = finding.type === 'missing'
        ? `"${finding.number}" is not in eProstor for this street`
        : `"${finding.number}" is more than ${AUDIT_MAX_DISTANCE} m from its eProstor point`;
      toast(`${what} — segment selected`, 'info');
    }

    function handleMapClick(evt) {
      // overlays.hn.shown is false when the layer is hidden (e.g. zoom < 18):
      // no visible circles means clicks must do nothing.
      if (!overlays.hn.wanted || !overlays.hn.shown || !lastFeatures.length) return;
      if (evt == null || evt.x == null || evt.y == null) return;

      // A pan or zoom ends in a mouse-up that also arrives here as a click. Acting on
      // it means adding a house number, or recentring on an audit marker, purely
      // because the user moved the map. Nobody pans and then deliberately clicks
      // inside this window, so ignoring it costs nothing.
      if (Date.now() - lastMapMovedAt < CLICK_AFTER_MOVE_GRACE_MS) return;

      const MAX_PIXELS_SQ = MAX_CLICK_DISTANCE_PX * MAX_CLICK_DISTANCE_PX;

      // Nearest audit marker, if the audit is live. Resolved against the nearest
      // eProstor circle below rather than short-circuiting here: a 'missing'
      // finding is by definition NOT co-located with an eProstor point, so
      // winning on mere presence would make the neighbouring address unclickable.
      let bestAudit = null;
      let bestAuditDistSq = Infinity;
      if (overlays.audit.wanted && overlays.audit.shown && lastAuditFindings.length) {
        for (const f of lastAuditFindings) {
          if (!isAuditFindingVisible(f)) continue;
          const px = wmeSDK.Map.getMapPixelFromLonLat({ lonLat: { lon: f.lon, lat: f.lat } });
          if (!px) continue;
          const dx = px.x - evt.x;
          const dy = px.y - evt.y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= MAX_PIXELS_SQ && d2 < bestAuditDistSq) {
            bestAuditDistSq = d2;
            bestAudit = f;
          }
        }
      }
      let bestFeature = null;
      let bestDistSq = Infinity;

      for (const f of lastFeatures) {
        if (f.lon == null || f.lat == null) continue;
        if (!isFeatureVisible(f)) continue;
        const fPx = wmeSDK.Map.getMapPixelFromLonLat({ lonLat: { lon: f.lon, lat: f.lat } });
        if (!fPx) continue;
        const dx = fPx.x - evt.x;
        const dy = fPx.y - evt.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= MAX_PIXELS_SQ && d2 < bestDistSq) {
          bestDistSq = d2;
          bestFeature = f;
        }
      }

      // Closest wins. Ties go to the audit, since an audit marker overlapping an
      // eProstor circle means the two concern the same address.
      if (bestAudit && bestAuditDistSq <= bestDistSq) {
        onAuditFindingClick(bestAudit);
        return;
      }

      if (!bestFeature) return;
      onFeatureClick(bestFeature);
    }

    wmeSDK.Events.on({ eventName: 'wme-map-mouse-click', eventHandler: handleMapClick });

    function onFeatureClick(feature) {
      // Clear AFTER deciding we will act, not before. A click that does nothing —
      // most often on an already-added, faded circle — used to close an open
      // fix-street dialog anyway, which looked like the dialog dismissing itself
      // whenever the map was nudged.
      if (feature.processed) return;

      // A click that will act supersedes any open fix-street dialog.
      clearFixStreetState();

      const streetName = streetNames[feature.street];

      const named = findNearestSegment(feature, streetName, true);
      const nearest = findNearestSegment(feature, streetName, false);

      if (named) {
        // The official street exists — but when it is much farther away than the
        // closest differently-named segment, that closer segment is probably the
        // real street carrying a wrong or missing name. Ask instead of silently
        // adding the HN far from the house.
        const suspiciouslyFar = nearest
          && nearest.segment.id !== named.segment.id
          && named.distance > FAR_STREET_MIN_DISTANCE
          && named.distance > FAR_STREET_RATIO * nearest.distance;

        if (!suspiciouslyFar) {
          addHouseNumberToSegment(feature, named.segment);
          return;
        }

        startFixStreetFlow(feature, streetName, named.segment, {
          farDistance: named.distance,
          nearestDistance: nearest.distance
        });
        return;
      }

      if (!nearest) {
        toast('No nearby segment found', 'warning');
        return;
      }

      startFixStreetFlow(feature, streetName, nearest.segment);
    }

    // Attach a house number to a segment (shared by direct add, "add anyway" and post-rename auto-add)
    function addHouseNumberToSegment(feature, segment) {
      markSelfSelection();
      wmeSDK.Editing.setSelection({ selection: { ids: [segment.id], objectType: 'segment' } });

      const key = featKey(feature.street, feature.number, feature.eX, feature.eY);
      // Set before the call so a synchronous added-event can pair the new id with this feature.
      pendingAddKey = key;
      try {
        wmeSDK.DataModel.HouseNumbers.addHouseNumber({
          number: feature.number,
          point: { type: 'Point', coordinates: [feature.lon, feature.lat] },
          segmentId: segment.id
        });

        // Remember this add: fetchHouseNumbers won't report it until the editor saves.
        sessionAddedKeys.add(key);
        feature.processed = true;
        feature.conflict = false;
        applyFeatureFilter();

        console.log('[SL-HN] Added house number', feature.number);
        toast(`Added house number ${feature.number}`, 'success');
      } catch (err) {
        pendingAddKey = null;
        console.error('[SL-HN] Error adding house number:', err);
        toast('Error adding house number. See console.', 'error');
      }
    }

    // Close the fix-street dialog and remove the blue HN highlight
    function clearFixStreetState() {
      closeFixStreetDialog();
      if (fixStreetHighlightStreetId !== null) {
        fixStreetHighlightStreetId = null;
        applyFeatureFilter();
      }
    }

    // Official street name missing in WME (or only found suspiciously far away):
    // preview affected segments and offer a one-click rename. addAnywaySegment is
    // where "Add anyway" attaches the HN; farInfo = { farDistance, nearestDistance }
    // marks the far-match variant.
    function startFixStreetFlow(feature, officialName, addAnywaySegment, farInfo) {
      const matchedHNs = lastFeatures.filter(f => f.street === feature.street);

      // Candidate segments = nearest segment to each matched HN, minus ones already named correctly
      const officialLower = officialName.toLowerCase();
      const candidateIds = new Set();
      matchedHNs.forEach(f => {
        const found = findNearestSegment(f, null, false);
        if (!found) return;
        const seg = found.segment;
        const street = seg.primaryStreetId
          ? wmeSDK.DataModel.Streets.getById({ streetId: seg.primaryStreetId })
          : null;
        if (street?.name && street.name.toLowerCase() === officialLower) return;
        candidateIds.add(seg.id);
      });

      const segmentIds = [...candidateIds];
      if (segmentIds.length > 0) {
        markSelfSelection();
        wmeSDK.Editing.setSelection({ selection: { ids: segmentIds, objectType: 'segment' } });
      }

      fixStreetHighlightStreetId = feature.street;
      applyFeatureFilter();

      const addAnywayStreet = addAnywaySegment.primaryStreetId
        ? wmeSDK.DataModel.Streets.getById({ streetId: addAnywaySegment.primaryStreetId })
        : null;

      showFixStreetDialog({
        officialName,
        hnCount: matchedHNs.length,
        segmentCount: segmentIds.length,
        nearestStreetName: addAnywayStreet?.name || null,
        farInfo,
        onRename: () => {
          // Renames whatever is selected NOW (user may have adjusted the selection)
          const renamed = updateSegmentStreetName(officialName, null);
          if (renamed === 0) return; // nothing renamed (empty selection / all failed): keep dialog open

          // Make the renamed street the current one so its circles turn green immediately
          // (updateAddress fires no selection event, so onSelectionChanged won't do it for us)
          const newStreetId = streets[officialName];
          if (newStreetId) {
            currentStreetId = newStreetId;
            showCurrentStreet(officialName);
          }

          clearFixStreetState(); // repaints via applyFeatureFilter
          analyzeStreetMatches();

          // Renamed segments now match the official name; auto-add the clicked HN
          const found = findNearestSegment(feature, officialName, true);
          if (found) {
            addHouseNumberToSegment(feature, found.segment);
          } else {
            toast('Street renamed — click the house number again to add it', 'info');
          }
        },
        onAddAnyway: () => {
          clearFixStreetState();
          addHouseNumberToSegment(feature, addAnywaySegment);
        },
        onCancel: () => {
          clearFixStreetState();
        }
      });
    }

    const loading = document.createElement('div');
    loading.style.position = 'absolute';
    loading.style.bottom = '35px';
    loading.style.width = '100%';
    loading.style.pointerEvents = 'none';
    loading.style.display = 'none';
    loading.innerHTML =
      '<div style="margin:0 auto; max-width:300px; text-align:center; background:rgba(0, 0, 0, 0.5); color:white; border-radius:3px; padding:5px 15px;"><i class="fa fa-pulse fa-spinner"></i> Loading address points</div>';
    document.getElementById('map').appendChild(loading);

    wmeSDK.Sidebar.registerScriptTab().then(({ tabLabel, tabPane }) => {
      tabLabel.innerText = 'SL-HN';
      tabLabel.title = 'Quick HN Importer (Slovenia)';

      tabPane.innerHTML = `
        <div id="qhnsl-pane" style="padding:10px;">
          <h2 style="margin-top:0;">Quick HN Importer 🇸🇮</h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px 0;">
            <button id="hn-load" class="wz-button"><span id="hn-load-label">Load selected street</span> <kbd style="margin-left:6px;font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:rgba(0,0,0,0.08);border-radius:3px;padding:2px 5px;color:#555;">Alt+Shift+L</kbd></button>
            <button id="hn-clear" class="wz-button wz-button--secondary">Clear <kbd style="margin-left:6px;font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:rgba(0,0,0,0.08);border-radius:3px;padding:2px 5px;color:#555;">Alt+Shift+K</kbd></button>
          </div>
          <div id="hn-current-street" style="margin:8px 0;padding:8px;background:#f0f0f0;border-radius:4px;font-size:13px;display:none;">
            <b>WME selected street:</b> <span id="hn-street-name" style="color:#2a7;font-weight:bold;">—</span>
          </div>
          <div id="hn-street-analysis" style="margin:8px 0;display:none;"></div>
          <div id="hn-audit-summary" style="margin:8px 0;display:none;font-size:12px;"></div>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <wz-checkbox id="hn-toggle">Show layer</wz-checkbox>
            <wz-checkbox id="qhnsl-missing">Show only missing</wz-checkbox>
            <wz-checkbox id="qhnsl-selected-only">Selected street only</wz-checkbox>
            <wz-checkbox id="qhnsl-street-names">Show street names</wz-checkbox>
            <wz-checkbox id="qhnsl-audit">Show WME HN audit</wz-checkbox>
            <wz-checkbox id="qhnsl-autoload">Auto-load on street select</wz-checkbox>
            <wz-checkbox id="qhnsl-navpoints">Show HN NavPoints</wz-checkbox>
            <span style="font-size:12px;">Buffer (m): <input id="qhnsl-buffer" type="number" min="0" step="50" style="width:80px;margin-left:6px"></span>
          </div>
          <div id="hn-status" style="margin-top:10px;font-size:12px;color:#666;line-height:1.4;">${INSTRUCTIONS_HTML}</div>
        </div>
      `;

      const btnLoad      = tabPane.querySelector('#hn-load');
      const btnLoadLabel = tabPane.querySelector('#hn-load-label');
      const btnClear     = tabPane.querySelector('#hn-clear');
      const chkVis = tabPane.querySelector('#hn-toggle');
      chkMissing = tabPane.querySelector('#qhnsl-missing');
      chkSelectedOnly = tabPane.querySelector('#qhnsl-selected-only');
      const chkStreetNames = tabPane.querySelector('#qhnsl-street-names');
      const chkAudit = tabPane.querySelector('#qhnsl-audit');
      const chkAutoLoad = tabPane.querySelector('#qhnsl-autoload');
      const chkNavPoints = tabPane.querySelector('#qhnsl-navpoints');
      const bufferEl   = tabPane.querySelector('#qhnsl-buffer');
      const statusDiv  = tabPane.querySelector('#hn-status');

      currentStreetDiv = tabPane.querySelector('#hn-current-street');
      streetNameSpan = tabPane.querySelector('#hn-street-name');
      streetAnalysisDiv = tabPane.querySelector('#hn-street-analysis');
      auditSummaryDiv = tabPane.querySelector('#hn-audit-summary');


      bufferEl.value = String(LS.getBuffer());
      if (LS.getLayerVisible()) {
        setChecked(chkVis, true);
        overlays.hn.wanted = true;
        updateLayerVisibility();
      }
      if (LS.getSelectedOnly()) {
        setChecked(chkSelectedOnly, true);
      }
      setChecked(chkStreetNames, overlays.labels.wanted);
      setChecked(chkAudit, overlays.audit.wanted);
      setChecked(chkAutoLoad, LS.getAutoLoad());
      setChecked(chkNavPoints, LS.getNavPoints());

      bufferEl.addEventListener('change', () => {
        const val = Number(bufferEl.value);
        if (!Number.isFinite(val) || val < 0) {
          bufferEl.value = String(LS.getBuffer());
          return;
        }
        LS.setBuffer(val);
      });

      chkVis.addEventListener('click', () => {
        const on = isChecked(chkVis);
        setChecked(chkVis, !on);
        overlays.hn.wanted = !on;
        LS.setLayerVisible(!on);
        updateLayerVisibility();
      });

      chkMissing.addEventListener('click', () => {
        setChecked(chkMissing, !isChecked(chkMissing));
        applyFeatureFilter();
      });

      chkStreetNames.addEventListener('click', () => {
        const on = !isChecked(chkStreetNames);
        setChecked(chkStreetNames, on);
        overlays.labels.wanted = on;
        LS.setStreetNames(on);
        updateLayerVisibility();
        // Label features are only built while the overlay is wanted, so turning it
        // back on has to rebuild them — changing visibility alone would show an
        // empty layer.
        applyFeatureFilter();
      });

      chkAudit.addEventListener('click', () => {
        const on = !isChecked(chkAudit);
        setChecked(chkAudit, on);
        overlays.audit.wanted = on;
        LS.setAudit(on);
        updateLayerVisibility();
        renderAuditFindings();
      });

      chkAutoLoad.addEventListener('click', () => {
        const on = !isChecked(chkAutoLoad);
        setChecked(chkAutoLoad, on);
        LS.setAutoLoad(on);
      });

      chkSelectedOnly.addEventListener('click', () => {
        const newState = !isChecked(chkSelectedOnly);
        setChecked(chkSelectedOnly, newState);
        LS.setSelectedOnly(newState);
        applyFeatureFilter();
      });

      // auto: true when triggered by selection change rather than by the user.
      // Callers must not be wired directly to an event, or the event object lands
      // in this options slot.
      async function loadSelectedStreet({ auto = false } = {}) {
        if (isLoading) return;
        // Validate before wiping anything — an accidental Alt+Shift+L with no
        // selection must not destroy the currently loaded street.
        if (getSelectedSegments().length === 0) {
          toast('Select a segment first.', 'warning');
          return;
        }
        clearFixStreetState();
        isLoading = true;
        const myLoadId = ++currentLoadId;

        // Everything below must run under try/finally. Without it a single throw —
        // an SDK removeFeaturesFromLayer, an unprotected DOM write — leaves isLoading
        // true forever, which rejects every later Load, silently kills auto-load, and
        // strands the button on "Loading…" until the page is reloaded.
        try {
          btnLoad.disabled = true;
          btnLoadLabel.textContent = 'Loading…';

          setOverlayFeatures(overlays.hn, []);
          setOverlayFeatures(overlays.labels, []);
          setOverlayFeatures(overlays.audit, []);
          lastAuditFindings = [];
          streets = {};
          streetNames = {};
          currentStreetId = null;
          lastFeatures = [];
          // Reset coverage too: until this load succeeds we hold no authoritative data,
          // and a stale box would let auto-load treat the area as already fetched.
          lastLoadedBbox = null;
          streetAnalysisDiv.style.display = 'none';
          if (auditSummaryDiv) auditSummaryDiv.style.display = 'none';

          await updateLayer(statusDiv, myLoadId).catch(err => console.warn('[SL-HN] updateLayer:', err));

          // Skip post-load side effects if user clicked Clear (or another Load) mid-fetch
          if (myLoadId === currentLoadId) {
            // Pressing Load is an explicit request to see the result, so it forces the
            // layer on. An auto-load is not: silently re-showing an overlay the user
            // hid, just because they selected a segment, would be surprising. The data
            // is loaded either way and appears as soon as they tick Show layer.
            if (!auto) {
              overlays.hn.wanted = true;
              setChecked(chkVis, true);
              LS.setLayerVisible(true);
            }
            updateLayerVisibility();
          }
        } finally {
          btnLoad.disabled = false;
          btnLoadLabel.textContent = 'Load selected street';
          isLoading = false;
        }
      }

      // Wrapped, not passed directly: the click event would arrive as the options argument.
      btnLoad.addEventListener('click', () => loadSelectedStreet());

      const selectionCoveredByLoadedBbox = (selected) => isSelectionInsideBbox(selected, lastLoadedBbox);

      // Auto-load fires on selection change, never on pan: updateLayer derives its
      // bbox from the selected segment, and auto-fetching per pan would hammer the
      // eProstor API far harder than the manual flow.
      // Defined here (not next to onSelectionChanged) because loadSelectedStreet
      // lives in this closure.
      function maybeAutoLoad() {
        if (!LS.getAutoLoad() || isLoading) return;

        const selected = getSelectedSegments();
        if (selected.length === 0) return;

        // Dedup on coverage, not street name. eProstor is fetched per bbox, so
        // "already loaded" is a question about area: a name key silently skipped
        // same-named streets elsewhere, never fired for alternate-name-only
        // segments, and went permanently stale when a load failed.
        if (selectionCoveredByLoadedBbox(selected)) return;

        // Debounce: click-dragging across segments must fire one fetch, not many.
        // The suppression window is deliberately NOT checked here — a real selection
        // arriving while one of our own setSelection calls is still settling used to be
        // dropped outright, and since every house-number add calls markSelfSelection,
        // click-add-move-on work suppressed auto-load indefinitely. Arm the timer and
        // let the deferred check decide.
        if (autoLoadTimer) clearTimeout(autoLoadTimer);
        autoLoadTimer = setTimeout(runAutoLoad, AUTO_LOAD_DEBOUNCE_MS);
      }

      function runAutoLoad() {
        autoLoadTimer = null;
        // Re-validate: during the debounce the user may have deselected, turned
        // auto-load off, or another load may have started.
        if (!LS.getAutoLoad() || isLoading) return;

        // Still inside a self-selection window: re-arm rather than drop, so a genuine
        // selection made during it is honoured once the window closes.
        const waitLeft = suppressAutoLoadUntil - Date.now();
        if (waitLeft > 0) {
          autoLoadTimer = setTimeout(runAutoLoad, waitLeft + 50);
          return;
        }

        const stillSelected = getSelectedSegments();
        if (stillSelected.length === 0) return;
        if (selectionCoveredByLoadedBbox(stillSelected)) return;
        loadSelectedStreet({ auto: true }).catch(err => console.warn('[SL-HN] auto-load failed:', err));
      }

      wmeSDK.Events.on({ eventName: 'wme-selection-changed', eventHandler: maybeAutoLoad });

      function clearLayer() {
        clearFixStreetState();
        currentLoadId++; // invalidate any in-flight load so its results are discarded
        setOverlayFeatures(overlays.hn, []);
        setOverlayFeatures(overlays.labels, []);
        setOverlayFeatures(overlays.audit, []);
        lastAuditFindings = [];
        if (auditSummaryDiv) auditSummaryDiv.style.display = 'none';
        // Cancel any armed auto-load, or it fires after this and silently undoes
        // the Clear the user just asked for.
        if (autoLoadTimer) { clearTimeout(autoLoadTimer); autoLoadTimer = null; }
        lastLoadedBbox = null; // no reference data any more, so the audit must stay silent
        overlays.hn.wanted = false;
        updateLayerVisibility(); // keeps overlays.hn.shown in sync (a direct setLayerVisibility here left it stale)
        setChecked(chkVis, false);
        LS.setLayerVisible(false);
        streets = {};
        streetNames = {};
        currentStreetId = null;
        lastFeatures = [];
        hideCurrentStreet();
        streetAnalysisDiv.style.display = 'none';
        statusDiv.innerHTML = INSTRUCTIONS_HTML;
      }

      btnClear.addEventListener('click', clearLayer);

      renderAuditFindings = function () {
        // Silent unless the markers are actually on screen. `wanted` alone was not
        // enough: below MIN_OVERLAY_ZOOM, or when an auto-load left the base layer
        // off, the summary still printed counts for markers that were not drawn and
        // that handleMapClick refuses to hit-test.
        if (!overlays.audit.wanted || !overlays.audit.shown) {
          setOverlayFeatures(overlays.audit, []);
          if (auditSummaryDiv) auditSummaryDiv.style.display = 'none';
          return;
        }

        const visibleFindings = lastAuditFindings.filter(isAuditFindingVisible);

        setOverlayFeatures(overlays.audit, visibleFindings.map(f => ({
          type: 'Feature',
          id: `qhnsl-audit-${f.hnId}`,
          geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
          properties: { number: f.number, type: f.type, segmentId: f.segmentId }
        })));

        if (!auditSummaryDiv) return;
        if (!visibleFindings.length) {
          auditSummaryDiv.style.display = 'none';
          return;
        }
        const missing = visibleFindings.filter(f => f.type === 'missing').length;
        const misplaced = visibleFindings.filter(f => f.type === 'misplaced').length;
        auditSummaryDiv.innerHTML =
          `<b style="color:#b04ce6;">Audit:</b> ${missing} not in eProstor · ${misplaced} misplaced`;
        auditSummaryDiv.style.display = 'block';
      };

      applyFeatureFilter = function () {
        // Drop unplottable points before handing them to the SDK: one bad coordinate
        // makes it reject the whole batch, which would take out every circle. The
        // label path already guards its centroids for the same reason.
        const visible = lastFeatures
          .filter(isFeatureVisible)
          .filter(feat => Number.isFinite(feat.lon) && Number.isFinite(feat.lat));
        setOverlayFeatures(overlays.hn, visible.map((feat, i) => ({
          type: 'Feature',
          id: `qhnsl-${i}`,
          geometry: { type: 'Point', coordinates: [feat.lon, feat.lat] },
          properties: {
            number: feat.number,
            street: feat.street,
            processed: feat.processed,
            conflict: feat.conflict,
            isSelectedStreet: feat.street === currentStreetId,
            fixHighlight: fixStreetHighlightStreetId != null && feat.street === fixStreetHighlightStreetId
          }
        })));

        // One street-name label per street, anchored at the centroid of that street's
        // visible house-number points. Skipped entirely when the overlay is off —
        // building and uploading features nobody can see is pure waste.
        const labelSdk = [];
        if (overlays.labels.wanted) {
          const byStreet = new Map();
          visible.forEach(feat => {
            let g = byStreet.get(feat.street);
            if (!g) { g = { sumLon: 0, sumLat: 0, n: 0 }; byStreet.set(feat.street, g); }
            g.sumLon += feat.lon; g.sumLat += feat.lat; g.n++;
          });
          byStreet.forEach((g, streetId) => {
            const name = streetNames[streetId];
            if (!name) return;
            const lon = g.sumLon / g.n;
            const lat = g.sumLat / g.n;
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return; // a NaN centroid is rejected by the SDK
            labelSdk.push({
              type: 'Feature',
              id: `qhnsl-street-${streetId}`,
              geometry: { type: 'Point', coordinates: [lon, lat] },
              properties: { name }
            });
          });
        }
        setOverlayFeatures(overlays.labels, labelSdk);
        if (labelSdk.length) liftLabelLayer();

        try {
          renderAuditFindings();
        } catch (e) {
          console.warn('[SL-HN] audit render failed:', e);
        }
      };

      // Single source of truth for a circle's processed/conflict state, shared
      // by the initial load and every later recalculation. Processed = saved in
      // WME (entry) OR added this session but not saved yet.
      function computeFeatureState(streetId, hn, x, y, selectionHNMap) {
        const entry = selectionHNMap.get(streetId);
        const processed = entry?.set.has(hn) === true || sessionAddedKeys.has(featKey(streetId, hn, x, y));
        const conflict = !processed && hasConflict(hn, x, y, entry);
        return { processed, conflict };
      }

      async function recalculateFeatureStates() {
        if (!lastFeatures.length) return;

        const selectionHNMap = await getVisibleHNsByStreet();

        lastFeatures.forEach(feat => {
          const { number: hn, street: streetId, eX, eY } = feat;
          if (!hn || !streetId) return;

          const { processed, conflict } = computeFeatureState(streetId, hn, eX, eY, selectionHNMap);
          feat.processed = processed;
          feat.conflict = conflict;
        });

        try {
          lastAuditFindings = computeAuditFindings(lastFeatures, selectionHNMap, lastLoadedBbox);
        } catch (e) {
          lastAuditFindings = [];
          console.warn('[SL-HN] audit failed:', e);
        }

        applyFeatureFilter();
      }

      function setupHouseNumberEventListeners() {
        const refresh = () => {
          if (lastFeatures.length > 0) {
            recalculateFeatureStates().catch(err => console.warn('[SL-HN] recalculate failed:', err));
          }
        };

        // An HN was added — if it was our pending add, remember its id so we can undo
        // the session-added overlay if the same HN is later deleted.
        wmeSDK.Events.on({
          eventName: 'wme-house-number-added',
          eventHandler: (payload) => {
            const hnId = payload?.houseNumberId != null ? String(payload.houseNumberId) : null;
            if (hnId != null) {
              // This id exists again — it must no longer be treated as deleted.
              deletedHnIds.delete(hnId);
              if (pendingAddKey != null) {
                hnIdToAddedKey.set(hnId, pendingAddKey);
                sessionAddedKeys.add(pendingAddKey);
              } else {
                // Redo of a session add: restore its overlay.
                const key = hnIdToAddedKey.get(hnId);
                if (key != null) sessionAddedKeys.add(key);
              }
            }
            pendingAddKey = null;
            refresh();
          }
        });

        // An HN was deleted — record its id (the model keeps returning it until save) and
        // drop any matching session-added overlay so the circle un-fades immediately.
        wmeSDK.Events.on({
          eventName: 'wme-house-number-deleted',
          eventHandler: (payload) => {
            const hnId = payload?.houseNumberId != null ? String(payload.houseNumberId) : null;
            if (hnId != null) {
              // Known gap: undoing the delete of a SAVED HN fires no event at
              // all, so this entry can go stale until save reconciles it.
              deletedHnIds.add(hnId);
              // Un-fade the circle, but KEEP the id → key mapping so a redo of
              // this add (same id) can restore the overlay.
              const key = hnIdToAddedKey.get(hnId);
              if (key != null) {
                sessionAddedKeys.delete(key);
              }
            }
            refresh();
          }
        });

        ['wme-house-number-moved', 'wme-house-number-updated'].forEach(eventName => {
          wmeSDK.Events.on({ eventName, eventHandler: refresh });
        });

        wmeSDK.Events.on({ eventName: 'wme-map-data-loaded', eventHandler: refresh });

        // The high-level HN events don't fire on undo/redo of an unsaved add,
        // but the data-model events do: undo removes the HN object from the
        // model, redo re-adds it with the same id. Only ids we created (in
        // hnIdToAddedKey) are touched, so unrelated model churn is ignored.
        try {
          wmeSDK.Events.trackDataModelEvents({ dataModelName: 'segmentHouseNumbers' });
          wmeSDK.Events.on({
            eventName: 'wme-data-model-objects-removed',
            eventHandler: (payload) => {
              if (payload?.dataModelName !== 'segmentHouseNumbers') return;
              let changed = false;
              (payload.objectIds || []).forEach(rawId => {
                const key = hnIdToAddedKey.get(String(rawId));
                if (key != null && sessionAddedKeys.has(key)) {
                  sessionAddedKeys.delete(key); // keep the mapping for a possible redo
                  changed = true;
                }
              });
              if (changed) refresh();
            }
          });
          wmeSDK.Events.on({
            eventName: 'wme-data-model-objects-added',
            eventHandler: (payload) => {
              if (payload?.dataModelName !== 'segmentHouseNumbers') return;
              let changed = false;
              (payload.objectIds || []).forEach(rawId => {
                const id = String(rawId);
                // Unconditional: a house number reappearing is no longer deleted,
                // whether we added it or not. Nesting this inside the hnIdToAddedKey
                // guard below meant undoing the deletion of a SAVED house number left
                // it flagged forever — it stayed hidden from the WME index, so its
                // circle showed as missing and one click created a duplicate.
                // Set.delete reports whether it removed anything, so the UI refreshes
                // for this case too rather than waiting for an unrelated event.
                if (deletedHnIds.delete(id)) changed = true;

                const key = hnIdToAddedKey.get(id);
                if (key != null && !sessionAddedKeys.has(key)) {
                  sessionAddedKeys.add(key);
                  changed = true;
                }
              });
              if (changed) refresh();
            }
          });
        } catch (err) {
          console.warn('[SL-HN] could not track HN data-model events:', err);
        }

        // A successful save is the reconciliation point: fetchHouseNumbers now
        // reflects reality, and saved HNs get new permanent ids, so the session
        // overlays (keyed by pre-save ids) would only drift from here — drop them.
        try {
          wmeSDK.Events.on({
            eventName: 'wme-save-finished',
            eventHandler: (payload) => {
              if (payload && payload.success === false) return;
              sessionAddedKeys.clear();
              deletedHnIds.clear();
              hnIdToAddedKey.clear();
              pendingAddKey = null;
              refresh();
            }
          });
        } catch (err) {
          console.warn('[SL-HN] could not subscribe to wme-save-finished:', err);
        }

        // Listen for segment edits (like street name changes) to refresh UI
        wmeSDK.Events.on({
          eventName: 'wme-after-edit',
          eventHandler: () => {
            if (lastFeatures.length > 0) {
              // Refresh the street analysis panel to reflect any street name changes
              analyzeStreetMatches();
              // Recompute, not just re-render: renaming a street is the main way a
              // user fixes a 'missing' finding, and applyFeatureFilter alone would
              // redraw the same purple marker over the problem they just solved.
              recalculateFeatureStates().catch(err => console.warn('[SL-HN] recalculate after edit failed:', err));
            }
          }
        });
      }

      setupHouseNumberEventListeners();


      ['qhnsl-load', 'qhnsl-clear'].forEach(id => {
        try { wmeSDK.Shortcuts.deleteShortcut({ shortcutId: id }); } catch (_) {}
      });
      [
        { shortcutId: 'qhnsl-load',  shortcutKeys: 'AS+l', description: 'SL-HN: Load selected street', callback: () => loadSelectedStreet() },
        { shortcutId: 'qhnsl-clear', shortcutKeys: 'AS+k', description: 'SL-HN: Clear',                callback: clearLayer }
      ].forEach(spec => {
        try { wmeSDK.Shortcuts.createShortcut(spec); }
        catch (e) { console.warn('[SL-HN] failed to register shortcut', spec.shortcutId, e); }
      });

      function updateLayer(statusDiv, loadId) {
        return new Promise((resolve) => {
          const selectedSegments = getSelectedSegments();
          if (selectedSegments.length === 0) {
            toast('Select a segment first.', 'warning');
            statusDiv.textContent = 'No segment selected.';
            resolve();
            return;
          }

          loading.style.display = null;

          const bbox = computeFetchBbox(selectedSegments, LS.getBuffer());
          if (!bbox) {
            loading.style.display = 'none';
            statusDiv.textContent = 'No geometry for selected segments.';
            resolve();
            return;
          }
          const { minE, minN, maxE, maxN } = bbox;

          Promise.all([
            fetchAddresses(minE, minN, maxE, maxN, () => loadId !== currentLoadId),
            getVisibleHNsByStreet()
          ])
            .then(([fetchResult, selectionHNMap]) => {
              // Bail out if user clicked Clear (or started a newer load) while the fetch was in flight
              if (loadId !== currentLoadId) {
                loading.style.display = 'none';
                resolve();
                return;
              }

              const apiFeatures = fetchResult.features;
              const fetchComplete = fetchResult.complete;

              const features = [];

              for (const item of apiFeatures) {
                const props = item.properties;
                if (!props) continue;

                // Skip addresses without coordinates
                const e = props.E;
                const n = props.N;
                if (e == null || n == null) continue;

                // Convert from EPSG:3794 to EPSG:4326
                const [lon, lat] = proj4('EPSG:3794', 'EPSG:4326', [e, n]);

                // Build house number from components
                const hn = buildHouseNumber(props.HS_STEVILKA, props.HS_DODATEK);
                if (!hn) continue;

                // Get street name, or settlement name for villages without streets
                const streetName = props.ULICA_NAZIV || props.NASELJE_NAZIV;
                if (!streetName) continue;

                const streetId = normalizeStreetName(streetName);
                if (!streets[streetName]) {
                  streets[streetName]   = streetId;
                  streetNames[streetId] = streetName;
                }

                const { processed, conflict } = computeFeatureState(streetId, hn, e, n, selectionHNMap);

                features.push({
                  number: hn,
                  street: streetId,
                  processed,
                  conflict,
                  lon,
                  lat,
                  eX: e,
                  eY: n
                });
              }

              lastFeatures = features; // computeAuditFindings reads lastFeatures
              // Record the area eProstor actually answered for — only when the answer
              // covered the whole box. A truncated result (page cap, bad page) would
              // otherwise make the audit call addresses in the unfetched remainder
              // "missing", and make auto-load consider that remainder already loaded.
              // null means: no authoritative coverage, so the audit stays silent.
              lastLoadedBbox = fetchComplete ? { minE, minN, maxE, maxN } : null;
              if (!fetchComplete) {
                console.warn('[SL-HN] partial address data: reverse audit disabled for this load');
              }
              try {
                lastAuditFindings = computeAuditFindings(lastFeatures, selectionHNMap, lastLoadedBbox);
              } catch (e) {
                lastAuditFindings = [];
                console.warn('[SL-HN] audit failed:', e);
              }

              const allStreetIds = new Set();
              selectedSegments.forEach(seg => {
                (seg.alternateStreetIds || []).forEach(id => allStreetIds.add(id));
                if (seg.primaryStreetId) allStreetIds.add(seg.primaryStreetId);
              });

              currentStreetId = findBestMatchingStreetId(allStreetIds, features);

              if (!features.length) {
                loading.style.display = 'none';
                statusDiv.textContent = 'No address points in view.';
                resolve();
                return;
              }

              lastFeatures = features;

              if (currentStreetId && streetNames[currentStreetId]) {
                showCurrentStreet(streetNames[currentStreetId]);
              } else {
                hideCurrentStreet();
              }

              setOverlayFeatures(overlays.hn, []);

              applyFeatureFilter();
              analyzeStreetMatches();

              loading.style.display = 'none';
              statusDiv.innerHTML = `Loaded ${lastFeatures.length} address points.<br/><b>Click numbers on map to add them!</b><br/>Green = selected • Orange = other • Red = possible wrong HN`;
              resolve();
            })
            .catch(err => {
              console.error('[SL-HN] API error:', err);
              loading.style.display = 'none';
              if (loadId === currentLoadId) {
                statusDiv.textContent = 'Error fetching address data. See console.';
                toast('Error fetching address data.', 'error');
              }
              resolve();
            });
        });
      }

      // Visible HNs grouped by normalized street name (primary + alternate)
      async function getVisibleHNsByStreet() {
        const map = new Map();
        const ext = wmeSDK.Map.getMapExtent();
        const [lonMin, latMin, lonMax, latMax] = Array.isArray(ext)
          ? ext
          : [ext.lonMin, ext.latMin, ext.lonMax, ext.latMax];

        const segIds = wmeSDK.DataModel.Segments.getAll()
          .filter(s => s.hasHouseNumbers)
          .map(s => s.id);
        const allHns = segIds.length
          ? await wmeSDK.DataModel.HouseNumbers.fetchHouseNumbers({ segmentIds: segIds })
          : [];

        allHns.forEach(hn => {
          // Skip HNs deleted this session: the model still returns them until save.
          if (deletedHnIds.has(String(hn.id))) return;
          const seg = wmeSDK.DataModel.Segments.getById({ segmentId: hn.segmentId });
          if (!seg) return;

          const streetIdSet = new Set();
          if (seg.primaryStreetId) {
            streetIdSet.add(seg.primaryStreetId);
          }
          (seg.alternateStreetIds || []).forEach(id => {
            if (id) streetIdSet.add(id);
          });
          if (!streetIdSet.size) return;

          const g = getHNGeometry(hn);
          let x, y;
          if (g && typeof g.x === 'number' && typeof g.y === 'number') {
            x = g.x;
            y = g.y;
          }
          if (x == null || y == null || x < lonMin || x > lonMax || y < latMin || y > latMax) return;

          const [eX, eY] = proj4('EPSG:4326', 'EPSG:3794', [x, y]);
          const numRaw = normalizeHN(hn.number);

          streetIdSet.forEach(streetId => {
            const st = wmeSDK.DataModel.Streets.getById({ streetId });
            const name = st?.name;
            if (!name) return;

            const sidNorm = normalizeStreetName(name);

            let entry = map.get(sidNorm);
            if (!entry) {
              entry = { set: new Set(), items: [] };
              map.set(sidNorm, entry);
            }

            entry.set.add(numRaw);
            entry.items.push({
              num: numRaw,
              x: eX,
              y: eY,
              // Null, not String(hn.id): String(undefined) is the truthy string
              // "undefined", which would collapse every id-less house number into
              // one audit finding under a colliding feature id.
              hnId: hn.id != null ? String(hn.id) : null,
              segmentId: hn.segmentId,
              lon: x,
              lat: y
            });
          });
        });

        return map;
      }

      setupNavPoints(tabPane);
    });
  }

  // Everything above is definitions only. This is the single entry point, and the
  // only reason the file cannot simply be require()d — so it is the one thing the
  // test suite skips. In Tampermonkey IN_USERSCRIPT_ENV is always true, so startup
  // behaves exactly as before.
  if (IN_USERSCRIPT_ENV) {
  (unsafeWindow || window).SDK_INITIALIZED.then(() => {
    wmeSDK = getWmeSdk({ scriptId: 'quick-hn-sl-importer', scriptName: 'Quick HN Importer (SI)' });
    wmeSDK.Events.once({ eventName: 'wme-ready' }).then(() => {
      // Two lists, because the consequence differs. Anything in `required` aborts
      // startup — put a method here only if the script is genuinely unusable without
      // it. Adding a merely-nice-to-have here once made the whole script vanish when
      // a single optional method was absent.
      const required = [
        'DataModel.Segments.getAll',
        'DataModel.Segments.getById',
        'DataModel.Streets.getAll',
        'DataModel.Streets.getById',
        'DataModel.Streets.getStreet',
        'DataModel.HouseNumbers.fetchHouseNumbers',
        'DataModel.HouseNumbers.addHouseNumber',
        'DataModel.Segments.updateAddress',
        'DataModel.Streets.addStreet',
        'Editing.setSelection',
        'Editing.getSelection',
        'Events.on',
        'Events.once',
        'Sidebar.registerScriptTab',
        'Map.addLayer',
        'Map.addFeaturesToLayer',
        'Map.removeFeaturesFromLayer',
        'Map.setLayerVisibility',
        'Map.getZoomLevel',
        'Map.getMapExtent',
        'Map.getMapPixelFromLonLat'
      ];

      // Each of these is already guarded at its call site and degrades to a smaller
      // feature set. They are checked only so a renamed SDK method shows up in the
      // console instead of silently doing nothing.
      const optional = [
        'Map.setLayerZIndex',          // street labels sink under other overlays
        'Map.setMapCenter',            // audit clicks select but do not recentre
        'Shortcuts.createShortcut',    // keyboard shortcuts unavailable
        'Shortcuts.deleteShortcut',
        'Events.trackDataModelEvents', // live un-fade on external HN edits
        'DataModel.Cities.getById',    // fallback city lookup for address-less segments
        'DataModel.Cities.getCity',
        'DataModel.Cities.getTopCity',
        'DataModel.Cities.addCity',
        'DataModel.Countries.getTopCountry'
      ];

      const isMissing = (path) => {
        let cur = wmeSDK;
        for (const p of path.split('.')) { cur = cur?.[p]; if (cur == null) return true; }
        return false;
      };

      const missing = required.filter(isMissing);
      if (missing.length) {
        console.error('[SL-HN] WME SDK missing required APIs:', missing);
        toast(`SL-HN: WME SDK is missing ${missing.length} required APIs. See console.`, 'error');
        return;
      }

      const missingOptional = optional.filter(isMissing);
      if (missingOptional.length) {
        console.warn('[SL-HN] WME SDK missing optional APIs (features degraded):', missingOptional);
      }

      init();
    });
  });
  }

  // Test-only surface. `module` does not exist in Tampermonkey, so this is a no-op
  // there and the userscript is unaffected. Only pure functions are exposed —
  // anything touching the SDK, the DOM or the network stays private.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizeHN,
      buildHouseNumber,
      normalizeStreetName,
      buildCqlFilter,
      hasConflict,
      computeAuditFindings,
      computeFetchBbox,
      isSelectionInsideBbox,
      makeFeatKey,
      NON_ADDRESSABLE_ROAD_TYPES,
      AUDIT_MAX_DISTANCE,
      MAX_HN_CONFLICT_DISTANCE
    };
  }
})();
