import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

// Replace <AGENT_DISPATCH_ROOT> with the local checkout path when installing manually.
const ROOT = process.env.AGENT_DISPATCH_ROOT || '<AGENT_DISPATCH_ROOT>';

const { getStateDir } = await import(pathToFileURL(path.join(ROOT, 'src', 'config.mjs')).href);
const { getRunDetailPayload, getRunsPayload, renderDashboardHtml } = await import(
  pathToFileURL(path.join(ROOT, 'src', 'dashboard.mjs')).href
);

const stateDir = getStateDir();
const app = new SidecarApp();

app.page(
  '/',
  () =>
    new Response(renderDashboardHtml({ includePreload: true }), {
      contentType: 'text/html; charset=utf-8',
    })
);

app.api('/api/runs', () => getRunsPayload(stateDir), 'GET');

app.api(
  '/api/run',
  (data) => {
    const runId = data?.id;
    if (!runId) {
      return new Response(JSON.stringify({ error: 'Missing id query parameter' }), {
        status: 400,
        contentType: 'application/json; charset=utf-8',
      });
    }
    try {
      return getRunDetailPayload(stateDir, String(runId));
    } catch (err) {
      return new Response(JSON.stringify({ error: err?.message || 'Run not found' }), {
        status: 404,
        contentType: 'application/json; charset=utf-8',
      });
    }
  },
  'GET'
);

await app.run();
