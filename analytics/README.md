# WME HN Analytics

Anonymous house number addition counter powered by Cloudflare Workers + D1.

Tracks only: country code + timestamp. No user identification, no PII.

## Setup

### 1. Create the D1 database

```sh
npx wrangler d1 create wme-hn-analytics
```

Copy the `database_id` from the output into `wrangler.toml`.

### 2. Initialize the schema

```sh
npm run db:init
```

### 3. Set the export API key

```sh
npx wrangler secret put EXPORT_API_KEY
```

Enter a strong random string when prompted. You'll use this key to access the `/export` endpoint.

### 4. Deploy

```sh
npm run deploy
```

### 5. Update the userscript

Replace `YOURUSERNAME` in the `ANALYTICS_URL` constant with your Cloudflare Workers subdomain (or use a custom domain).

## Endpoints

### `POST /track`

Called by the userscript on each successful house number addition.

```json
{ "country": "SI" }
```

### `GET /export`

Requires `X-API-Key` header matching your `EXPORT_API_KEY` secret.

Query params:
- `country` — filter by country code (e.g. `SI`)
- `year` — filter by year (e.g. `2025`)
- `format` — `json` (default) or `csv`

Examples:

```sh
# All data as JSON
curl -H "X-API-Key: YOUR_KEY" https://wme-hn-analytics.YOURUSERNAME.workers.dev/export

# Slovenia 2025 as CSV
curl -H "X-API-Key: YOUR_KEY" "https://wme-hn-analytics.YOURUSERNAME.workers.dev/export?country=SI&year=2025&format=csv"
```

### `GET /health`

Returns `{"status":"ok"}`. No auth required.
