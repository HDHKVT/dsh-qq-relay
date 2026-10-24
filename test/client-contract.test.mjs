import { fileURLToPath } from 'node:url'
/**
 * Contract test for the `dsh-qq-relay` browser half (v6: the control card).
 *
 * It does NOT re-implement DSH's rules from memory where real code is
 * reachable: the `dsh.client` declaration is validated by DSH's OWN
 * `parseDshClient` (materialized out of the shipped
 * `@deepseek-ai/dsh-client-modules/lib/client.js` lazy-CJS bundle), and the
 * plugin bundle is executed through the same
 * `window.__ModuleLoader__.load({id, factory})` handshake the browser uses.
 *
 * What it proves (all on disk, no browser, no network):
 *   1. the host-side scan chain for this package yields a readable artifact
 *      (declaration parses → `exports["./client"]` resolves → the file exists);
 *   2. the registration id equals the package name;
 *   3. the factory materializes resolving ONLY platform seed words, so the
 *      empty `dsh.client.external` is correct;
 *   4. `apply(ctx)` defers BOTH seat registrations (`shell.overlay` and the
 *      `conversation.session.header.actions` list seat);
 *   5. the card renders Host data, exposes the three actions with the exact
 *      Remote names/args the Host half expects, and SURFACES a failed call in
 *      its own DOM (an error must never be console-only).
 *
 * It runs the component against a tiny hook dispatcher rather than React, so
 * "render" here means "the element tree the component returns" — pixel output
 * is still only observable in a browser.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const DSH_INSTALL =
  process.env.DSH_INSTALL ?? 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh';
const CLIENT_MODULES = join(DSH_INSTALL, 'node_modules/@deepseek-ai/dsh-client-modules');

/**
 * The shell's `PLATFORM_MODULES` seed table, read out of the shipped web shell
 * bundle rather than paraphrased. `resolvePlatformSeed()` below scrapes the
 * object literal that `dsh-web-frontend` hands to `createClientModuleSystem`.
 * @returns {string[]} the seed specifiers, sorted.
 */
function resolvePlatformSeed() {
  const dist = join(DSH_INSTALL, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets');
  const entry = readdirSync(dist).find((name) => /^index-.*\.js$/.test(name));
  assert.ok(entry, 'no web shell bundle found');
  const source = readFileSync(join(dist, entry), 'utf8');
  // `function rM(){return{react:Ef,"react/jsx-runtime":If,...}}`
  const match = /return\{\s*(react:[\s\S]{0,900}?)\}\}/.exec(source);
  assert.ok(match, 'platform seed literal not found in the web shell bundle');
  const keys = [...match[1].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)].map(
    (m) => m[1] ?? m[2],
  );
  const seed = keys.filter((key) => !/^(?:rM|return)$/.test(key));
  assert.ok(seed.includes('react'), `seed is missing react: ${seed.join(', ')}`);
  return [...new Set(seed)].sort();
}

/**
 * Materialize one lazy-CJS bundle the way the browser module system does:
 * execute the script with a capturing `window.__ModuleLoader__`, then run the
 * registered factory with a `require` restricted to `allowed`.
 * @param {string} file - absolute path of the bundle.
 * @param {string[]} allowed - the only specifiers `require` may answer.
 * @param {string} [what] - label for assertion messages.
 * @returns {{id: string, exports: any}} the registration id and module exports.
 */
function materializeBundle(file, allowed, what = file) {
  const registrations = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  };
  vm.createContext(sandbox);
  new vm.Script(readFileSync(file, 'utf8'), { filename: file }).runInContext(sandbox);
  assert.equal(registrations.length, 1, `${what}: expected exactly one registration`);
  const { id, factory } = registrations[0];
  assert.equal(typeof factory, 'function', `${what}: registration carries no factory`);
  const requested = [];
  const requireFn = (specifier) => {
    requested.push(specifier);
    assert.ok(allowed.includes(specifier), `${what}: require("${specifier}") is not a platform seed word`);
    // The seed word's value only has to be a usable object for this test.
    return { createElement: (type, props, ...children) => ({ type, props, children }) };
  };
  return { id, exports: factory(requireFn), requested };
}

/**
 * A tiny hook dispatcher: enough of React's contract to drive `useState`,
 * `useEffect`, `useRef`, `useCallback` and `useMemo` deterministically.
 *
 * `render()` returns a promise that settles after the microtask queue drains,
 * so effects that await a Remote call have landed.
 */
function createHarness() {
  let slots = [];
  let cursor = 0;
  let cleanups = [];
  let component = null;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    // The vm context has no timers; the card polls, so supply inert ones.
    setInterval: () => 0,
    clearInterval: () => {},
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
      };
      return [slots[index], set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(fn) {
      const index = cursor++;
      slots[index] = fn;
      return fn;
    },
    useMemo(fn) {
      const index = cursor++;
      slots[index] = fn();
      return slots[index];
    },
    useEffect(fn) {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] = true;
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
    },
  };
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  return {
    React,
    /** Drop all hook state and run pending cleanups (a fresh mount). */
    reset() {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      slots = [];
      cursor = 0;
    },
    setComponent(fn) {
      component = fn;
    },
    async render(props) {
      cursor = 0;
      const tree = component(props);
      await flush();
      return tree;
    },
    /** Render once more, letting state written by the last render settle first. */
    async rerender(props) {
      await flush();
      return this.render(props);
    },
    dispose() {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
    },
  };
}

/** Depth-first walk of a created-element tree. */
/**
 * Deep-copy a value that crossed the `node:vm` realm boundary.
 *
 * The bundle runs in a vm context, so objects it builds have that realm's
 * prototypes; `assert.deepEqual` (strict) then fails on "same structure but not
 * reference-equal" even when the wire payload is byte-identical. Copying
 * through JSON compares the CONTENT, which is what the wire contract is about.
 * @param value - a value produced inside the vm context.
 * @returns a same-realm copy.
 */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function* walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

/** Every string/number rendered in the tree, concatenated. */
function textOf(tree) {
  let out = '';
  for (const node of walk(tree)) {
    for (const child of node.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') out += ` ${child}`;
    }
  }
  return out;
}

/**
 * All rendered buttons.
 *
 * `Btn` is a local component, so it appears as an element whose `type` is that
 * function and whose children are the label; the label text is what identifies
 * the control.
 * @param tree - a created-element tree.
 * @returns the button elements.
 */
function buttonsOf(tree) {
  return [...walk(tree)].filter((node) => (node.children ?? []).some((child) => typeof child === 'string')
    && typeof node.type === 'function'
    && String((node.children ?? []).join('')).match(/锁定|解锁|切到|刷新|收起|展开/));
}

// ---------------------------------------------------------------- host scan
const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
const seed = resolvePlatformSeed();
console.log(`platform seed (${seed.length}): ${seed.join(', ')}`);

const dshModules = materializeBundle(
  join(CLIENT_MODULES, 'lib/client.js'),
  seed,
  'dsh-client-modules/client',
);
assert.equal(typeof dshModules.exports.parseDshClient, 'function');
const declaration = dshModules.exports.parseDshClient(manifest.name, manifest.dsh?.client);
assert.ok(declaration, 'package.json declares no dsh.client');
console.log('parseDshClient ->', JSON.stringify(declaration));

const clientRel = manifest.exports?.['./client'];
assert.equal(typeof clientRel, 'string', 'exports["./client"] must be a string');
const clientPath = join(PKG_DIR, clientRel);
const bundleSource = readFileSync(clientPath, 'utf8'); // throws ENOENT exactly like the host
console.log(`client artifact: ${clientPath} (${bundleSource.length} bytes)`);
assert.ok(declaration.platform === 'web', 'dsh.client.platform must be "web"');
assert.ok(Array.isArray(declaration.external) === false || declaration.external.length === 0,
  'dsh.client.external must stay empty: nothing beyond the seed table is imported');
assert.ok(bundleSource.includes('window.__ModuleLoader__.load('), 'not a lazy-CJS registration table');
assert.ok(!bundleSource.includes('客户端半腿已加载'), 'the v5 probe line must be gone');

// ------------------------------------------------------------- plugin bundle
/**
 * Load the plugin bundle once more with a specific `react` implementation and
 * a recording `slots` service, then apply it to a fake context. Each instance
 * is independent, which is what the closure-held context requires.
 * @param react - the React-like object this instance must render with.
 * @param getService - the `ctx.get` implementation to install.
 * @returns the instance's registrations and requested specifiers.
 */
function mountPlugin(react, getService) {
  const registrations = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  };
  vm.createContext(sandbox);
  new vm.Script(bundleSource, { filename: clientPath }).runInContext(sandbox);
  const requested = [];
  const exports = registrations[0].factory((specifier) => {
    requested.push(specifier);
    assert.ok(seed.includes(specifier), `require("${specifier}") is not a platform seed word`);
    if (specifier === 'react') return react;
    return { createElement: (type, props, ...children) => ({ type, props, children }) };
  });
  const installed = [];
  const registered = [];
  const ctx = {
    get: getService,
    slots: {
      inject: (ownerKey, callback) => {
        installed.push({ ownerKey, callback });
        return () => {};
      },
      register: (options, component) => {
        registered.push({ options, component, ownerKey: options.name });
        return () => {};
      },
    },
  };
  exports.apply(ctx);
  // The shell calls the deferred callback once the seat's declaration exists.
  for (const seat of installed) seat.callback();
  return { requested, exports, seats: installed, registered };
}

const plugin = materializeBundle(clientPath, seed, 'dsh-qq-relay/client');
assert.equal(plugin.id, manifest.name, 'registration id must equal the package name');
console.log(`bundle requested: ${JSON.stringify(plugin.requested)}`);
assert.deepEqual(plugin.requested, ['react'], 'the bundle must request react and nothing else');
// The Cordis service keys this entry waits for.
assert.deepEqual(plain([...plugin.exports.inject]).sort(), ['connection', 'slots']);
assert.equal(typeof plugin.exports.apply, 'function');

// ------------------------------------------------------- slot registration
const lightweightHarness = createHarness();
const seatProbe = mountPlugin(lightweightHarness.React, () => undefined);
assert.deepEqual(
  seatProbe.seats.map((seat) => seat.ownerKey),
  ['conversation.session.header.actions', 'settings.section'],
  'apply() must defer exactly the two seat registrations (header action, settings page)',
);
assert.equal(seatProbe.registered.length, 2, 'each deferred callback must register exactly once');

const lockAction = seatProbe.registered.find((entry) => entry.ownerKey === 'conversation.session.header.actions');
const settingsPage = seatProbe.registered.find((entry) => entry.ownerKey === 'settings.section');
assert.ok(lockAction && settingsPage, 'both seats must register a component');
assert.equal(settingsPage.options.id, 'qq-relay');
assert.equal(settingsPage.options.order, 120, 'settings page must sit after Skins (115)');
console.log('register(header.actions) ->', JSON.stringify(lockAction.options));
assert.equal(lockAction.options.name, 'conversation.session.header.actions');
assert.ok(lockAction.options.id.startsWith('qq-relay.'));

// ---- the header seat action -------------------------------------------
const headerHarness = createHarness();
const headerCalls = [];
const headerPlugin = mountPlugin(headerHarness.React, () => ({
  rpc: { async call(channel, endpoint, payload) { headerCalls.push({ endpoint, payload }); return { ok: true, value: { ok: true, text: '已锁定 → session-bbb' } } } },
}));
const headerComponent = headerPlugin.registered.find((entry) => entry.ownerKey === 'conversation.session.header.actions');
headerHarness.setComponent(headerComponent.component);
let headerTree = await headerHarness.render({ sessionId: 'session-bbb' });
// 挂载时会读一次状态（用来判断"这条是不是已锁定的会话"），但**不能**先动锁
assert.equal(headerCalls.some((call) => call.endpoint === 'qqRelay/act'), false, 'the header button must not lock before a click');
const headerButton = buttonsOf(headerTree)[0];
assert.ok((headerButton.children ?? []).join('').includes('锁定这条会话'), 'header button label');
headerButton.props.onClick();
headerTree = await headerHarness.rerender({ sessionId: 'session-bbb' });
const headerActCall = headerCalls.find((call) => call.endpoint === 'qqRelay/act');
assert.deepEqual(plain(headerActCall), {
  endpoint: 'qqRelay/act',
  payload: { args: { args: { action: 'lock', sessionId: 'session-bbb' } } },
}, 'the header seat must lock the session it renders for');
console.log('header click payload ->', JSON.stringify(headerCalls[0].payload));

// ---- theme tokens only -------------------------------------------------
// Every custom property the bundle names must already be used by the shipped
// platform code — that is the strongest available definition of "a platform
// token". The names are harvested from the theme package, from every shipped
// client bundle, and from the web shell's CSS.
const platformTokens = new Set();
// ⚠️ 不要写死 dist 里的文件名：DSH 每次发版都会换 hash（2026-10-17 升级到
// 0.2.1-rc.2 时 `index-BPHePDI_.css` 就没了）。按目录里实际存在的 `.css` 取。
const assetsDir = join(DSH_INSTALL, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets');
const shellCssFiles = readdirSync(assetsDir).filter((name) => name.endsWith('.css')).map((name) => join(assetsDir, name));
const tokenSources = [
  join(DSH_INSTALL, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
  ...shellCssFiles,
];
const shippedDir = join(DSH_INSTALL, 'node_modules/@deepseek-ai');
for (const name of readdirSync(shippedDir)) {
  const candidate = join(shippedDir, name, 'lib/client.js');
  if (existsSync(candidate)) tokenSources.push(candidate);
}
for (const file of tokenSources) {
  for (const match of readFileSync(file, 'utf8').matchAll(/(--dsw-[a-z0-9-]+)/g)) platformTokens.add(match[1]);
}
assert.ok(platformTokens.size > 100, `token harvest looks wrong: ${platformTokens.size}`);
const usedTokens = [...new Set([...bundleSource.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))].sort();
for (const token of usedTokens) {
  assert.ok(platformTokens.has(token), `unknown platform token in style: ${token}`);
}
console.log(`theme tokens used (all present in the shipped platform): ${JSON.stringify(usedTokens)}`);

console.log('contract test: PASS');
