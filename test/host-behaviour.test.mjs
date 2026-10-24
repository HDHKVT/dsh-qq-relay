/**
 * Host-side behaviour test for `dsh-qq-relay` v6 (the browser-facing Remote).
 *
 * Two layers, both against the REAL shipped code:
 *
 *  A. the plugin's own Host half (`index.js`) is loaded with
 *     `LOCALAPPDATA` redirected into `test/fixture/` and applied to a fake
 *     Cordis-like context. That exercises the four paths the task says must
 *     keep working — mailbox ingest, `relay.json`, the four tools, declaration
 *     + heartbeat — plus the two new Remote methods.
 *
 *  B. the Round-3 addition is wired to the REAL Typert Gateway
 *     (`@deepseek-ai/dsh-api-gateway`) on a REAL Cordis `Context`: the gateway
 *     must CLAIM `qqRelay/status` and `qqRelay/act`, dispatch them in SRC mode,
 *     and carry a business throw back as a Remote failure. The call goes in
 *     through the same `rpc.call("/api", endpoint, { args })` shape the browser
 *     half uses, so the wire contract is proven, not assumed.
 *
 * NOT proven here: that a browser executes the bundle, that the seat renders,
 * and that a running DSH process picks the new boot graph up (that needs the
 * restart).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = dirname(HERE);
const FIXTURE = join(HERE, 'fixture');
const MEDIA = join(FIXTURE, 'media');
const APP_DIR = join(FIXTURE, 'app');
const MAILBOX = join(FIXTURE, 'mailbox');
const INBOX = join(MAILBOX, 'inbox');
const LOCK_SESSION = 'session-fixture-0001';
const LOCK_SESSION_2 = 'session-fixture-0002';

// DSH 装在哪因机器而异：优先环境变量，其次问 npm，最后才猜默认路径。
const { execFileSync } = await import('node:child_process');

function findDshInstall() {
  if (process.env.DSH_INSTALL) return process.env.DSH_INSTALL;
  const candidates = [];
  try {
    const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (root) candidates.push(`${root}/@deepseek-ai/dsh`);
  } catch { /* npm 不在或超时：继续用候选 */ }
  if (process.env.APPDATA) candidates.push(`${process.env.APPDATA}/npm/node_modules/@deepseek-ai/dsh`);
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh');
  return candidates.find((dir) => dir && existsSync(`${dir}/package.json`)) ?? candidates[0];
}

const DSH_INSTALL = findDshInstall();
const require = createRequire(`${DSH_INSTALL}/package.json`);

// ---------------------------------------------------------------- fixture
rmSync(FIXTURE, { recursive: true, force: true });
for (const dir of [MEDIA, join(APP_DIR, 'data'), INBOX, join(MAILBOX, 'outbox'), join(MAILBOX, 'done'), join(MAILBOX, 'failed')]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(
  join(MEDIA, 'relay.json'),
  JSON.stringify({ sessionId: LOCK_SESSION, transport: 'mailbox', mailbox: MAILBOX, hint: false }, null, 2),
  'utf8',
);
writeFileSync(join(APP_DIR, 'data', 'settings.json'), JSON.stringify({ qqMode: 'answer', other: 1 }, null, 2), 'utf8');
// One pre-existing inbox letter: the mailbox path must ingest it without a restart.
const LETTER_ID = '20261016-235900-abc123';
writeFileSync(
  join(INBOX, `${LETTER_ID}.json`),
  JSON.stringify({
    protocol: 1, id: LETTER_ID, at: Date.now(),
    from: { scope: 'private:fixture', who: '主人', msgId: 'm-1' },
    kind: 'text', text: '驻留测试：这条必须被投进锁定会话', ack: true,
  }, null, 2),
  'utf8',
);

// 🔴 Redirect every env-derived path BEFORE importing the plugin: its module
// scope freezes BASE/CONFIG and the app dir. Nothing here touches the real
// `D:\dsh-plugins\_media\dsh-qq-relay` or `%LOCALAPPDATA%\DaisyQQCottage`.
process.env.DSH_QQ_RELAY_BASE = MEDIA;
process.env.DSH_QQ_RELAY_APP_DIR = APP_DIR;
process.env.DSH_QQ_RELAY_DECL_DIR = FIXTURE;

const plugin = await import(pathToFileURL(join(PKG_DIR, 'index.js')).href);
assert.equal(typeof plugin.apply, 'function');

// ================================================================== layer A
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const protocol = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-protocol')).href);
const { TypertGatewayService } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-api-gateway')).href);

const root = new Context();
const calls = [];
const prompts = [];
const tools = new Map();
const disposers = [];

root.provide('typert', {
  // Empty strict registry + no declared lookups is exactly the "never had a
  // strict definition" case SRC mode exists for.
  local: { get: () => undefined, hasSeen: () => false },
  lookups: { definitions: () => [] },
  registry: {},
});
let gateway = null;
/** DSH 0.2.1 起 `dispatchRpc` 的 peer 是必有的：网关会读 signal / principal / interactions。 */
const PEER_SIGNAL = new AbortController().signal;
const PEER = { signal: PEER_SIGNAL, interactions: 'answer', principal: { kind: 'owner' } };
const connection = {
  rpc: {
    intercept() {},
    call: (channel, endpoint, payload) => {
      calls.push({ channel, endpoint, payload });
      assert.equal(channel, '/api');
      return gateway.dispatchRpc(endpoint, payload, PEER_SIGNAL, PEER);
    },
  },
};
root.provide('connection', connection);
const gwFiber = root.plugin({
  name: 'fixture-gateway',
  inject: ['typert'],
  apply(c) { gateway = new TypertGatewayService(c, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 }) },
});
await new Promise((r) => setTimeout(r, 80));
assert.ok(gateway, 'gateway did not install');

const toolsService = {
  register(def) {
    tools.set(def.name, def);
    return () => tools.delete(def.name);
  },
};
root.provide('tools', toolsService);
root.provide('sessionController', {
  async list() { return { items: [{ sessionId: LOCK_SESSION, cwd: MAILBOX, agentAvailable: false, running: false, blank: false }] } },
  async prompt(request, signal) {
    prompts.push(request);
    return { accepted: true };
  },
});

// A Cordis-like context: the plugin only uses get/inject/on/provide.
const fakeCtx = {
  get: (key) => root.get(key),
  provide: (key, value) => { root.provide(key, value); return value },
  inject: (deps, cb) => { cb(fakeCtx); return () => {} },
  on: (event, cb) => { if (event === 'dispose') disposers.push(cb); return () => {} },
};

plugin.apply(fakeCtx, {});
await new Promise((r) => setTimeout(r, 150));

// ---- 1. the Remote service is registered and mirror-visible --------------
assert.ok(root.get('qqRelayRemote'), 'ctx.qqRelayRemote was not provided');
const remoteInstance = root.get('qqRelayRemote');
assert.equal(remoteInstance.typertRemote.namespace, 'qqRelay');
assert.equal(remoteInstance.typertRemote.serviceKey, 'qqRelayRemote');
assert.equal(remoteInstance.typertRemote.service, remoteInstance, 'binding identity must hold');
assert.deepEqual(
  protocol.remoteMethods(remoteInstance).map((m) => m.method),
  ['status', 'act', 'config', 'configUpdate', 'biliCard', 'biliLoginStart', 'biliLoginPoll', 'biliLogout', 'imageClear', 'openImageDir', 'logTail', 'logClear', 'faces', 'facesImport', 'facesReset', 'fileClear', 'openFileDir', 'videoClear', 'openVideoDir', 'biliClear', 'openBiliDir'],
  'the marker must declare status + act + the settings pair',
);
console.log('A1 remote service registered:', JSON.stringify(remoteInstance.typertRemote.namespace));

// ---- 2. the tools still register, with the same names --------------
assert.deepEqual(
  [...tools.keys()].sort(),
  ['analyze_video', 'bili_frame', 'bili_login_check', 'bili_login_start', 'bili_peek', 'download_bili', 'qq_send_file', 'qq_send_image', 'relay_engine', 'relay_lock', 'relay_status', 'relay_unlock', 'sticker_list', 'sticker_name', 'sticker_send'],
  'tool names must not change (qq_send_* / sticker_* / analyze_video added 2026-10-18~20; bili_peek added 2026-10-24)',
);
const toolNames = [...tools.keys()].sort().join(',');
console.log('A2 tools registered:', toolNames);

// ---- 3. the pre-existing inbox letter was ingested ----------------------
assert.equal(prompts.length, 1, `expected exactly one prompt, got ${prompts.length}`);
assert.equal(prompts[0].sessionId, LOCK_SESSION);
assert.equal(prompts[0].mode, 'queue');
assert.equal(prompts[0].requestId, `qq-${LETTER_ID}`, 'requestId must carry the engine id');
assert.equal(prompts[0].content.length, 1);
assert.equal(prompts[0].content[0].text, '驻留测试：这条必须被投进锁定会话', 'hint:false must keep the body verbatim');
assert.ok(readdirSync(join(MAILBOX, 'done')).some((n) => n.endsWith('.json')), 'the letter must be archived into done/');
assert.ok(readdirSync(join(MAILBOX, 'outbox')).some((n) => n.endsWith('.json')), 'a receipt must be written to outbox/');
const doneFiles = readdirSync(join(MAILBOX, 'done'));
console.log('A3 mailbox ingest ok — prompts:', prompts.length, '| done:', JSON.stringify(doneFiles));

// ---- 4. declaration + heartbeat -----------------------------------------
const declFile = join(FIXTURE, 'mailbox.json');
assert.ok(existsSync(declFile), 'mailbox.json was not published');
const decl = JSON.parse(readFileSync(declFile, 'utf8'));
assert.equal(decl.protocol, 1);
assert.equal(decl.owner, 'dsh-plugin:dsh-qq-relay');
assert.equal(decl.sessionId, LOCK_SESSION);
assert.equal(String(decl.mailbox).replace(/\\/g, '/'), MAILBOX.replace(/\\/g, '/'));
assert.ok(Date.now() - decl.heartbeat < 10000, 'heartbeat must be fresh');
console.log('A4 declaration published:', declFile, '| owner:', decl.owner);

// ---- 5. tool relay_status still prints the v5 lines ---------------------
const statusOut = await tools.get('relay_status').execute({}, {});
const statusText = statusOut.content[0].text;
for (const needle of ['锁定会话：' + LOCK_SESSION, '引擎 QQ 模式：answer', '信箱条数：inbox', '声明：']) {
  assert.ok(statusText.includes(needle), `relay_status lost ${JSON.stringify(needle)}\n${statusText}`);
}
console.log('A5 relay_status text kept its shape');

// ---- 6. the new Remote methods, invoked through the REAL gateway --------
const statusCall = await connection.rpc.call('/api', 'qqRelay/status', { args: {} });
assert.equal(statusCall.ok, true, JSON.stringify(statusCall));
const snapshot = statusCall.value;
assert.equal(snapshot.protocol, 1);
assert.equal(snapshot.sessionId, LOCK_SESSION);
assert.equal(snapshot.engineMode, 'answer');
assert.equal(snapshot.mailbox.root.replace(/\\/g, '/'), MAILBOX.replace(/\\/g, '/'));
assert.equal(snapshot.mailbox.inbox, 0, 'the letter was moved out of inbox');
assert.equal(snapshot.mailbox.done, 1);
assert.equal(snapshot.mailbox.outbox, 1);
assert.equal(snapshot.declaration.fresh, true);
assert.equal(snapshot.declaration.published, true);
console.log('A6 qqRelay/status ->', JSON.stringify({
  sessionId: snapshot.sessionId, engineMode: snapshot.engineMode,
  counts: { inbox: snapshot.mailbox.inbox, done: snapshot.mailbox.done, outbox: snapshot.mailbox.outbox },
  declFresh: snapshot.declaration.fresh,
}));

// 6a. 设置页那两个端点：写进去、读出来**只有 hasSecret**（密钥绝不过网）
const saveCall = await connection.rpc.call('/api', 'qqRelay/configUpdate', {
  args: { patch: { direct: { appId: 'app-fixture', appSecret: 'secret-fixture', ownerId: 'owner-fixture' } } },
})
assert.equal(saveCall.ok, true, JSON.stringify(saveCall))
assert.deepEqual(JSON.parse(JSON.stringify(saveCall.value)), { saved: true }, '配置写入应当成功')
const configCall = await connection.rpc.call('/api', 'qqRelay/config', { args: {} })
assert.equal(configCall.ok, true, JSON.stringify(configCall))
const publicCfg = JSON.parse(JSON.stringify(configCall.value))
assert.equal(publicCfg.direct.appId, 'app-fixture')
assert.equal(publicCfg.direct.hasSecret, true, '要告诉界面“已配置”')
assert.equal(publicCfg.direct.appSecret, undefined, '明文密钥不许出现在 RPC 返回值里')
console.log('A6b qqRelay/config ->', JSON.stringify(publicCfg.direct))

// 6b-bis. 日志尾巴 / 清空（设置页「日志」一节的两个端点）
const tailCall = await connection.rpc.call('/api', 'qqRelay/logTail', { args: { lines: 5 } })
assert.equal(tailCall.ok, true, JSON.stringify(tailCall))
assert.ok(Array.isArray(tailCall.value.lines), 'logTail 要回 lines 数组')
assert.ok(tailCall.value.path.endsWith('probe.log'), 'logTail 要告诉界面日志在哪')
const clearCall = await connection.rpc.call('/api', 'qqRelay/logClear', { args: {} })
assert.equal(clearCall.ok, true, JSON.stringify(clearCall))
assert.equal(clearCall.value.cleared, true)
assert.equal(tailCall.value.path ? readFileSync(tailCall.value.path, 'utf8') : '', '', '清空后文件应为空')
console.log('A6b-bis logTail/logClear -> OK')

// 6b-ter. 表情表：导入一份自定义 JSON，只收合法条目；恢复内置表
const faceFile = join(MEDIA, 'faces-test.json')
writeFileSync(faceFile, JSON.stringify({ 478: '捂脸笑', bad: 'x', 500: '' }), 'utf8')
const importCall = await connection.rpc.call('/api', 'qqRelay/facesImport', { args: { file: faceFile } })
assert.equal(importCall.ok, true, JSON.stringify(importCall))
assert.equal(importCall.value.ok, true, JSON.stringify(importCall.value))
assert.equal(importCall.value.imported, 1, '只收“数字键 + 非空名字”的条目')
assert.equal(importCall.value.skipped, 2)
const facesInfo = await connection.rpc.call('/api', 'qqRelay/faces', { args: {} })
assert.equal(facesInfo.value.custom, 1)
assert.ok(facesInfo.value.builtin > 50)
assert.ok(existsSync(join(MEDIA, 'faces.json')), '导入要落盘成 faces.json')
const resetCall = await connection.rpc.call('/api', 'qqRelay/facesReset', { args: {} })
assert.equal(resetCall.value.ok, true)
assert.equal((await connection.rpc.call('/api', 'qqRelay/faces', { args: {} })).value.custom, 0)
console.log('A6b-ter faces import/reset -> OK')

// 6b. 留空 = 不修改（界面保存时不会重复回传密钥）
await connection.rpc.call('/api', 'qqRelay/configUpdate', { args: { patch: { direct: { appSecret: '' } } } })
assert.equal(JSON.parse(readFileSync(join(MEDIA, 'relay.json'), 'utf8')).direct.appSecret, 'secret-fixture', '空密钥不能把已存的密钥清掉')

// 6b-quater. 文件目录清空（空目录也要能安全返回）
const fileClearCall = await connection.rpc.call('/api', 'qqRelay/fileClear', { args: {} })
assert.equal(fileClearCall.ok, true, JSON.stringify(fileClearCall))
assert.equal(typeof fileClearCall.value.removed, 'number')
assert.ok(fileClearCall.value.dir.endsWith('files'), '要回文件目录路径')

// 6b-quinquies. 临时图库清空：真放一张图进去，清完必须没了
{
  const incoming = join(MEDIA, 'images', 'incoming')
  mkdirSync(incoming, { recursive: true })
  writeFileSync(join(incoming, '20260101-000000-test-1.png'), 'x', 'utf8')
  writeFileSync(join(incoming, '20260101-000000-test-1.png.json'), '{}', 'utf8')
  const cleared = await connection.rpc.call('/api', 'qqRelay/imageClear', { args: {} })
  assert.equal(cleared.ok, true, JSON.stringify(cleared))
  assert.ok(cleared.value.removed >= 1, `要删掉至少一张：${JSON.stringify(cleared.value)}`)
  assert.equal(readdirSync(incoming).length, 0, '清空后 incoming 应为空')
}

// 6c. 传输开关：切到 direct 立刻生效（appId 为空 ⇒ 不连外网，但状态要如实说）
const clearApp = await connection.rpc.call('/api', 'qqRelay/configUpdate', { args: { patch: { direct: { appId: '' } } } })
assert.equal(clearApp.ok, true)
const toDirect = await connection.rpc.call('/api', 'qqRelay/configUpdate', { args: { patch: { transport: 'direct' } } })
assert.equal(toDirect.value.saved, true, '切传输要写成功')
const directStatus = await connection.rpc.call('/api', 'qqRelay/status', { args: {} })
assert.equal(directStatus.value.transport, 'direct', '状态里要如实报当前传输')
assert.equal(directStatus.value.direct, null, '缺 appId 时不该建出传输对象')
const toMailbox = await connection.rpc.call('/api', 'qqRelay/configUpdate', { args: { patch: { transport: 'mailbox' } } })
assert.equal(toMailbox.value.saved, true, '能切回信箱')
console.log('A6c transport switch -> direct -> mailbox OK')

// 6a. lock a DIFFERENT session through the wire (the header-seat action)
const lockCall = await connection.rpc.call('/api', 'qqRelay/act', { args: { args: { action: 'lock', sessionId: LOCK_SESSION_2 } } });
assert.equal(lockCall.ok, true, JSON.stringify(lockCall));
assert.equal(lockCall.value.ok, true, JSON.stringify(lockCall.value));
assert.equal(JSON.parse(readFileSync(join(MEDIA, 'relay.json'), 'utf8')).sessionId, LOCK_SESSION_2, 'relay.json was not re-locked');
assert.equal(JSON.parse(readFileSync(declFile, 'utf8')).sessionId, LOCK_SESSION_2, 'restartMailbox must republish the declaration');
// other relay.json keys must survive the write
assert.equal(JSON.parse(readFileSync(join(MEDIA, 'relay.json'), 'utf8')).mailbox, MAILBOX);
console.log('A6a act(lock) -> relay.json + declaration now', LOCK_SESSION_2);

// 6b. switch the engine mode (both directions + validation)
const modeCall = await connection.rpc.call('/api', 'qqRelay/act', { args: { args: { action: 'mode', mode: 'relay' } } });
assert.equal(modeCall.ok, true);
assert.equal(modeCall.value.ok, true);
assert.equal(JSON.parse(readFileSync(join(APP_DIR, 'data', 'settings.json'), 'utf8')).qqMode, 'relay');
assert.equal(JSON.parse(readFileSync(join(APP_DIR, 'data', 'settings.json'), 'utf8')).other, 1, 'other settings keys must survive');
assert.ok(existsSync(join(APP_DIR, 'data', 'settings.json.bak')), 'a .bak must be left');
const badMode = await connection.rpc.call('/api', 'qqRelay/act', { args: { args: { action: 'mode', mode: 'sideways' } } });
assert.equal(badMode.value.ok, false, 'an unknown mode must be refused, not silently applied');
assert.ok(badMode.value.text.includes('relay'), badMode.value.text);
console.log('A6b act(mode) -> settings.qqMode=relay, .bak present, bad mode refused with text');

// 6c. unlock
const runErrors = async () => {
  const text = (await tools.get('relay_status').execute({}, {})).content[0].text;
  const match = /报错 (\d+) 条/.exec(text);
  assert.ok(match, `relay_status must report its run error count:\n${text}`);
  return Number(match[1]);
};
// 记一个基线：前面切传输时可能已经记过一条（例如“缺凭据”），这里只关心 unlock 带来的增量
const errorsBeforeUnlock = await runErrors();
const unlockCall = await connection.rpc.call('/api', 'qqRelay/act', { args: { args: { action: 'unlock' } } });
assert.equal(unlockCall.value.ok, true);
assert.equal(JSON.parse(readFileSync(join(MEDIA, 'relay.json'), 'utf8')).sessionId, null);
console.log('A6c act(unlock) -> sessionId null');

// 6c-bis. WHAT MOVES THE HOST'S `报错 N 条` COUNTER (seen on the real machine
// as `报错 3 条`). The counter is `report.relay.errors.length`, read here
// through the relay_status TOOL: `statusText()` is the live value, while the
// Remote `status()` is behind a 30s cache and would hide a delta.
// `unlock` nulls relay.json's sessionId and then restarts the mailbox; with no
// sessionId `startMailbox` early-returns and RECORDS one error
// (`relay.json 里没有 sessionId …`). A lock click that arrives WITHOUT an id is
// NOT an error — it is a business refusal handed back to the card.
const errorsAfterFirstUnlock = await runErrors();
assert.equal(errorsAfterFirstUnlock, errorsBeforeUnlock + 1, 'unlock-while-unlocked records exactly one run error');
const noIdLock = await connection.rpc.call('/api', 'qqRelay/act', { args: { args: { action: 'lock' } } });
assert.equal(noIdLock.ok, true, 'a business refusal is still a Remote success envelope');
assert.equal(noIdLock.value.ok, false, noIdLock.value.text);
assert.ok(noIdLock.value.text.includes('没有可锁的会话'), noIdLock.value.text);
assert.equal(await runErrors(), errorsAfterFirstUnlock, 'a lock with no sessionId must NOT add a run error');
const secondUnlock = await connection.rpc.call('/api', 'qqRelay/act', { args: { args: { action: 'unlock' } } });
assert.equal(secondUnlock.value.ok, true, JSON.stringify(secondUnlock.value));
assert.equal(await runErrors(), errorsAfterFirstUnlock + 1, 'each extra unlock adds exactly one run error');
console.log(
  'A6c-bis run errors -> after unlock:', errorsAfterFirstUnlock,
  '| lock-without-id: unchanged | after unlock #2:', errorsAfterFirstUnlock + 1,
);

// 6d. unknown action must be a *visible* refusal, not a throw
const bogus = await connection.rpc.call('/api', 'qqRelay/act', { args: { args: { action: 'explode' } } });
assert.equal(bogus.ok, true, 'a business refusal must still be a Remote success envelope');
assert.equal(bogus.value.ok, false);
assert.ok(bogus.value.text.includes('explode'), bogus.value.text);
console.log('A6d unknown action refused with visible text');

// ---- 7. tool actions and Remote actions are ONE implementation ----------
const lockTool = await tools.get('relay_lock').execute({ sessionId: LOCK_SESSION }, {});
assert.ok(lockTool.content[0].text.includes('已锁定 → ' + LOCK_SESSION), lockTool.content[0].text);
assert.equal(JSON.parse(readFileSync(join(MEDIA, 'relay.json'), 'utf8')).sessionId, LOCK_SESSION);
const engineTool = await tools.get('relay_engine').execute({ mode: 'answer' });
assert.ok(engineTool.content[0].text.includes('引擎 QQ 模式 → answer'), engineTool.content[0].text);
const unlockTool = await tools.get('relay_unlock').execute({});
assert.ok(unlockTool.content[0].text.includes('已解锁'), unlockTool.content[0].text);
console.log('A7 tools still drive the same local implementations');

// The closing count has the same shape the real machine showed (`报错 3 条`):
// three unlocks in one run = three errors, while every lock click — with or
// without an id — contributes none. (unlock, unlock#2, and A7's relay_unlock.)
// 基线里可能还垫着前面“切到 direct 但缺凭据”的那一条，所以按增量断言。
assert.equal(await runErrors(), errorsBeforeUnlock + 3, 'three unlocks in one run must add exactly three run errors');
console.log('A7-bis run errors after three unlocks -> 3 (one per unlock, none per lock)');

// ---- 8. a business throw crosses the wire as a Remote failure -----------
class Boom { status() { throw new protocol.RemoteError('qq-relay/fixture', 'boom', { from: 'test' }) } }
Object.defineProperty(Boom.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  configurable: true,
  value: Object.freeze({ version: 1, methods: Object.freeze([{ method: 'status', invocation: Object.freeze({ kind: 'direct' }) }]) }),
});
const boom = new Boom();
boom.typertRemote = Object.freeze({ service: boom, serviceKey: 'qqRelayBoom', namespace: 'qqRelayBoom' });
root.provide('qqRelayBoom', boom);
const boomCall = await connection.rpc.call('/api', 'qqRelayBoom/status', { args: {} });
assert.equal(boomCall.ok, false, 'a business throw must not arrive as ok');
assert.equal(boomCall.error.code, 'qq-relay/fixture');
console.log('A8 business throw ->', boomCall.error.code, '-', boomCall.error.message);

// ---- 9. an unclaimed endpoint is refused by the gateway, not by us ------
const ghost = await connection.rpc.call('/api', 'qqRelay/nope', { args: {} });
assert.equal(ghost.ok, false);
assert.equal(ghost.error.code, 'gateway/invocation-unavailable');
console.log('A9 unknown endpoint ->', ghost.error.code);

// ---- disposed cleanly ---------------------------------------------------
for (const dispose of disposers) dispose();
gwFiber.dispose?.();
console.log('wire calls made:', calls.length);
console.log('host behaviour test: PASS');
