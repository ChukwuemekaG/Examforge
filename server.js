const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS + JSON for API routes
app.use(express.json({ limit: '10mb' }));

// ─── Turso Proxy ───

const TURSO_URL = 'https://examforge-chukwuemekagodson.aws-us-east-2.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODA2NzY1NzEsImlkIjoiMDE5ZTk4OTYtYmQwMS03ZjM0LWExYTMtNzNkYzZiZjg2OWI0IiwicmlkIjoiNWM4M2NlN2QtYmMyOC00NzE5LWI1NjUtZTNhMzRlNzAxNzE5In0.xbL2U_ccoauF-kteJ3WvQMcVeGrl2vW9ND8XJ8ajMpopVIPAEVdbGdvpwNCqbtjIwFsYCfiJN_lcd1Mk9281Ag';

app.all('/v2/pipeline', async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = JSON.stringify(req.body);
    const options = {
      hostname: 'examforge-chukwuemekagodson.aws-us-east-2.turso.io',
      path: '/v2/pipeline',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TURSO_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const proxyRes = await new Promise((resolve, reject) => {
      const req2 = https.request(options, (res2) => {
        let data = '';
        res2.on('data', chunk => data += chunk);
        res2.on('end', () => resolve({ status: res2.statusCode, data }));
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (proxyRes.status !== 200) {
      res.status(proxyRes.status).json({ error: proxyRes.data });
      return;
    }

    res.json(JSON.parse(proxyRes.data));
  } catch (e) {
    console.error('Turso proxy error:', e);
    res.status(502).json({ error: e.message });
  }
});

// ─── Static Files ───

// Serve the root directory (app.html, login.html, quiz.html, src/, etc.)
app.use(express.static(path.join(__dirname, '.'), {
  setHeaders: (res, filePath) => {
    // Set correct MIME types for .js modules
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
    }
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=UTF-8');
    }
    // No-cache for development
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Fallback: serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fallback to app.html for SPA routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/v2/')) return; // Already handled above
  res.sendFile(path.join(__dirname, 'app.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Examforge server running on http://0.0.0.0:${PORT}`);
  console.log(`Turso proxy at http://0.0.0.0:${PORT}/v2/pipeline`);
});
