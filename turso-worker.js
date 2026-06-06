// Cloudflare Worker — Turso Database Proxy (path-preserving)

const TURSO_URL = 'https://examforge-chukwuemekagodson.aws-us-east-2.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODA2NzY1NzEsImlkIjoiMDE5ZTk4OTYtYmQwMS03ZjM0LWExYTMtNzNkYzZiZjg2OWI0IiwicmlkIjoiNWM4M2NlN2QtYmMyOC00NzE5LWI1NjUtZTNhMzRlNzAxNzE5In0.xbL2U_ccoauF-kteJ3WvQMcVeGrl2vW9ND8XJ8ajMpopVIPAEVdbGdvpwNCqbtjIwFsYCfiJN_lcd1Mk9281Ag';

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      // Forward to the SAME path on Turso (preserves /v2/pipeline, /v1/execute, etc.)
      const url = new URL(request.url);
      const targetUrl = TURSO_URL + url.pathname;

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TURSO_TOKEN,
          'Content-Type': 'application/json'
        },
        body: request.body
      });

      const data = await response.json();

      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
