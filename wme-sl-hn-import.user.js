// ==UserScript==
// @name         WME Quick HN Importer - Slovenia
// @namespace    https://github.com/zigapovhe/wme-sl-hn-import
// @version      2.3.0
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
  const SDK_NAVPOINTS_LAYER_NAME = 'qhnsl-navpoints';

  const MAX_CLICK_DISTANCE_PX = 25;
  const MAX_HN_CONFLICT_DISTANCE = 10;

  // Waze road types house numbers should never attach to:
  // 5 walking trail / routable pedestrian path, 10 pedestrian boardwalk,
  // 16 stairway, 18 railroad, 19 runway/taxiway
  const NON_ADDRESSABLE_ROAD_TYPES = new Set([5, 10, 16, 18, 19]);

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
    setNavPoints(v)   { localStorage.setItem('qhnsl-navpoints', v ? '1' : '0'); }
  };

  const toast = (msg, type = 'info') => {
    try {
      if (wmeSDK?.Notifications?.show) {
        wmeSDK.Notifications.show({ text: msg, type, timeout: 3500 });
      } else {
        console.info(`[SL-HN] ${msg}`);
      }
    } catch (_) {
      console.info(`[SL-HN] ${msg}`);
    }
  };

  // EPSG:3794 definition (Slovenia D96/TM)
  if (!proj4.defs['EPSG:3794']) {
    proj4.defs(
      'EPSG:3794',
      '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
    );
  }

  function normalizeStreetName(name) {
    return String(name).toLowerCase().replace(/\s+/g, '_');
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

  // Build house number string from components
  function buildHouseNumber(stevilka, dodatek) {
    let hn = String(stevilka || '').trim();
    if (dodatek) {
      hn += String(dodatek).trim();
    }
    return hn.toLowerCase();
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

  // Build CQL filter for coordinate bounds (excludes apartments)
  function buildCqlFilter(minE, minN, maxE, maxN) {
    return `E>=${minE} AND E<=${maxE} AND N>=${minN} AND N<=${maxN} AND ST_STANOVANJA IS NULL`;
  }

  // Fetch addresses from EProstor API with pagination. shouldAbort (optional)
  // is checked between pages so a Clear / newer Load stops the request chain.
  function fetchAddresses(minE, minN, maxE, maxN, shouldAbort) {
    return new Promise((resolve, reject) => {
      const allFeatures = [];
      let startIndex = 0;
      let pageCount = 0;

      function fetchPage() {
        if (typeof shouldAbort === 'function' && shouldAbort()) {
          resolve(allFeatures); // caller discards stale results anyway
          return;
        }
        if (++pageCount > EPROSTOR_MAX_PAGES) {
          console.warn(`[SL-HN] EProstor result truncated at ${EPROSTOR_MAX_PAGES} pages — reduce the buffer`);
          toast('Too many addresses in area — result truncated, reduce the buffer', 'warning');
          resolve(allFeatures);
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
                  resolve(allFeatures);
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
                resolve(allFeatures);
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
      ? `⚠️ Official street <b>"${escapedOfficial}"</b> is ~${Math.round(farInfo.farDistance)} m away — the nearest segment (${Math.round(farInfo.nearestDistance)} m) has a different name`
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

    selectedSegments.forEach(segment => {
      try {
        // Resolve the city from the segment's current primary street
        const currentStreet = segment.primaryStreetId
          ? wmeSDK.DataModel.Streets.getById({ streetId: segment.primaryStreetId })
          : null;
        const cityId = currentStreet?.cityId;

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

        wmeSDK.DataModel.Segments.updateAddress({
          segmentId: segment.id,
          primaryStreetId: street.id
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

  function init() {
    let currentStreetId = null;
    let streetNames = {};
    let streets = {};
    let lastFeatures = [];
    let fixStreetHighlightStreetId = null; // official street ID whose HNs are highlighted during fix-street flow
    let lastSdkFeatureIds = [];
    let isLoading = false;
    let currentLoadId = 0;
    let userWantsLayerVisible = false;
    let streetNameSpan = null;
    let currentStreetDiv = null;
    let streetAnalysisDiv = null;

    // Track unsaved house-number edits this session. fetchHouseNumbers reflects the
    // SAVED state only: it keeps returning pending-deleted HNs and omits pending-added
    // ones until the editor saves. We layer our own edits on top, keyed by the stable
    // houseNumberId the SDK events provide.
    const deletedHnIds = new Set();     // HNs deleted this session (still in saved model until save)
    const sessionAddedKeys = new Set(); // feature keys we added this session (not yet in saved model)
    const hnIdToAddedKey = new Map();   // added houseNumberId -> feature key, to undo on later delete
    let pendingAddKey = null;           // set just before addHouseNumber, consumed by the added event
    const featKey = (streetId, number) => `${streetId} ${number}`;

    let chkMissing = null;
    let chkSelectedOnly = null;

    let applyFeatureFilter = () => {};
    let analyzeStreetMatches = () => {};

    try {
      I18n.translations[I18n.currentLocale()].layers.name['quick-hn-sl-importer'] = 'Quick HN Importer';
    } catch (_) {}

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
    wmeSDK.Map.setLayerVisibility({ layerName: SDK_LAYER_NAME, visibility: false });

    let lastComputedVisibility = false;
    function updateLayerVisibility() {
      const currentZoom = wmeSDK.Map.getZoomLevel();
      const shouldBeVisible = userWantsLayerVisible && currentZoom >= 18;

      if (shouldBeVisible === lastComputedVisibility) return;
      lastComputedVisibility = shouldBeVisible;

      wmeSDK.Map.setLayerVisibility({ layerName: SDK_LAYER_NAME, visibility: shouldBeVisible });

      if (userWantsLayerVisible && !shouldBeVisible && lastFeatures.length > 0) {
        toast('Zoom in to level 18+ to see house numbers', 'info');
      }
    }

    wmeSDK.Events.on({ eventName: 'wme-map-zoom-changed', eventHandler: updateLayerVisibility });
    wmeSDK.Events.on({ eventName: 'wme-map-move-end', eventHandler: updateLayerVisibility });
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

    function handleMapClick(evt) {
      // lastComputedVisibility is false when the layer is hidden (e.g. zoom < 18):
      // no visible circles means clicks must do nothing.
      if (!userWantsLayerVisible || !lastComputedVisibility || !lastFeatures.length) return;
      if (evt == null || evt.x == null || evt.y == null) return;

      const MAX_PIXELS_SQ = MAX_CLICK_DISTANCE_PX * MAX_CLICK_DISTANCE_PX;
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

      if (!bestFeature) return;
      onFeatureClick(bestFeature);
    }

    wmeSDK.Events.on({ eventName: 'wme-map-mouse-click', eventHandler: handleMapClick });

    function onFeatureClick(feature) {
      // A new click supersedes any open fix-street dialog
      clearFixStreetState();

      if (feature.processed) return;

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
      wmeSDK.Editing.setSelection({ selection: { ids: [segment.id], objectType: 'segment' } });

      const key = featKey(feature.street, feature.number);
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
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <wz-checkbox id="hn-toggle">Show layer</wz-checkbox>
            <wz-checkbox id="qhnsl-missing">Show only missing</wz-checkbox>
            <wz-checkbox id="qhnsl-selected-only">Selected street only</wz-checkbox>
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
      const chkNavPoints = tabPane.querySelector('#qhnsl-navpoints');
      const bufferEl   = tabPane.querySelector('#qhnsl-buffer');
      const statusDiv  = tabPane.querySelector('#hn-status');

      currentStreetDiv = tabPane.querySelector('#hn-current-street');
      streetNameSpan = tabPane.querySelector('#hn-street-name');
      streetAnalysisDiv = tabPane.querySelector('#hn-street-analysis');

      const isChecked  = (el) => el?.hasAttribute('checked');
      const setChecked = (el, v) => v ? el.setAttribute('checked', '') : el.removeAttribute('checked');

      bufferEl.value = String(LS.getBuffer());
      if (LS.getLayerVisible()) {
        setChecked(chkVis, true);
        userWantsLayerVisible = true;
        updateLayerVisibility();
      }
      if (LS.getSelectedOnly()) {
        setChecked(chkSelectedOnly, true);
      }
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
        userWantsLayerVisible = !on;
        LS.setLayerVisible(!on);
        updateLayerVisibility();
      });

      chkMissing.addEventListener('click', () => {
        setChecked(chkMissing, !isChecked(chkMissing));
        applyFeatureFilter();
      });

      chkSelectedOnly.addEventListener('click', () => {
        const newState = !isChecked(chkSelectedOnly);
        setChecked(chkSelectedOnly, newState);
        LS.setSelectedOnly(newState);
        applyFeatureFilter();
      });

      async function loadSelectedStreet() {
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
        btnLoad.disabled = true;
        btnLoadLabel.textContent = 'Loading…';

        if (lastSdkFeatureIds.length) {
          wmeSDK.Map.removeFeaturesFromLayer({ layerName: SDK_LAYER_NAME, featureIds: lastSdkFeatureIds });
          lastSdkFeatureIds = [];
        }
        streets = {};
        streetNames = {};
        currentStreetId = null;
        lastFeatures = [];
        streetAnalysisDiv.style.display = 'none';

        await updateLayer(statusDiv, myLoadId).catch(err => console.warn('[SL-HN] updateLayer:', err));

        // Skip post-load side effects if user clicked Clear (or another Load) mid-fetch
        if (myLoadId === currentLoadId) {
          userWantsLayerVisible = true;
          setChecked(chkVis, true);
          LS.setLayerVisible(true);
          updateLayerVisibility();
        }

        btnLoad.disabled = false;
        btnLoadLabel.textContent = 'Load selected street';
        isLoading = false;
      }

      btnLoad.addEventListener('click', loadSelectedStreet);

      function clearLayer() {
        clearFixStreetState();
        currentLoadId++; // invalidate any in-flight load so its results are discarded
        if (lastSdkFeatureIds.length) {
          wmeSDK.Map.removeFeaturesFromLayer({ layerName: SDK_LAYER_NAME, featureIds: lastSdkFeatureIds });
          lastSdkFeatureIds = [];
        }
        userWantsLayerVisible = false;
        updateLayerVisibility(); // keeps lastComputedVisibility in sync (a direct setLayerVisibility here left it stale)
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

      applyFeatureFilter = function () {
        const visible = lastFeatures.filter(isFeatureVisible);
        if (lastSdkFeatureIds.length) {
          wmeSDK.Map.removeFeaturesFromLayer({ layerName: SDK_LAYER_NAME, featureIds: lastSdkFeatureIds });
        }
        const visibleSdk = visible.map((feat, i) => ({
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
        }));
        wmeSDK.Map.addFeaturesToLayer({ layerName: SDK_LAYER_NAME, features: visibleSdk });
        lastSdkFeatureIds = visibleSdk.map(f => f.id);
      };

      // Single source of truth for a circle's processed/conflict state, shared
      // by the initial load and every later recalculation. Processed = saved in
      // WME (entry) OR added this session but not saved yet.
      function computeFeatureState(streetId, hn, x, y, selectionHNMap) {
        const entry = selectionHNMap.get(streetId);
        const processed = entry?.set.has(hn) === true || sessionAddedKeys.has(featKey(streetId, hn));
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
                const key = hnIdToAddedKey.get(id);
                if (key != null && !sessionAddedKeys.has(key)) {
                  sessionAddedKeys.add(key);
                  deletedHnIds.delete(id);
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
              applyFeatureFilter();
            }
          }
        });
      }

      setupHouseNumberEventListeners();

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
          if (!LS.getNavPoints()) { clearNavLayer(); return; }
          if (wmeSDK.Map.getZoomLevel() < 18) { clearNavLayer(); return; }

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

      ['qhnsl-load', 'qhnsl-clear'].forEach(id => {
        try { wmeSDK.Shortcuts.deleteShortcut({ shortcutId: id }); } catch (_) {}
      });
      [
        { shortcutId: 'qhnsl-load',  shortcutKeys: 'AS+l', description: 'SL-HN: Load selected street', callback: loadSelectedStreet },
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

          // Compute bounding box of selected segments in WGS84 from GeoJSON coords
          let minLon = Infinity, maxLon = -Infinity;
          let minLat = Infinity, maxLat = -Infinity;
          selectedSegments.forEach(seg => {
            const coords = seg.geometry?.coordinates;
            if (!Array.isArray(coords)) return;
            coords.forEach(pt => {
              const lon = pt[0], lat = pt[1];
              if (lon < minLon) minLon = lon;
              if (lon > maxLon) maxLon = lon;
              if (lat < minLat) minLat = lat;
              if (lat > maxLat) maxLat = lat;
            });
          });

          if (minLon === Infinity) {
            loading.style.display = 'none';
            statusDiv.textContent = 'No geometry for selected segments.';
            resolve();
            return;
          }

          // Convert WGS84 bbox to EPSG:3794 (Slovenia D96/TM, in meters), then buffer
          const bl = proj4('EPSG:4326', 'EPSG:3794', [minLon, minLat]);
          const tr = proj4('EPSG:4326', 'EPSG:3794', [maxLon, maxLat]);
          const buffer = LS.getBuffer();

          const minE = Math.floor(bl[0] - buffer);
          const minN = Math.floor(bl[1] - buffer);
          const maxE = Math.ceil(tr[0]  + buffer);
          const maxN = Math.ceil(tr[1]  + buffer);

          Promise.all([
            fetchAddresses(minE, minN, maxE, maxN, () => loadId !== currentLoadId),
            getVisibleHNsByStreet()
          ])
            .then(([apiFeatures, selectionHNMap]) => {
              // Bail out if user clicked Clear (or started a newer load) while the fetch was in flight
              if (loadId !== currentLoadId) {
                loading.style.display = 'none';
                resolve();
                return;
              }

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

              if (lastSdkFeatureIds.length) {
                wmeSDK.Map.removeFeaturesFromLayer({ layerName: SDK_LAYER_NAME, featureIds: lastSdkFeatureIds });
                lastSdkFeatureIds = [];
              }

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
          const numRaw = String(hn.number).trim().toLowerCase();

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
            entry.items.push({ num: numRaw, x: eX, y: eY });
          });
        });

        return map;
      }

      setupNavPoints(tabPane);
    });
  }

  (unsafeWindow || window).SDK_INITIALIZED.then(() => {
    wmeSDK = getWmeSdk({ scriptId: 'quick-hn-sl-importer', scriptName: 'Quick HN Importer (SI)' });
    wmeSDK.Events.once({ eventName: 'wme-ready' }).then(() => {
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
        'Map.addLayer',
        'Map.addFeaturesToLayer',
        'Map.removeFeaturesFromLayer',
        'Map.setLayerVisibility',
        'Map.getZoomLevel',
        'Map.getMapExtent',
        'Map.getMapPixelFromLonLat'
      ];
      const missing = required.filter(path => {
        const parts = path.split('.');
        let cur = wmeSDK;
        for (const p of parts) { cur = cur?.[p]; if (cur == null) return true; }
        return false;
      });
      if (missing.length) {
        console.error('[SL-HN] WME SDK missing required APIs:', missing);
        toast(`SL-HN: WME SDK is missing ${missing.length} required APIs. See console.`, 'error');
        return;
      }
      init();
    });
  });
})();
