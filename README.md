# WME Quick HN Importer – Slovenia 🇸🇮

A **Tampermonkey userscript** for Waze Map Editor (WME) that displays official Slovenian house numbers from *EProstor* directly on the WME map.  
This helps editors quickly add and verify house numbers without manually opening external GIS portals.

---

## 🧭 How It Works

After installing the script and opening WME, you’ll find a new **“SL-HN”** tab under the *Scripts* section in the left sidebar.

1. **Select a street segment.**  
2. Click **“Load visible selection.”**  
3. The script fetches nearby address points (via EProstor WFS).  
4. Circles appear on the map:
   - 🟢 **Green:** House numbers that belong to the **selected street**  
   - ⚪️ **Gray:** House numbers for **nearby streets** not matching the selected one
   - 🟥 **Red:** A **conflict** — an existing house number differs from the EProstor value nearby (on the selected or other visible streets, possibly wrong or incorrectly cased, e.g. 4A instead of 4a).

You can:
- Toggle the layer on/off.
- Show only missing house numbers.
- Adjust the search buffer (default: 200 m).

---

## ⚠️ Notes & Gotchas

- **Mismatched street names:**  
  If houses that should be on the selected street show up as **gray**, the street name in Waze may not exactly match the official one in EProstor (different capitalization, spelling, or incorrect naming).  
  → Fix the street name in Waze before adding the house numbers.

- **Red conflicts (wrong or mismatched HNs):**  
  Red circles appear when a **different house number already exists nearby** on the same street.  
  This usually means:
  - The number in WME is **wrong**, or  
  - There’s a **case mismatch** (e.g. `4A` in WME vs `4a` in EProstor).  
  These should be checked and corrected manually in Waze.

- **Limited scope:**  
  Currently only supports **Slovenian EProstor** data (GML/WFS format).

- **Accuracy:**  
  EProstor coordinates are typically precise, but always double-check before adding or adjusting HNs.

- **Development status:**  
  This script is **still in development**. Expect occasional bugs or temporary UI glitches.  
  Please report any issues or improvements.

---

## 🛠️ Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.  
2. [Download this script](./wme-sl-hn-import.js) or open it directly from GitHub’s *Raw* view.  
3. Tampermonkey should prompt you to install it.  
4. Reload Waze Map Editor (beta or production).  
5. Look for the **SL-HN** tab under the *Scripts* section.

---

## 🧩 Technical Info

- Uses WME SDK (`getWmeSdk`) for tab registration and notifications.  
- Loads EProstor data via `GM_xmlhttpRequest` (WFS `GetFeature` → GML).  
- Supports coordinate reprojection (`proj4js`) from EPSG:3794 → EPSG:3857.  
- Saves layer visibility and buffer distance in `localStorage`.

---

## 📅 Version

**0.8.4** – October 2025  
Author: [ThatByte](https://www.waze.com/user/editor/ThatByte)  
License: MIT
