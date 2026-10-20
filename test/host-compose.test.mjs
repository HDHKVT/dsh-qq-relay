/**
 * Host-side composition test for the `dsh-qq-relay` browser half.
 *
 * It instantiates the REAL `clientModules` service
 * (`@deepseek-ai/dsh-client-modules`'s `ClientModuleRegistry`) — the same class
 * `dsh web` constructs at boot — against a minimal fake Loader holding exactly
 * one row, the installed `dsh-qq-relay` plugin. Nothing here is a paraphrase of
 * DSH's rules: the scan, the manifest read, the `dsh.client` parse, the bundle
 * snapshot, the boot-graph composition and the `/plugins` response all run in
 * DSH's own shipped code.
 *
 * Proven, without restarting DSH:
 *   1. the row composes into `window.__DSH_BOOT__` with the expected
 *      `inject`/`immediately` fields and a revisioned bundle URL;
 *   2. `clientPath('dsh-qq-relay')` is the real `lib/client.js`;
 *   3. `GET /plugins/??dsh-qq-relay/client.js&rev=…` answers 200
 *      `text/javascript` and the body carries the probe text;
 *   4. unknown resources are 404 and unsupported methods 405.
 *
 * NOT proven: what the authenticated page paints (it returns 401 to a
 * token-less request), and that a browser executes the served body.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const DSH_INSTALL =
  process.env.DSH_INSTALL ?? 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh';
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? 'C:/Users/Administrator/.dsh/profiles/web';
const ROW_NAME = 'dsh-qq-relay';
const CARD_MARKER = 'data-qq-relay-card';

const require = createRequire(`${DSH_INSTALL}/package.json`);
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const { default: ClientModuleRegistry } = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-client-modules')).href
);

const ctx = new Context();
// The one Loader row this profile contributes for the plugin. `fiber` must be
// present (the registry skips fiber-less entries) and `baseUrl` is the owning
// tree's resolution base, exactly as a profile-launched tree supplies it — so
// `dsh-qq-relay/package.json` resolves through the profile's node_modules.
ctx.loader = {
  entries: () => [
    {
      options: { name: ROW_NAME },
      fiber: {},
      disabled: false,
      parent: { tree: { ctx: { baseUrl: `file:///${PROFILE_DIR}/cordis.yml` } } },
    },
  ],
};

// A missing/invalid declaration or an unreadable artifact throws HERE — the same
// loud `ClientPackageCompositionError` a real boot would report.
const registry = new ClientModuleRegistry(ctx);
const graph = registry.graph();
console.log('boot graph entries:', JSON.stringify(graph.entries));
console.log('boot graph batches:', JSON.stringify(graph.batches));

const entry = graph.entries.find((item) => item.id === ROW_NAME);
assert.ok(entry, `${ROW_NAME} did not compose into the boot graph`);
assert.deepEqual(entry.inject, [
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-settings',
]);
assert.equal(entry.immediately, true);
assert.equal(entry.external, undefined, 'empty dsh.client.external must emit no external field');
assert.match(entry.url, new RegExp(`^plugins/\\?\\?${ROW_NAME}/client\\.js&rev=[0-9a-f]{12}$`));

const clientPath = registry.clientPath(ROW_NAME);
console.log('clientPath:', clientPath);
assert.match(String(clientPath).replace(/\\/g, '/'), /\/dsh-qq-relay\/lib\/client\.js$/);

const response = await registry.fetchBundle({ method: 'GET', url: entry.url });
assert.equal(response.status, 200);
assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
assert.match(response.headers.get('cache-control') ?? '', /immutable/);
const body = await response.text();
assert.ok(body.includes(CARD_MARKER), 'served body does not carry the card marker');
assert.ok(body.includes('window.__ModuleLoader__.load('), 'served body is not a lazy-CJS registration table');
console.log(`GET ${entry.url} -> 200, ${body.length} bytes (UTF-16 units)`);

assert.equal((await registry.fetchBundle({ method: 'HEAD', url: entry.url })).status, 200);
assert.equal((await registry.fetchBundle({ method: 'POST', url: entry.url })).status, 405);
assert.equal(
  (await registry.fetchBundle({ method: 'GET', url: '/plugins/??dsh-not-installed/client.js&rev=0123456789ab' }))
    .status,
  404,
);

console.log('host composition test: PASS');
