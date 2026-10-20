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
  ['shell.overlay', 'conversation.session.header.actions', 'settings.section'],
  'apply() must defer exactly the three seat registrations (card, header action, settings page)',
);
assert.equal(seatProbe.registered.length, 3, 'each deferred callback must register exactly once');

const card = seatProbe.registered.find((entry) => entry.ownerKey === 'shell.overlay');
const lockAction = seatProbe.registered.find((entry) => entry.ownerKey === 'conversation.session.header.actions');
const settingsPage = seatProbe.registered.find((entry) => entry.ownerKey === 'settings.section');
assert.ok(card && lockAction && settingsPage, 'all three seats must register a component');
assert.equal(settingsPage.options.id, 'qq-relay');
assert.equal(settingsPage.options.order, 120, 'settings page must sit after Skins (115)');
console.log('register(shell.overlay) ->', JSON.stringify(card.options));
console.log('register(header.actions) ->', JSON.stringify(lockAction.options));
assert.equal(card.options.name, 'shell.overlay');
assert.equal(typeof card.options.id, 'string');
assert.ok(card.options.id.startsWith('qq-relay.'), `cell id should be namespaced, got ${card.options.id}`);
assert.equal(typeof card.options.order, 'number');
assert.ok(!('key' in card.options) && !('priority' in card.options), 'list seats take id/order, not key/priority');
assert.equal(lockAction.options.name, 'conversation.session.header.actions');
assert.ok(lockAction.options.id.startsWith('qq-relay.'));

// --------------------------------------------------- execute the component
const harness = createHarness();

const STATUS = {
  protocol: 1, codeVersion: 6,
  sessionId: 'session-fixture-0001-very-long-id-abcdefghijklmnop',
  transport: 'mailbox',
  engineMode: 'relay',
  mailbox: { root: 'X:\\mb', inbox: 2, outbox: 3, done: 4, failed: 1, sent: 5 },
  declaration: { published: true, heartbeatAgeSec: 3, fresh: true },
  runStats: { processed: 7, errors: 0 },
};

/**
 * Fixture for the card's OTHER input: the framework props a ROOT-scope seat
 * hands down.
 *
 * `shell.overlay` passes **no** `sessionId` — the v6 card silently required one
 * and was therefore dead on the real machine — so the current session has to
 * come from the seat's GlobalStandardProps hook `useSessions`. Its snapshot is
 * `SessionListState` (`@deepseek-ai/dsh-api-session-controller`, client types
 * `lib/types/client/sessions/service.d.ts`):
 * `{ ids, byId, phase, projectionsBySession }`, where each row is a
 * `SessionSummary` carrying `retainedBy`.
 *
 * The selected row is the one retained under source `mainView`; that is the
 * rule `ui-session`'s own `publishMain()` applies. The test verifies that rule
 * against the SHIPPED bundles further down, so this fixture cannot quietly
 * drift into a shape only this test believes in.
 */
const CURRENT_SESSION_ID = 'session-fixture-current-0007';
const OTHER_SELECTED_ID = 'session-fixture-other-0001';
const SESSION_LIST = {
  ids: [OTHER_SELECTED_ID, CURRENT_SESSION_ID],
  byId: {
    [OTHER_SELECTED_ID]: {
      id: OTHER_SELECTED_ID, displayTitle: '另一个会话', running: false,
      retainedBy: {}, blank: false, updatedAt: 1,
    },
    [CURRENT_SESSION_ID]: {
      id: CURRENT_SESSION_ID, displayTitle: '当前会话', running: true,
      retainedBy: { mainView: 1 }, blank: false, updatedAt: 2,
    },
  },
  phase: 'ready',
  projectionsBySession: {},
};
/** The same list with the OTHER session selected (selection moved). */
const SESSION_LIST_OTHER_SELECTED = {
  ...SESSION_LIST,
  byId: {
    [OTHER_SELECTED_ID]: { ...SESSION_LIST.byId[OTHER_SELECTED_ID], retainedBy: { mainView: 1 } },
    [CURRENT_SESSION_ID]: { ...SESSION_LIST.byId[CURRENT_SESSION_ID], retainedBy: {} },
  },
};
/** A catalog with nothing selected (the frame shows no conversation). */
const SESSION_LIST_EMPTY = { ids: [], byId: {}, phase: 'empty-with-ready', projectionsBySession: {} };

/**
 * Build the props `shell.overlay` really sends: the standard selector hooks,
 * and deliberately no `sessionId`.
 * @param sessions - initial `SessionListState` snapshot.
 * @returns the stable props object plus a setter to move the selection.
 */
function rootSeatProps(sessions) {
  let live = sessions;
  return {
    props: { useSessions: (selector) => selector(live) },
    /** Move the selection, as the store would between renders. */
    set(next) { live = next; },
  };
}

const rpcCalls = [];
const ctxWithRpc = {
  get: (key) => (key === 'connection'
    ? {
      rpc: {
        async call(channel, endpoint, payload) {
          rpcCalls.push({ channel, endpoint, payload });
          if (endpoint === 'qqRelay/status') return { ok: true, value: STATUS };
          if (endpoint === 'qqRelay/act') return { ok: true, value: { ok: true, text: '已锁定 → fixture' } };
          return { ok: false, error: { code: 'gateway/invocation-unavailable', message: 'nope', details: {} } };
        },
      },
    }
    : undefined),
};
harness.reset();
const livePlugin = mountPlugin(harness.React, ctxWithRpc.get);
harness.setComponent(livePlugin.registered.find((entry) => entry.ownerKey === 'shell.overlay').component);

// 🔴 Rendered with the props the ROOT seat really sends — the v6 test passed
// `{ sessionId: 'session-aaa' }`, a prop no root seat ever supplies, which is
// exactly why a dead lock button could still look green.
const seat = rootSeatProps(SESSION_LIST);
assert.equal(seat.props.sessionId, undefined, 'shell.overlay must not pass a sessionId (that is the bug)');

let tree = await harness.render(seat.props);
// 卡片挂载时会读两次：一次 config（拿去决定显示/隐藏），一次 status
const statusCall = rpcCalls.find((call) => plain(call).endpoint === 'qqRelay/status');
assert.ok(statusCall, 'the card must read status on mount');
assert.deepEqual(plain(statusCall), { channel: '/api', endpoint: 'qqRelay/status', payload: { args: {} } });
// The first render starts the status read; React would re-render on the state
// write, so render once more to observe the settled card.
tree = await harness.rerender(seat.props);
let text = textOf(tree);
console.log('card text ->', text.replace(/\s+/g, ' ').trim().slice(0, 200));
assert.ok(text.includes('QQ 中继'), 'title missing');
assert.ok(text.includes('session-fixture-0001-ver'), 'the locked session id must be shown');
assert.ok(!text.includes('abcdefghijklmnop'), 'a long session id must be truncated');
assert.ok(text.includes('relay'), 'the engine mode must be shown');
assert.ok(text.includes('inbox 2'), 'the mailbox counts must be shown');
assert.ok(text.includes('outbox 3'), 'the mailbox counts must be shown');
assert.ok(text.includes('心跳 3s'), 'the declaration heartbeat must be shown');

const labels = buttonsOf(tree).map((b) => (b.children ?? []).join(''));
console.log('buttons ->', JSON.stringify(labels));
assert.ok(labels.includes('锁定当前会话'), 'the lock button must exist');
assert.ok(labels.includes('解锁'), 'the unlock button must exist');
assert.ok(!labels.includes('刷新'), '不需要手动刷新（卡片自己轮询）');

// Click "lock current session": it must call qqRelay/act with action+sessionId,
// where sessionId is the CURRENT session taken from `useSessions` — not a prop
// the root seat never sends.
let lockButton = buttonsOf(tree).find((b) => (b.children ?? []).join('') === '锁定当前会话');
assert.equal(lockButton.props.disabled, false,
  'a selected session must enable the lock button without any props.sessionId');
lockButton.props.onClick();
tree = await harness.rerender(seat.props);
const actCall = rpcCalls.find((call) => call.endpoint === 'qqRelay/act');
assert.deepEqual(plain(actCall), {
  channel: '/api',
  endpoint: 'qqRelay/act',
  payload: { args: { args: { action: 'lock', sessionId: CURRENT_SESSION_ID } } },
}, 'the lock click must send the exact wire shape the Host expects');
assert.equal(plain(actCall).payload.args.args.sessionId, CURRENT_SESSION_ID,
  'the payload sessionId must EQUAL the currently selected session id');
assert.ok(rpcCalls.filter((c) => c.endpoint === 'qqRelay/status').length >= 2, 'a successful action must refresh the card');
console.log('lock click payload ->', JSON.stringify(actCall.payload));

// The selection is live, not captured once: move it, re-render, click again.
seat.set(SESSION_LIST_OTHER_SELECTED);
tree = await harness.rerender(seat.props);
lockButton = buttonsOf(tree).find((b) => (b.children ?? []).join('') === '锁定当前会话');
lockButton.props.onClick();
tree = await harness.rerender(seat.props);
const movedCall = rpcCalls.filter((c) => c.endpoint === 'qqRelay/act').pop();
assert.equal(plain(movedCall).payload.args.args.sessionId, OTHER_SELECTED_ID,
  'the card must follow the live selection');
console.log('lock click payload after moving the selection ->', JSON.stringify(movedCall.payload));
seat.set(SESSION_LIST);

// 直连模式：信箱/引擎/心跳那三行必须消失（「心跳已过期」在直连下毫无意义）。
// 点一次「解锁」会触发刷新，借它把状态切成 direct 再渲染。
STATUS.transport = 'direct';
const unlockButton = buttonsOf(tree).find((b) => (b.children ?? []).join('') === '解锁');
unlockButton.props.onClick();
tree = await harness.rerender(seat.props);
const directText = textOf(tree);
assert.ok(!directText.includes('inbox 2'), '直连模式下不该显示信箱条数');
assert.ok(!directText.includes('心跳 3s'), '直连模式下不该显示声明心跳');
assert.ok(!buttonsOf(tree).some((b) => (b.children ?? []).join('') === '切到 answer'), '直连模式下不该有切引擎模式按钮');
STATUS.transport = 'mailbox';
console.log('direct-mode card -> 只剩锁定/解锁 ->', textOf(tree).replace(/\s+/g, ' ').trim().slice(0, 120));

// ---- no selection / no hook: refuse LOUDLY and send nothing --------------
// Nothing is selected: the button is disabled, a forced click must not put an
// unusable payload on the wire, and the reason must be visible in the card.
const emptySeat = rootSeatProps(SESSION_LIST_EMPTY);
harness.reset();
const idlePlugin = mountPlugin(harness.React, ctxWithRpc.get);
harness.setComponent(idlePlugin.registered.find((entry) => entry.ownerKey === 'shell.overlay').component);
tree = await harness.render(emptySeat.props);
tree = await harness.rerender(emptySeat.props);
let callsBefore = rpcCalls.length;
let noSelLock = buttonsOf(tree).find((b) => (b.children ?? []).join('') === '锁定当前会话');
assert.equal(noSelLock.props.disabled, true, 'no selected session must disable the lock button');
noSelLock.props.onClick();
tree = await harness.rerender(emptySeat.props);
assert.equal(rpcCalls.length, callsBefore, 'no session id must mean NO qqRelay/act call at all');
assert.ok(textOf(tree).includes('拿不到「当前会话」id'), `the reason must be visible: ${textOf(tree)}`);
assert.ok(textOf(tree).includes('⚠️'), 'the refusal must land in the visible error band');
console.log('no-selection text ->', textOf(tree).replace(/\s+/g, ' ').trim().slice(-150));

// A seat that hands down no `useSessions` at all: same loud refusal, no crash.
harness.reset();
const noHookPlugin = mountPlugin(harness.React, ctxWithRpc.get);
harness.setComponent(noHookPlugin.registered.find((entry) => entry.ownerKey === 'shell.overlay').component);
tree = await harness.render({});
tree = await harness.rerender({});
assert.ok(textOf(tree).includes('拿不到「当前会话」id'), 'a missing useSessions must be reported, not assumed');
assert.ok(textOf(tree).includes('⚠️'), 'a missing useSessions must land in the error band');
console.log('no-hook text ->', textOf(tree).replace(/\s+/g, ' ').trim().slice(-150));

// ---- a FAILED call must appear in the card, not only on the console ------
const failingCtx = {
  get: () => ({
    rpc: {
      async call(channel, endpoint) {
        if (endpoint === 'qqRelay/status') return { ok: true, value: { ...STATUS, sessionId: null, engineMode: 'answer' } };
        return { ok: false, error: { code: 'gateway/arguments-invalid', message: 'wire field "args" failed', details: {} } };
      },
    },
  }),
};
harness.reset();
const failingPlugin = mountPlugin(harness.React, failingCtx.get);
harness.setComponent(failingPlugin.registered.find((entry) => entry.ownerKey === 'shell.overlay').component);
tree = await harness.render(seat.props);
tree = await harness.rerender(seat.props);
assert.ok(textOf(tree).includes('（没锁）'), 'an unlocked host must say so');
const failingUnlock = buttonsOf(tree).find((b) => (b.children ?? []).join('') === '解锁');
failingUnlock.props.onClick();
tree = await harness.rerender(seat.props);
text = textOf(tree);
console.log('failure text ->', text.replace(/\s+/g, ' ').trim().slice(-160));
assert.ok(text.includes('⚠️'), 'a failed call must render a visible error band');
assert.ok(text.includes('gateway/arguments-invalid'), 'the failure code must be visible, not console-only');

// ---- no connection service at all: the card must say so, not crash ------
harness.reset();
const noConnPlugin = mountPlugin(harness.React, () => undefined); // ctx.get("connection") === undefined
harness.setComponent(noConnPlugin.registered.find((entry) => entry.ownerKey === 'shell.overlay').component);
tree = await harness.render(seat.props);
tree = await harness.rerender(seat.props);
text = textOf(tree);
assert.ok(text.includes('⚠️') && text.includes('connection'), `missing connection must be reported: ${text}`);
console.log('no-connection text ->', text.replace(/\s+/g, ' ').trim().slice(0, 160));

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

// ---- the selection rule is the SHIPPED rule, not this test's invention ---
// The fix reads the current session out of `useSessions` by looking for the row
// retained under source `mainView`. Two shipped facts make that valid; both are
// asserted against the real bundles so a future DSH that changes either one
// fails HERE instead of silently bricking the card again.
const sessionBundle = readFileSync(
  join(DSH_INSTALL, 'node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js'), 'utf8');
assert.match(sessionBundle, /retainedBy\.mainView\s*\?\?\s*0\)\s*>\s*0/,
  'ui-session must still pick the main-view binding by retainedBy.mainView');
const slotCatalogue = readFileSync(
  join(DSH_INSTALL, 'node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js'), 'utf8');
const overlayEntry = /\{\s*key:\s*"shell\.overlay"[\s\S]{0,2000}?standardProps:\s*\[([\s\S]{0,800}?)\]/
  .exec(slotCatalogue);
assert.ok(overlayEntry, 'the shipped slot catalogue must still describe shell.overlay');
assert.ok(/useSessions/.test(overlayEntry[1]),
  'shell.overlay must still hand down useSessions — the card depends on it');
console.log('shell.overlay standardProps ->', overlayEntry[1].replace(/\s+/g, ' ').trim());

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
