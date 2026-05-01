interface Env {
  DB: D1Database;
  EXPORT_API_KEY: string;
}

const VALID_COUNTRIES = new Set([
  'SI', 'HR', 'AT', 'HU', 'IT', 'DE', 'CZ', 'SK', 'PL',
  'RS', 'BA', 'ME', 'MK', 'AL', 'BG', 'RO', 'CH', 'FR',
  'BE', 'NL', 'LU', 'DK', 'SE', 'NO', 'FI', 'EE', 'LV',
  'LT', 'PT', 'ES', 'GB', 'IE', 'GR', 'CY', 'MT', 'TR',
  'UA', 'MD', 'BY', 'RU', 'GE', 'AM', 'AZ', 'KZ', 'IL',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/track') {
      return handleTrack(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/export') {
      return handleExport(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok' });
    }

    return json({ error: 'Not found' }, 404);
  },
};

async function handleTrack(request: Request, env: Env): Promise<Response> {
  let body: { country?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const country = body.country?.toUpperCase()?.trim();
  if (!country || !VALID_COUNTRIES.has(country)) {
    return json({ error: 'Invalid country code' }, 400);
  }

  await env.DB.prepare('INSERT INTO hn_events (country) VALUES (?)')
    .bind(country)
    .run();

  return json({ ok: true });
}

async function handleExport(request: Request, env: Env): Promise<Response> {
  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey || apiKey !== env.EXPORT_API_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const country = url.searchParams.get('country')?.toUpperCase();
  const year = url.searchParams.get('year');
  const format = url.searchParams.get('format') ?? 'json';

  let query = `
    SELECT country,
           strftime('%Y', added_at) AS year,
           strftime('%m', added_at) AS month,
           COUNT(*) AS count
    FROM hn_events
    WHERE 1=1
  `;
  const params: string[] = [];

  if (country) {
    query += ' AND country = ?';
    params.push(country);
  }
  if (year) {
    query += " AND strftime('%Y', added_at) = ?";
    params.push(year);
  }

  query += ' GROUP BY country, year, month ORDER BY country, year, month';

  const stmt = env.DB.prepare(query);
  const result = await (params.length > 0
    ? stmt.bind(...params)
    : stmt
  ).all<{ country: string; year: string; month: string; count: number }>();

  if (format === 'csv') {
    const lines = ['country,year,month,count'];
    for (const row of result.results) {
      lines.push(`${row.country},${row.year},${row.month},${row.count}`);
    }
    return new Response(lines.join('\n'), {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="hn-analytics-export.csv"`,
      },
    });
  }

  return json(result.results);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
