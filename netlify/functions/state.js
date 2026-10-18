/**
 * Knockout Blitz — Netlify Serverless Function (/api/state)
 * Delegates to the unified server API controller with Netlify Blobs durable storage.
 */

const { handleApiRequest } = require('../../lib/api-handler');

exports.handler = async (event) => {
  let parsedBody = {};
  if (event.body) {
    try {
      parsedBody = JSON.parse(event.body);
    } catch (err) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid JSON request body' })
      };
    }
  }

  const res = await handleApiRequest({
    method: event.httpMethod,
    headers: event.headers || {},
    body: parsedBody
  });

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.bodyObj !== null && res.bodyObj !== undefined ? JSON.stringify(res.bodyObj) : ''
  };
};
