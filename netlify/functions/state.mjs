/** Netlify's native Functions API supplies the full Blobs context, including strong reads. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { handleApiRequest } = require('../../lib/api-handler');

export default async (request) => {
  let body = {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const text = await request.text();
    if (text) {
      try { body = JSON.parse(text); }
      catch { return Response.json({ error: 'Invalid JSON request body' }, { status: 400 }); }
    }
  }
  try {
    const result = await handleApiRequest({
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body
    });
    return new Response(result.bodyObj == null ? null : JSON.stringify(result.bodyObj), {
      status: result.statusCode,
      headers: result.headers
    });
  } catch (error) {
    console.error('State function failed:', error);
    return Response.json({ error: 'Persistent database is unavailable. Please retry.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' }
    });
  }
};
