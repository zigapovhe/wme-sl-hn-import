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

  // EProstor API configuration
  const EPROSTOR_API = 'https://ipi.eprostor.gov.si/wfs-si-gurs-rn/ogc/features/collections/SI.GURS.RN:REGISTER_NASLOVOV/items';
  const EPROSTOR_LIMIT = 1000;

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

  // Fetch addresses from EProstor API with pagination
  function fetchAddresses(minE, minN, maxE, maxN) {
    return new Promise((resolve, reject) => {
      const allFeatures = [];
      let startIndex = 0;

      function fetchPage() {
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

              // Check if there are more pages
              const returned = data.numberReturned || data.features.length;
              if (returned >= EPROSTOR_LIMIT) {
                startIndex += EPROSTOR_LIMIT;
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

  // Update selected segment's street name via WME SDK
  function updateSegmentStreetName(newStreetName, onSuccess) {
    const selectedSegments = getSelectedSegments();
    if (selectedSegments.length === 0) {
      toast('No segment selected', 'warning');
      return;
    }

    const segment = selectedSegments[0];
    const segmentId = segment.id;

    // Get current city from the segment
    const currentStreetId = segment.primaryStreetId;
    const currentStreet = currentStreetId ? wmeSDK.DataModel.Streets.getById({ streetId: currentStreetId }) : null;
    const cityId = currentStreet?.cityId;

    if (!cityId) {
      toast('Segment has no city assigned', 'warning');
      return;
    }

    try {
      // First, try to get existing street with this name in this city
      let street = wmeSDK.DataModel.Streets.getStreet({
        cityId: cityId,
        streetName: newStreetName
      });

      // If not found, create the street
      if (!street) {
        console.log('[SL-HN] Street not found, creating new street:', newStreetName);
        street = wmeSDK.DataModel.Streets.addStreet({
          streetName: newStreetName,
          cityId: cityId
        });
      }

      console.log('[SL-HN] Got street:', street);

      // Now update the segment with the new street ID
      wmeSDK.DataModel.Segments.updateAddress({
        segmentId: segmentId,
        primaryStreetId: street.id
      });

      console.log('[SL-HN] Updated segment', segmentId, 'to street ID:', street.id);
      toast(`Updated street to "${newStreetName}"`, 'success');

      if (typeof onSuccess === 'function') {
        onSuccess();
      }
    } catch (err) {
      console.error('[SL-HN] Error updating street name:', err);
      toast('Error updating street name. See console.', 'error');
    }
  }

  function init() {
    let currentStreetId = null;
    let streetNames = {};
    let streets = {};
    let lastFeatures = [];
    let lastSdkFeatureIds = [];
    let isLoading = false;
    let currentLoadId = 0;
    let userWantsLayerVisible = false;
    let streetNameSpan = null;
    let currentStreetDiv = null;
    let streetAnalysisDiv = null;

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
          if (p.conflict) return '#ff6666';
          return p.isSelectedStreet ? '#99ee99' : '#fb9c4f';
        },
        getOpacity: ({ feature }) => {
          const p = feature.properties;
          if (p.conflict) return 1;
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

          // Check if this street is already set on the current segment
          const currentWmeStreet = getWmeStreetName();
          if (currentWmeStreet === streetName) {
            toast('Street name already set', 'info');
            return;
          }

          updateSegmentStreetName(streetName, () => {
            // After successful update, refresh the current street state
            // Find the street ID for the new street name
            const newStreetId = streets[streetName];
            if (newStreetId) {
              currentStreetId = newStreetId;

              // Update the "Current street" display
              if (streetNameSpan && currentStreetDiv) {
                streetNameSpan.textContent = streetName;
                currentStreetDiv.style.display = 'block';
              }
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

      if (selectedStreetIds.size === 0) {
        currentStreetId = null;
        if (streetNameSpan && currentStreetDiv) {
          streetNameSpan.textContent = '—';
          currentStreetDiv.style.display = 'none';
        }
        applyFeatureFilter();
        analyzeStreetMatches();
        return;
      }

      const selectedStreetNames = Array.from(selectedStreetIds)
        .map(id => wmeSDK.DataModel.Streets.getById({ streetId: id })?.name)
        .filter(Boolean);

      let newStreetId = null;
      let bestCount = -1;

      selectedStreetNames.forEach(name => {
        const sid = streets[name];
        if (!sid) return;
        const count = lastFeatures.reduce(
          (n, f) => n + (f.street === sid ? 1 : 0),
          0
        );
        if (count > bestCount) {
          bestCount = count;
          newStreetId = sid;
        }
      });

      if (!newStreetId) {
        currentStreetId = null;
        if (streetNameSpan && currentStreetDiv) {
          streetNameSpan.textContent = '—';
          currentStreetDiv.style.display = 'none';
        }
        applyFeatureFilter();
        analyzeStreetMatches();
        return;
      }

      // Always update state and refresh UI, even if street is the same
      // (because we might be on a different segment with the same street)
      currentStreetId = newStreetId;

      if (streetNameSpan && currentStreetDiv && streetNames[currentStreetId]) {
        streetNameSpan.textContent = streetNames[currentStreetId];
        currentStreetDiv.style.display = 'block';
      }

      applyFeatureFilter();
      analyzeStreetMatches();
    }


    function handleMapClick(evt) {
      if (!userWantsLayerVisible || !lastFeatures.length) return;
      if (evt == null || evt.x == null || evt.y == null) return;

      const MAX_PIXELS_SQ = MAX_CLICK_DISTANCE_PX * MAX_CLICK_DISTANCE_PX;
      let bestFeature = null;
      let bestDistSq = Infinity;

      for (const f of lastFeatures) {
        if (f.lon == null || f.lat == null) continue;
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
      if (feature.processed) return;

      const streetName = streetNames[feature.street];
      const houseNumber = feature.number;

      let nearestSegment = findNearestSegment(feature, streetName, true);

      if (!nearestSegment) {
        nearestSegment = findNearestSegment(feature, streetName, false);

        if (!nearestSegment) {
          toast('No nearby segment found', 'warning');
          return;
        }

        const nearestStreet = wmeSDK.DataModel.Streets.getById({ streetId: nearestSegment.primaryStreetId });
        const nearestStreetName = nearestStreet?.name || 'Unknown';

        if (!confirm(`Street name "${streetName}" could not be found.\n\nDo you want to add this number to "${nearestStreetName}"?`)) {
          return;
        }
      }

      wmeSDK.Editing.setSelection({ selection: { ids: [nearestSegment.id], objectType: 'segment' } });

      try {
        wmeSDK.DataModel.HouseNumbers.addHouseNumber({
          number: houseNumber,
          point: { type: 'Point', coordinates: [feature.lon, feature.lat] },
          segmentId: nearestSegment.id
        });

        feature.userAdded = true;
        feature.processed = true;
        feature.conflict = false;
        applyFeatureFilter();

        console.log('[SL-HN] Added house number', houseNumber);
        toast(`Added house number ${houseNumber}`, 'success');
      } catch (err) {
        console.error('[SL-HN] Error adding house number:', err);
        toast('Error adding house number. See console.', 'error');
      }
    }

    function findNearestSegment(feature, streetName, matchName) {
      const point = { x: feature.lon, y: feature.lat };
      const allSegments = wmeSDK.DataModel.Segments.getAll();
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
        const distance = pointToLineDistance(point, coords);
        if (distance < minDistance) {
          minDistance = distance;
          nearestSegment = segment;
        }
      });

      return nearestSegment;
    }

    function pointToLineDistance(point, coords) {
      const px = point.x;
      const py = point.y;
      let minDist = Infinity;
      for (let i = 0; i < coords.length - 1; i++) {
        const [x1, y1] = coords[i];
        const [x2, y2] = coords[i + 1];
        const dist = pointToSegmentDistance(px, py, x1, y1, x2, y2);
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
            <button id="hn-load" class="wz-button"><span id="hn-load-label">Load selected street</span> <kbd style="font-size:10px;background:#e0e0e0;border:1px solid #aaa;border-radius:3px;padding:1px 4px;">Alt+Shift+L</kbd></button>
            <button id="hn-clear" class="wz-button wz-button--secondary">Clear <kbd style="font-size:10px;background:#e0e0e0;border:1px solid #aaa;border-radius:3px;padding:1px 4px;">Alt+Shift+K</kbd></button>
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
          <div id="hn-status" style="margin-top:10px;font-size:12px;color:#666;line-height:1.4;">
            <b>Instructions</b><br/>
            1) Select a segment • 2) Click "Load selected street" • 3) <b>Click house numbers on map to add them</b><br/>
            Green = selected street • Orange = other streets • Red = possible wrong HN • Faded = already in WME
          </div>
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

        await updateLayer(statusDiv, myLoadId).catch(err => console.warn('SL-HN updateLayer:', err));

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
        currentLoadId++; // invalidate any in-flight load so its results are discarded
        if (lastSdkFeatureIds.length) {
          wmeSDK.Map.removeFeaturesFromLayer({ layerName: SDK_LAYER_NAME, featureIds: lastSdkFeatureIds });
          lastSdkFeatureIds = [];
        }
        userWantsLayerVisible = false;
        wmeSDK.Map.setLayerVisibility({ layerName: SDK_LAYER_NAME, visibility: false });
        setChecked(chkVis, false);
        LS.setLayerVisible(false);
        streets = {};
        streetNames = {};
        currentStreetId = null;
        lastFeatures = [];
        currentStreetDiv.style.display = 'none';
        streetAnalysisDiv.style.display = 'none';
        statusDiv.innerHTML = `<b>Instructions</b><br/>
          1) Select a segment • 2) Click "Load selected street" • 3) <b>Click house numbers on map to add them</b><br/>
          Green = selected street • Orange = other streets • Red = possible wrong HN • Faded = already in WME`;
      }

      btnClear.addEventListener('click', clearLayer);

      applyFeatureFilter = function () {
        const onlyMissing  = chkMissing?.hasAttribute('checked');
        const selectedOnly = chkSelectedOnly?.hasAttribute('checked');
        const visible = lastFeatures.filter(feat => {
          if (onlyMissing && feat.processed) return false;
          if (selectedOnly && currentStreetId && feat.street !== currentStreetId) return false;
          return true;
        });
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
            isSelectedStreet: feat.street === currentStreetId
          }
        }));
        wmeSDK.Map.addFeaturesToLayer({ layerName: SDK_LAYER_NAME, features: visibleSdk });
        lastSdkFeatureIds = visibleSdk.map(f => f.id);
      };

      async function recalculateFeatureStates() {
        if (!lastFeatures.length) return;

        const selectionHNMap = await getVisibleHNsByStreet();

        lastFeatures.forEach(feat => {
          const { number: hn, street: streetId, eX, eY } = feat;
          if (!hn || !streetId) return;

          const entry = selectionHNMap.get(streetId);
          const processed = (entry?.set.has(hn) === true) || feat.userAdded === true;
          const conflict = !processed && hasConflict(hn, eX, eY, entry);

          feat.processed = processed;
          feat.conflict = conflict;
        });

        applyFeatureFilter();
      }

      function setupHouseNumberEventListeners() {
        const events = [
          'wme-house-number-added',
          'wme-house-number-deleted',
          'wme-house-number-moved',
          'wme-house-number-updated'
        ];

        events.forEach(eventName => {
          wmeSDK.Events.on({
            eventName,
            eventHandler: () => {
              if (lastFeatures.length > 0) {
                recalculateFeatureStates().catch(err => console.warn('[SL-HN] recalculate failed:', err));
              }
            }
          });
        });

        wmeSDK.Events.on({
          eventName: 'wme-map-data-loaded',
          eventHandler: () => {
            if (lastFeatures.length > 0) {
              recalculateFeatureStates().catch(err => console.warn('[SL-HN] recalculate failed:', err));
            }
          }
        });

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
          if (on) scheduleRender();
          else clearNavLayer();
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
        catch (e) { console.warn('SL-HN: failed to register shortcut', spec.shortcutId, e); }
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
            fetchAddresses(minE, minN, maxE, maxN),
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

                const entry = selectionHNMap.get(streetId);
                const processed = entry?.set.has(hn) === true;
                const conflict = !processed && hasConflict(hn, e, n, entry);

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
              const selectedNames = [...allStreetIds]
                .map(id => wmeSDK.DataModel.Streets.getById({ streetId: id })?.name)
                .filter(Boolean);

              let best = null, bestCount = -1;
              selectedNames.forEach(name => {
                const sid = streets[name];
                if (!sid) return;
                const count = features.reduce((n,f)=> n + (f.street === sid ? 1 : 0), 0);
                if (count > bestCount) { best = sid; bestCount = count; }
              });

              currentStreetId = best || null;

              if (!features.length) {
                loading.style.display = 'none';
                statusDiv.textContent = 'No address points in view.';
                resolve();
                return;
              }

              lastFeatures = features;

              if (currentStreetId && streetNames[currentStreetId]) {
                streetNameSpan.textContent = streetNames[currentStreetId];
                currentStreetDiv.style.display = 'block';
              } else {
                currentStreetDiv.style.display = 'none';
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
              console.error('[Quick HN Importer] API error:', err);
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
          const numRaw = String(hn.number).trim();

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
        'Editing.setSelection',
        'Editing.getSelection',
        'Map.addLayer',
        'Map.addFeaturesToLayer',
        'Map.removeFeaturesFromLayer',
        'Map.setLayerVisibility',
        'Map.getZoomLevel',
        'Map.getMapExtent',
        'Map.getLonLatFromMapPixel',
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
