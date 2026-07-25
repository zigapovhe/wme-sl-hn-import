# WME Quick HN Importer – Slovenia 🇸🇮

![SL-HN icon](./icon64.png)

![WME Quick HN Importer preview](./screenshot.png)

A **Tampermonkey userscript** for Waze Map Editor (WME) that displays official Slovenian house numbers from **EProstor** directly on the WME map.  
This helps editors quickly add and verify house numbers without manually opening external GIS portals.

---

## 🧭 How It Works

After installing the script, you'll see a new **SL-HN** tab in the left sidebar of WME.

### Basic workflow
1. **Select a street segment**  
2. Click **"Load selected street"**  
3. The script retrieves nearby address points via EProstor OGC API Features
4. Circles appear on the map and indicate:

| Color | Meaning |
|-------|---------|
| 🟢 Green | House numbers belonging to the **selected street** (primary or alternate) |
| 🟠 Orange | House numbers belonging to **other streets** |
| 🔴 Red | **Conflicts**, e.g. a different nearby existing house number |
| ⚪ Faded green | Already present in WME |

### 👉 Adding house numbers
**Click any circle to instantly add that house number to the nearest matching segment.**

No manual typing is needed — just click.

### ⚙️ Options
- Toggle the layer visibility  
- Show only missing house numbers  
- Show only the selected street  
- Show street names on the map (on by default)  
- Show WME HN audit — see below (off by default)  
- Auto-load addresses when selecting a street (off by default) — fetches only when the selection falls outside the area already loaded, so hopping between nearby streets reuses the data you have  
- Adjust the buffer distance (default: 500 m)

The street names and HN audit overlays follow the main layer: both need **Show layer** on and zoom level 18 or above.

## 🔍 Reverse HN Audit

The normal overlay checks eProstor against WME. This checks the other direction: house numbers that exist **in WME** but do not line up with eProstor — typos, demolished addresses, bad old imports.

Purple markers, in two kinds:

| Marker | Meaning |
| --- | --- |
| 🟣 Solid | The number is **not on that street** in eProstor at all |
| ⚪ Hollow | The number **does exist**, but the WME pin sits more than 30 m from eProstor's point for it |

Hollow markers are the weaker signal — a house number can legitimately sit a building's width from the official point, so treat them as "worth a look", not as proof of an error.

**Clicking a marker centers the map and selects the owning segment** (changing your current selection), then tells you why it was flagged. It never edits or deletes anything — fix it yourself with WME's house-number editor.

Only streets present in the loaded eProstor data are audited, and only inside the area that was fetched. Anything outside stays unflagged rather than being wrongly reported as missing, so pan and press Load again to audit a new area.

## 📍 HN NavPoints Overlay

Optional passive overlay showing every loaded Waze house number as a dashed line from its map pin to its anchor point on the segment, plus the number as a colored label. Color indicates edit state:

- Yellow — untouched default
- White — touched
- Red — untouched + forced
- Orange — touched + forced

Toggle via the "Show HN NavPoints" checkbox. Visible at zoom level 18 and above.

---

### 🧪 Development

The pure logic (house-number normalization, the reverse audit matcher, conflict detection) is unit tested. From the repo root:

```bash
node --test
```

No dependencies and no build step — `node --test` is built into Node, and the userscript ships as the single file it always has. The script exports those functions only when `module` exists, which never happens in Tampermonkey, and its WME entry point is skipped outside a browser.

Layer rendering, click handling and SDK calls are deliberately not tested — they need a real editor, so verify those in WME by hand.

### ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+L` | Load selected street |
| `Alt+Shift+K` | Clear |

Shortcuts are registered via the WME SDK and appear in the WME keyboard shortcuts dialog. You can reassign them there.

---

## 🆕 Street Name Validation (v2.1.0)

The script now includes **street name mismatch detection** to help you fix incorrect street names.

### How it works

When you load addresses, the script analyzes official street names from EProstor and compares them with the selected WME segment:

| Indicator | Meaning |
|-----------|---------|
| ⚠️ Yellow warning | WME street name doesn't match any official names |
| 💡 Green suggestion | Fuzzy match found (typo, abbreviation, or diacritic difference) |
| ✓ Checkmark | Street name matches the current WME segment |
| → Arrow | Click to apply this street name to the segment |

### One-click street name fix
1. Select a segment with an incorrect street name
2. Load the area
3. Find the correct official name in the list
4. Click **→** to instantly update the segment's street name
5. Circles turn green immediately!

### Features
- **Fuzzy matching**: Detects typos, missing diacritics (e.g., "Šmartinska" vs "Smartinska"), and common abbreviations (c. → cesta, ul. → ulica)
- **Copy to clipboard**: Click 📋 to copy any official street name

---

## 🆕 Fix-Street Assist (v2.3.0)

Previously, clicking a house number whose official street didn't exist in WME popped up a browser dialog offering to attach it to the nearest segment — usually the one carrying the *wrong* name. Now the script helps you fix the street instead:

### How it works

Click a house number whose official street name is missing from WME (or exists only suspiciously far away — more than 50 m and twice as far as the nearest segment):

1. 🔵 All house numbers belonging to that official street are **highlighted blue** on the map
2. The segments that probably carry the wrong or missing name are **pre-selected** in WME — adjust the selection with shift-click if the guess is off
3. A floating dialog shows the official name and offers:

| Button | Action |
|--------|--------|
| ✓ Rename selected segments | Renames whatever is selected to the official name, then adds the clicked house number — circles turn 🟢 green immediately, no save needed |
| 📋 Copy name | Copies the official street name to the clipboard |
| Add to "…" anyway | Attaches the house number without renaming anything (e.g. long driveways where the distant named road really is the right target) |
| ✕ Cancel | Closes the dialog, changes nothing |

### Also in v2.3.0

- Renaming a street now applies to **all** selected segments (previously only the first)
- House numbers are never attached to pedestrian paths, boardwalks, stairways, railroads, or runways
- Circles hidden by the filters or by zooming out are no longer clickable
- Unsaved adds/deletes are tracked more reliably and reconciled when you save

### v2.3.1

- Renaming now also works for segments saved without any address — the city is borrowed from the rest of the selection (or from WME's best guess for the area)
- The far-street dialog says "about 448 m" instead of "~448 m", which was easy to misread as a negative distance

---

## ⚠️ Notes & Gotchas

### 🔤 Street name mismatches
If house numbers appear 🟠 orange instead of 🟢 green, the WME street name may not match the official EProstor one.

**New in v2.1.0**: The script now warns you about mismatches and suggests corrections! Look for the yellow warning box and use the → button to fix street names with one click.

### 🔴 Red conflicts
Red numbers appear when:
- Another house number exists nearby but differs  
- Wrong casing (`4A` vs `4a`)  
- Misplaced numbers on the wrong segment  

Always verify manually.

### 🟠 Segments without a street name
If you select a segment **without** a street name:
- All markers become 🟠 orange (because no match is possible)
- Use the street list to apply the correct name with one click

### 📡 Accuracy
EProstor coordinates are normally precise, but always visually verify before adding.

---

## 🛠️ Installation

1. Install **Tampermonkey**  
   https://www.tampermonkey.net/

2. Install the script  
   https://raw.githubusercontent.com/zigapovhe/wme-sl-hn-import/main/wme-sl-hn-import.user.js

3. Reload Waze Map Editor  
4. Open the **SL-HN** tab in the sidebar

---

## 🧩 Technical Info

- Uses WME SDK (`getWmeSdk`) for UI, house numbers, segments, streets, selection, map layer rendering, events, and keyboard shortcuts
- Calls EProstor OGC API Features using `GM_xmlhttpRequest`
- Reprojects EPSG:3794 (Slovenia D96/TM) ↔ EPSG:4326 (WGS84) using `proj4js`
- CQL filters for coordinate-based queries
- Pixel-based hit-testing ensures reliable clicking
- Settings are preserved via `localStorage`

---

## 👤 Author

Author: **ThatByte**  
Waze: https://www.waze.com/user/editor/ThatByte  
License: **MIT**