// Vercel entry point: one Node function serves the whole of Northstar.
//
// Vercel hands us the same (req, res) pair Node's http server would, so the
// app needs no rewriting — it just needs to be built once per instance
// instead of once per process, and never told to listen on a port.
//
// What is different about running here is storage, not search. The project
// directory is read-only and /tmp dies with the instance, so each cold start
// builds the bundled corpus in memory and every query reaches the live web.
// Ranking is unchanged: whatever a provider hands over is a list of
// addresses, and Northstar reads and scores those pages itself.

import { createApp } from '../src/api/app.js';

let building = null;

function getApp() {
  // Cached across invocations on a warm instance. On failure the cache is
  // cleared so one bad cold start doesn't poison every later request.
  building ??= createApp().catch((err) => {
    building = null;
    throw err;
  });
  return building;
}

export default async function handler(req, res) {
  let app;
  try {
    app = await getApp();
  } catch (err) {
    console.error('[northstar] failed to start:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: { code: 'startup_failed', message: 'Northstar could not start.' } }));
  }
  return app.handleRequest(req, res);
}
