// ==UserScript==
// @name         WME Quick HN Importer - Slovenia
// @namespace    https://github.com/zigapovhe/wme-sl-hn-import
// @version      2.1.0
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

/* global W, OpenLayers, I18n, proj4, getWmeSdk, unsafeWindow */

(function () {
  'use strict';

  let wmeSDK;
  const LAYER_NAME = 'Quick HN Importer - Slovenia';

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
    setSelectedOnly(v){ localStorage.setItem('qhnsl-selected-only', v ? '1' : '0'); }
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
      const regex = new RegExp(abbrev.replace('.', '\\.') + '\\s*$', 'i');
      normalized = normalized.replace(regex, full);
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

  function getSegmentGeometry(seg) {
    if (!seg) return null;
    if (typeof seg.getOLGeometry === 'function') return seg.getOLGeometry();
    return seg.geometry || seg.attributes?.geometry || null;
  }

  function getHNGeometry(hn) {
    if (!hn) return null;
    if (typeof hn.getOLGeometry === 'function') return hn.getOLGeometry();
    return hn.geometry || hn.attributes?.geometry || null;
  }

  // Build house number string from components
  function buildHouseNumber(stevilka, dodatek) {
    let hn = String(stevilka || '').trim();
    if (dodatek) {
      hn += String(dodatek).trim();
    }
    return hn.toLowerCase();
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
    const selection = W.selectionManager.getSegmentSelection();
    if (!selection.segments || selection.segments.length === 0) {
      toast('No segment selected', 'warning');
      return;
    }

    const segment = selection.segments[0];
    const segmentId = segment.attributes.id;

    // Get current city from the segment
    const currentStreetId = segment.attributes.primaryStreetID;
    const currentStreet = currentStreetId ? W.model.streets.getObjectById(currentStreetId) : null;
    const cityId = currentStreet?.attributes?.cityID;

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
    let isLoading = false;
    let userWantsLayerVisible = false;
    let streetNameSpan = null;
    let currentStreetDiv = null;
    let streetAnalysisDiv = null;

    let chkMissing = null;
    let chkSelectedOnly = null;

    let applyFeatureFilter = () => {};
    let analyzeStreetMatches = () => {};

    const layer = new OpenLayers.Layer.Vector(LAYER_NAME, {
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
            cursor: '${cursor}',
          },
          {
            context: {
              fillColor: f => {
                const a = f.attributes || {};
                if (a.conflict) return '#ff6666';
                return (a.street === currentStreetId) ? '#99ee99' : '#fb9c4f';
              },
              radius: f => (f.attributes && f.attributes.number)
                ? Math.max(f.attributes.number.length * 7, 12)
                : 12,
              opacity: f => {
                const a = f.attributes || {};
                if (a.conflict) return 1;
                return (currentStreetId && a.street === currentStreetId && a.processed) ? 0.3 : 1;
              },
              cursor: f => {
                const a = f.attributes || {};
                return (a.processed) ? '' : 'pointer';
              },
              title: f => (f.attributes && f.attributes.number && f.attributes.street)
                ? `${streetNames[f.attributes.street]} ${f.attributes.number}`
                : ''
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

    function updateLayerVisibility() {
      const currentZoom = W.map.getZoom();
      const shouldBeVisible = userWantsLayerVisible && currentZoom >= 18;

      if (layer.getVisibility() !== shouldBeVisible) {
        layer.setVisibility(shouldBeVisible);

        if (userWantsLayerVisible && currentZoom < 18 && lastFeatures.length > 0) {
          toast('Zoom in to level 18+ to see house numbers', 'info');
        }
      }
    }

    W.map.events.register('zoomend', null, updateLayerVisibility);
    W.map.events.register('moveend', null, updateLayerVisibility);
    W.selectionManager.events.register('selectionchanged', null, onSelectionChanged);

    // Get current WME street name from selection
    function getWmeStreetName() {
      const selection = W.selectionManager.getSegmentSelection();
      if (!selection.segments || selection.segments.length === 0) return null;

      const seg = selection.segments[0];
      const primaryStreetId = seg.attributes.primaryStreetID;
      if (!primaryStreetId) return null;

      const street = W.model.streets.getObjectById(primaryStreetId);
      return street?.attributes?.name || null;
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
      const streetMissing = {};

      lastFeatures.forEach(f => {
        const name = streetNames[f.attributes.street];
        if (!name) return;
        streetCounts[name] = (streetCounts[name] || 0) + 1;
        if (!f.attributes.processed && !f.attributes.conflict) {
          streetMissing[name] = (streetMissing[name] || 0) + 1;
        }
      });

      // Sort by count descending
      const sorted = Object.entries(streetCounts)
        .sort((a, b) => b[1] - a[1]);

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
          html += `<button class="wz-button update-street-btn" data-street="${escapedSuggested}" style="font-size:11px;padding:2px 8px;">✓ Use this name</button>`;
          html += `<button class="copy-street-btn" data-street="${escapedSuggested}" style="font-size:11px;padding:2px 8px;background:#f8f8f8;border:1px solid #ccc;border-radius:3px;cursor:pointer;">📋 Copy</button>`;
          html += `</div>`;
          html += `</div>`;
        }
      }

      html += `<div style="font-size:12px;margin-bottom:4px;"><b>Official streets in area:</b></div>`;
      html += `<div style="max-height:150px;overflow-y:auto;border:1px solid #ddd;border-radius:4px;background:#fafafa;">`;

      sorted.forEach(([name, count], index) => {
        const missing = streetMissing[name] || 0;
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
        html += `<span style="color:#666;">${count}</span>`;
        if (missing > 0) html += `<span style="color:#dc3545;">(${missing})</span>`;
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
      html += `<div style="font-size:10px;color:#888;margin-top:4px;">→ = apply name • 📋 = copy • <span style="color:#dc3545;">(red)</span> = missing</div>`;

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
              layer.redraw();
            }, 100);
          });
        });
      });
    };

    function onSelectionChanged() {
      if (!lastFeatures.length) return;

      const selection = W.selectionManager.getSegmentSelection();
      if (!selection.segments || selection.segments.length === 0) {
        return;
      }

      const selectedStreetIds = new Set();

      selection.segments.forEach(seg => {
        const psid = seg.attributes.primaryStreetID;
        if (psid && psid > 0) selectedStreetIds.add(psid);
        (seg.attributes.streetIDs || []).forEach(id => {
          if (id && id > 0) selectedStreetIds.add(id);
        });
      });

      if (selectedStreetIds.size === 0) {
        currentStreetId = null;
        if (streetNameSpan && currentStreetDiv) {
          streetNameSpan.textContent = '—';
          currentStreetDiv.style.display = 'none';
        }
        layer.redraw();
        applyFeatureFilter();
        analyzeStreetMatches();
        return;
      }

      const selectedStreetNames = Array.from(selectedStreetIds)
        .map(id => W.model.streets.getObjectById(id)?.attributes?.name)
        .filter(Boolean);

      let newStreetId = null;
      let bestCount = -1;

      selectedStreetNames.forEach(name => {
        const sid = streets[name];
        if (!sid) return;
        const count = lastFeatures.reduce(
          (n, f) => n + (f.attributes?.street === sid ? 1 : 0),
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
        layer.redraw();
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

      layer.redraw();
      applyFeatureFilter();
      analyzeStreetMatches();
    }


    // Click hit-test in pixel space (geometry EPSG:3857, W.map expects EPSG:4326)
    function handleMapClick(evt) {
      if (!layer.getVisibility() || !layer.features || !layer.features.length) return;

      const clickPx = evt.xy;
      if (!clickPx) return;

      const features = layer.features;
      const MAX_PIXELS_SQ = MAX_CLICK_DISTANCE_PX * MAX_CLICK_DISTANCE_PX;

      let bestFeature = null;
      let bestDistSq = Infinity;

      for (let i = 0; i < features.length; i++) {
        const f = features[i];
        const g = f.geometry;
        if (!g) continue;

        let lonLat;
        try {
          const [lon, lat] = proj4('EPSG:3857', 'EPSG:4326', [g.x, g.y]);
          lonLat = new OpenLayers.LonLat(lon, lat);
        } catch (e) {
          console.warn('[SL-HN] Failed to transform point for hit-test:', e);
          continue;
        }

        const fPx = W.map.getPixelFromLonLat(lonLat);
        if (!fPx) continue;

        const dx = fPx.x - clickPx.x;
        const dy = fPx.y - clickPx.y;
        const d2 = dx * dx + dy * dy;

        if (d2 <= MAX_PIXELS_SQ && d2 < bestDistSq) {
          bestDistSq = d2;
          bestFeature = f;
        }
      }

      if (!bestFeature) return;

      onFeatureClick(bestFeature);
    }

    W.map.events.register('click', null, handleMapClick);

    function onFeatureClick(feature) {
      const attrs = feature.attributes || {};
      if (attrs.processed) return;

      const streetName = streetNames[attrs.street];
      const houseNumber = attrs.number;

      let nearestSegment = findNearestSegment(feature, streetName, true);

      if (!nearestSegment) {
        nearestSegment = findNearestSegment(feature, streetName, false);

        if (!nearestSegment) {
          toast('No nearby segment found', 'warning');
          return;
        }

        const nearestStreet = W.model.streets.getObjectById(nearestSegment.attributes.primaryStreetID);
        const nearestStreetName = nearestStreet?.attributes?.name || 'Unknown';

        if (!confirm(`Street name "${streetName}" could not be found.\n\nDo you want to add this number to "${nearestStreetName}"?`)) {
          return;
        }
      }

      W.selectionManager.setSelectedModels([nearestSegment]);

      try {
        const [lon, lat] = proj4('EPSG:3857', 'EPSG:4326', [feature.geometry.x, feature.geometry.y]);

        const geojsonGeometry = {
          type: 'Point',
          coordinates: [lon, lat]
        };

        wmeSDK.DataModel.HouseNumbers.addHouseNumber({
          number: houseNumber,
          point: geojsonGeometry,
          segmentId: nearestSegment.attributes.id
        });

        console.log('[SL-HN] Added house number', houseNumber);
        toast(`Added house number ${houseNumber}`, 'success');
      } catch (err) {
        console.error('[SL-HN] Error adding house number:', err);
        toast('Error adding house number. See console.', 'error');
      }
    }

    function findNearestSegment(feature, streetName, matchName) {
      const point = feature.geometry;
      const allSegments = W.model.segments.getObjectArray();
      let candidateSegments = allSegments;

      if (matchName) {
        const matchingStreetIds = W.model.streets.getObjectArray()
          .filter(street => street.attributes.name.toLowerCase() === streetName.toLowerCase())
          .map(street => street.attributes.id);

        if (matchingStreetIds.length === 0) {
          return null;
        }

        candidateSegments = allSegments.filter(segment => {
          const primaryMatch = matchingStreetIds.includes(segment.attributes.primaryStreetID);
          const altMatch = (segment.attributes.streetIDs || []).some(id => matchingStreetIds.includes(id));
          return primaryMatch || altMatch;
        });
      }

      if (candidateSegments.length === 0) {
        return null;
      }

      let nearestSegment = null;
      let minDistance = Infinity;

      candidateSegments.forEach(segment => {
        const geom = getSegmentGeometry(segment);
        if (!geom) return;

        const distance = pointToLineDistance(point, geom);
        if (distance < minDistance) {
          minDistance = distance;
          nearestSegment = segment;
        }
      });

      return nearestSegment;
    }

    function pointToLineDistance(point, line) {
      const px = point.x;
      const py = point.y;
      const coords = line.getVertices();

      let minDist = Infinity;

      for (let i = 0; i < coords.length - 1; i++) {
        const x1 = coords[i].x;
        const y1 = coords[i].y;
        const x2 = coords[i + 1].x;
        const y2 = coords[i + 1].y;

        const dist = pointToSegmentDistance(px, py, x1, y1, x2, y2);
        minDist = Math.min(minDist, dist);
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
            <button id="hn-load" class="wz-button">Load selected street</button>
            <button id="hn-clear" class="wz-button wz-button--secondary">Clear</button>
          </div>
          <div id="hn-current-street" style="margin:8px 0;padding:8px;background:#f0f0f0;border-radius:4px;font-size:13px;display:none;">
            <b>WME selected street:</b> <span id="hn-street-name" style="color:#2a7;font-weight:bold;">—</span>
          </div>
          <div id="hn-street-analysis" style="margin:8px 0;display:none;"></div>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <wz-checkbox id="hn-toggle">Show layer</wz-checkbox>
            <wz-checkbox id="qhnsl-missing">Show only missing</wz-checkbox>
            <wz-checkbox id="qhnsl-selected-only">Selected street only</wz-checkbox>
            <span style="font-size:12px;">Buffer (m): <input id="qhnsl-buffer" type="number" min="0" step="50" style="width:80px;margin-left:6px"></span>
          </div>
          <div id="hn-status" style="margin-top:10px;font-size:12px;color:#666;line-height:1.4;">
            <b>Instructions</b><br/>
            1) Select a segment • 2) Click "Load selected street" • 3) <b>Click house numbers on map to add them</b><br/>
            Green = selected street • Orange = other streets • Red = possible wrong HN • Faded = already in WME
          </div>
        </div>
      `;

      const btnLoad    = tabPane.querySelector('#hn-load');
      const btnClear   = tabPane.querySelector('#hn-clear');
      const chkVis = tabPane.querySelector('#hn-toggle');
      chkMissing = tabPane.querySelector('#qhnsl-missing');
      chkSelectedOnly = tabPane.querySelector('#qhnsl-selected-only');
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
        streetAnalysisDiv.style.display = 'none';

        await updateLayer(statusDiv).catch(() => {});
        userWantsLayerVisible = true;
        setChecked(chkVis, true);
        LS.setLayerVisible(true);
        updateLayerVisibility();

        btnLoad.disabled = false;
        btnLoad.textContent = 'Load selected street';
        isLoading = false;
      });

      btnClear.addEventListener('click', () => {
        layer.removeAllFeatures();
        userWantsLayerVisible = false;
        layer.setVisibility(false);
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
      });

      applyFeatureFilter = function () {
        const onlyMissing = chkMissing?.hasAttribute('checked');
        const selectedOnly = chkSelectedOnly?.hasAttribute('checked');

        layer.removeAllFeatures();
        if (!lastFeatures.length) return;

        let filtered = lastFeatures;

        if (selectedOnly && currentStreetId) {
          filtered = filtered.filter(f => f.attributes?.street === currentStreetId);
        }

        if (onlyMissing) {
          filtered = filtered.filter(f => f.attributes?.conflict || !f.attributes?.processed);
        }

        layer.addFeatures(filtered);
      };

      function recalculateFeatureStates() {
        if (!lastFeatures.length) return;

        const selectionHNMap = getVisibleHNsByStreet();

        lastFeatures.forEach(feature => {
          const { number: hn, street: streetId } = feature.attributes;
          if (!hn || !streetId) return;

          const wx = feature.geometry.x;
          const wy = feature.geometry.y;

          const entry = selectionHNMap.get(streetId);
          const processed = entry?.set.has(hn) === true;

          let conflict = false;
          if (!processed && entry?.items?.length) {
            for (const it of entry.items) {
              if (!it || it.x == null || it.y == null) continue;
              if (it.num !== hn) {
                const dx = wx - it.x, dy = wy - it.y;
                if (dx*dx + dy*dy <= MAX_HN_CONFLICT_DISTANCE * MAX_HN_CONFLICT_DISTANCE) {
                  conflict = true;
                  break;
                }
              }
            }
          }

          feature.attributes.processed = processed;
          feature.attributes.conflict = conflict;
        });

        layer.redraw();
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
                recalculateFeatureStates();
                applyFeatureFilter();
              }
            }
          });
        });

        wmeSDK.Events.on({
          eventName: 'wme-map-data-loaded',
          eventHandler: () => {
            if (lastFeatures.length > 0) {
              recalculateFeatureStates();
              applyFeatureFilter();
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
              layer.redraw();
            }
          }
        });
      }

      setupHouseNumberEventListeners();

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

          let bounds = null;
          selection.segments.forEach(seg => {
            const g = getSegmentGeometry(seg);
            if (!g) return;
            const b = g.getBounds();
            if (!b) return;

            if (bounds == null) {
              bounds = b.clone();
            } else {
              bounds.extend(b);
            }
          });

          if (!bounds) {
            loading.style.display = 'none';
            statusDiv.textContent = 'No geometry for selected segments.';
            resolve();
            return;
          }

          const buffer = LS.getBuffer();
          const b = bounds.clone();
          b.left  -= buffer;
          b.right += buffer;
          b.bottom -= buffer;
          b.top   += buffer;

          // Convert bounds from EPSG:3857 to EPSG:3794
          const bl = proj4('EPSG:3857', 'EPSG:3794', [b.left,  b.bottom]);
          const tr = proj4('EPSG:3857', 'EPSG:3794', [b.right, b.top]);

          const minE = Math.floor(bl[0]);
          const minN = Math.floor(bl[1]);
          const maxE = Math.ceil(tr[0]);
          const maxN = Math.ceil(tr[1]);

          const selectionHNMap = getVisibleHNsByStreet();

          fetchAddresses(minE, minN, maxE, maxN)
            .then(apiFeatures => {
              const features = [];

              for (const item of apiFeatures) {
                const props = item.properties;
                if (!props) continue;

                // Skip addresses without coordinates
                const e = props.E;
                const n = props.N;
                if (e == null || n == null) continue;

                // Convert from EPSG:3794 to EPSG:3857
                const [wx, wy] = proj4('EPSG:3794', 'EPSG:3857', [e, n]);

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

                let conflict = false;
                if (!processed && entry?.items?.length) {
                  const epX = wx, epY = wy;
                  for (const it of entry.items) {
                    if (!it || it.x == null || it.y == null) continue;
                    if (it.num !== hn) {
                      const dx = epX - it.x, dy = epY - it.y;
                      if (dx*dx + dy*dy <= MAX_HN_CONFLICT_DISTANCE * MAX_HN_CONFLICT_DISTANCE) {
                        conflict = true;
                        break;
                      }
                    }
                  }
                }

                features.push(
                  new OpenLayers.Feature.Vector(new OpenLayers.Geometry.Point(wx, wy), {
                    number: hn,
                    street: streetId,
                    processed,
                    conflict
                  })
                );
              }

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

              lastFeatures = features;

              if (currentStreetId && streetNames[currentStreetId]) {
                streetNameSpan.textContent = streetNames[currentStreetId];
                currentStreetDiv.style.display = 'block';
              } else {
                currentStreetDiv.style.display = 'none';
              }

              layer.removeAllFeatures();
              applyFeatureFilter();
              analyzeStreetMatches();

              loading.style.display = 'none';
              statusDiv.innerHTML = `Loaded ${lastFeatures.length} address points.<br/><b>Click numbers on map to add them!</b><br/>Green = selected • Orange = other • Red = possible wrong HN`;
              resolve();
            })
            .catch(err => {
              console.error('[Quick HN Importer] API error:', err);
              loading.style.display = 'none';
              statusDiv.textContent = 'Error fetching address data. See console.';
              toast('Error fetching address data.', 'error');
              resolve();
            });
        });
      }

      // Visible HNs grouped by normalized street name (primary + alternate)
      function getVisibleHNsByStreet() {
        const map = new Map();
        const bounds = W.map.getExtent();

        W.model.segmentHouseNumbers.getObjectArray().forEach(hn => {
          const seg = W.model.segments.getObjectById(hn.attributes.segID);
          if (!seg) return;

          const streetIdSet = new Set();
          if (seg.attributes.primaryStreetID) {
            streetIdSet.add(seg.attributes.primaryStreetID);
          }
          (seg.attributes.streetIDs || []).forEach(id => {
            if (id) streetIdSet.add(id);
          });
          if (!streetIdSet.size) return;

          const g = getHNGeometry(hn);
          let x, y;
          if (g && typeof g.x === 'number' && typeof g.y === 'number') {
            x = g.x;
            y = g.y;
          }
          if (x == null || y == null || !bounds.containsLonLat({ lon: x, lat: y })) return;

          const numRaw = String(hn.attributes.number).trim();

          streetIdSet.forEach(streetId => {
            const st = W.model.streets.getObjectById(streetId);
            const name = st?.attributes?.name;
            if (!name) return;

            const sidNorm = normalizeStreetName(name);

            let entry = map.get(sidNorm);
            if (!entry) {
              entry = { set: new Set(), items: [] };
              map.set(sidNorm, entry);
            }

            entry.set.add(numRaw);
            entry.items.push({ num: numRaw, x, y });
          });
        });

        return map;
      }
    });
  }

  (unsafeWindow || window).SDK_INITIALIZED.then(() => {
    wmeSDK = getWmeSdk({ scriptId: 'quick-hn-sl-importer', scriptName: 'Quick HN Importer (SI)' });
    wmeSDK.Events.once({ eventName: 'wme-ready' }).then(init);
  });
})();