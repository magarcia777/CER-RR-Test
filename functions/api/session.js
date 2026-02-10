let cachedMap = null;

async function loadMap(env) {
  if (cachedMap) return cachedMap;
  const req = new Request('https://example.com/data/lecturer-map.json');
  const res = await env.ASSETS.fetch(req);
  if (!res.ok) {
    throw new Error('Unable to load lecturer map');
  }
  cachedMap = await res.json();
  return cachedMap;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequest({ request, env }) {
  const emailHeader = request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('CF-Access-Authenticated-User-Email');

  if (!emailHeader) {
    return jsonResponse(401, { error: 'Missing Cloudflare Access identity.' });
  }

  const email = emailHeader.trim().toLowerCase();
  const map = await loadMap(env);
  const teacherId = map.emailToTeacherId?.[email] || null;

  const adminEmails = (env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  const isAdmin = adminEmails.includes(email);

  if (!teacherId && !isAdmin) {
    return jsonResponse(403, { error: 'No lecturer record found for your account.' });
  }

  return jsonResponse(200, { email, teacherId, isAdmin });
}
