/**
 * Standalone Turso CORS Proxy Server
 * 
 * Use this for local development when the Firebase Cloud Function
 * (tursoProxy) is not deployed.
 * 
 * Usage:
 *   node turso-proxy.js
 * 
 * The proxy runs on http://localhost:3001 and adds CORS headers
 * so browser fetch requests to Turso work without being blocked.
 */

const http = require('http');

const TURSO_URL = 'https://examforge-chukwuemekagodson.aws-us-east-2.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODA2NzY1NzEsImlkIjoiMDE5ZTk4OTYtYmQwMS03ZjM0LWExYTMtNzNkYzZiZjg2OWI0IiwicmlkIjoiNWM4M2NlN2QtYmMyOC00NzE5LWI1NjUtZTNhMzRlNzAxNzE5In0.xbL2U_ccoauF-kteJ3WvQMcVeGrl2vW9ND8XJ8ajMpopVIPAEVdbGdvpwNCqbtjIwFsYCfiJN_lcd1Mk9281Ag';
const PORT = process.env.PORT || 3001;

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Only accept POST
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Read request body
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const response = await fetch(TURSO_URL + '/v2/pipeline', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TURSO_TOKEN,
          'Content-Type': 'application/json'
        },
        body: body
      });

      const text = await response.text();

      if (!response.ok) {
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: text }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (e) {
      console.error('Turso proxy error:', e);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Turso CORS proxy running on http://localhost:${PORT}`);
  console.log(`Proxying requests to ${TURSO_URL}`);
});
