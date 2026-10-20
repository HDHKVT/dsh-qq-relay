/**
 * `dsh-qq-relay` v8 的**图片腿**自检（第 6 期 v2）：QQ 上的图要当**像素**进会话。
 *
 * 它只做一件事，但做到底：喂一封**带 `images[]` 的信**（真字节的 png + 一个"信封说 webp、
 * 文件名却是 .png"的陷阱）⇒ 断言 `sessionController.prompt` 收到的 `content` 里
 *   · 第一个块是 text（正文 + 那句"图已经附给你了"的 hint）
 *   · 每个图一个 `{type:'image'}` 块，`data` 是**那份文件的 base64**、`mediaType` **用信封给的**
 *     （文件名带 .png 也必须报 webp —— 证明插件**不按扩展名猜**）
 * 再喂一封**单图超上限**的信 ⇒ 断言它进 `failed/`（带原因）**且没有被投**，
 * 而且 outbox 里留下了一句给主人的说明（**不静默**）。
 *
 * 🔴 隔离：整条链只碰 `test/fixture-images/`（`DSH_QQ_RELAY_BASE` / `APP_DIR` / `DECL_DIR`），
 * 一个字节都不碰真的 `D:\dsh-plugins\_media\dsh-qq-relay` 与 `%LOCALAPPDATA%\DaisyQQCottage`。
 */
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = dirname(HERE);
const FIXTURE = join(HERE, 'fixture-images');
const MEDIA = join(FIXTURE, 'media');
const APP_DIR = join(FIXTURE, 'app');
const MAILBOX = join(FIXTURE, 'mailbox');
const INBOX = join(MAILBOX, 'inbox');
const OUTBOX = join(MAILBOX, 'outbox');
const DONE = join(MAILBOX, 'done');
const FAILED = join(MAILBOX, 'failed');
const MAILBOX_MEDIA = join(MAILBOX, 'media');
const LOCK_SESSION = 'session-fixture-images';

const DSH_INSTALL =
  process.env.DSH_INSTALL ?? 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh';
const require = createRequire(`${DSH_INSTALL}/package.json`);

// ---------------------------------------------------------------- fixture
rmSync(FIXTURE, { recursive: true, force: true });
for (const dir of [MEDIA, join(APP_DIR, 'data'), INBOX, OUTBOX, DONE, FAILED, MAILBOX_MEDIA]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(
  join(MEDIA, 'relay.json'),
  JSON.stringify({ sessionId: LOCK_SESSION, mailbox: MAILBOX, hint: true }, null, 2),
  'utf8',
);
writeFileSync(join(APP_DIR, 'data', 'settings.json'), JSON.stringify({ qqMode: 'relay' }, null, 2), 'utf8');

/** 真字节（内容本身不重要 —— 要验的是"原样 base64 过去"） */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xde, 0xad, 0xbe, 0xef,
]);
const WEBP_BYTES = Buffer.from('RIFF\x24\x00\x00\x00WEBP-VP8-fixture-bytes', 'latin1');

const LETTER_ID = '20261016-235959-imgift';
const PNG_PATH = join(MAILBOX_MEDIA, `${LETTER_ID}.png`);
/** ⚠️ 故意让**文件名**.png 而信封说 image/webp ⇒ 插件要是按扩展名猜，这条就红 */
const WEBP_PATH = join(MAILBOX_MEDIA, `${LETTER_ID}-second.png`);
writeFileSync(PNG_PATH, PNG_BYTES);
writeFileSync(WEBP_PATH, WEBP_BYTES);

// 第一封：**带两张图**（正文照引擎 v2 的形状：一句占位话 + images[]）
writeFileSync(
  join(INBOX, `${LETTER_ID}.json`),
  JSON.stringify(
    {
      protocol: 1,
      id: LETTER_ID,
      at: Date.now(),
      from: { scope: 'private:fixture', who: '主人', msgId: 'm-img-1' },
      kind: 'text',
      text: '（主人发来一张图，见下面的图片）',
      ack: false, // ⇒ 不该写"（已交给会话）"回执（这一跑 outbox 里只该有那条失败说明）
      images: [
        { path: PNG_PATH, mediaType: 'image/png' },
        { path: WEBP_PATH, mediaType: 'image/webp' },
      ],
    },
    null,
    2,
  ),
  'utf8',
);

// 第二封：**单图超上限**（10MB + 1 字节）⇒ 整封进 failed/ + 给主人留一句说明
const BIG_LETTER_ID = '20261016-235958-bigimg';
const BIG_PATH = join(MAILBOX_MEDIA, 'huge.png');
writeFileSync(BIG_PATH, Buffer.alloc(10 * 1024 * 1024 + 1, 0x41));
writeFileSync(
  join(INBOX, `${BIG_LETTER_ID}.json`),
  JSON.stringify(
    {
      protocol: 1,
      id: BIG_LETTER_ID,
      at: Date.now(),
      from: { scope: 'private:fixture', who: '主人', msgId: 'm-img-2' },
      kind: 'text',
      text: '这张图有点大',
      ack: false,
      images: [{ path: BIG_PATH, mediaType: 'image/png' }],
    },
    null,
    2,
  ),
  'utf8',
);

// 🔴 所有由环境变量派生的路径都必须在 import 之前指好（模块顶层就把 BASE/CONFIG 冻住了）
process.env.DSH_QQ_RELAY_BASE = MEDIA;
process.env.DSH_QQ_RELAY_APP_DIR = APP_DIR;
process.env.DSH_QQ_RELAY_DECL_DIR = FIXTURE;

const plugin = await import(pathToFileURL(join(PKG_DIR, 'index.js')).href);
assert.equal(typeof plugin.apply, 'function');

// ---------------------------------------------------------------- 假宿主
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const root = new Context();
const prompts = [];
const disposers = [];

root.provide('tools', { register: () => () => {} });
root.provide('sessionController', {
  async list() {
    return { items: [{ sessionId: LOCK_SESSION, cwd: MAILBOX, agentAvailable: false, running: false, blank: false }] };
  },
  async prompt(request) {
    prompts.push(request);
    return { accepted: true };
  },
});

const fakeCtx = {
  get: (key) => root.get(key),
  provide: (key, value) => { root.provide(key, value); return value },
  inject: (_deps, cb) => { cb(fakeCtx); return () => {} },
  on: (event, cb) => { if (event === 'dispose') disposers.push(cb); return () => {} },
};

plugin.apply(fakeCtx, {});
await new Promise((r) => setTimeout(r, 250));

// ---------------------------------------------------------------- 断言
// 1. 只有第一封被投（第二封超限 ⇒ 不投）
assert.equal(prompts.length, 1, `只该投一封（带图的），实际 ${prompts.length} 封`);
const request = prompts[0];
assert.equal(request.sessionId, LOCK_SESSION);
assert.equal(request.mode, 'queue');
assert.equal(request.requestId, `qq-${LETTER_ID}`, 'requestId 要带引擎的信封 id');

// 2. content 的形状：text 块 + 每张图一个 image 块
assert.equal(request.content.length, 3, `该是 1 个文字块 + 2 个图块，实际 ${request.content.length}`);
const [textBlock, pngBlock, webpBlock] = request.content;
assert.equal(textBlock.type, 'text');
assert.ok(
  textBlock.text.includes('（主人发来一张图，见下面的图片）'),
  `正文该逐字带过来：${textBlock.text}`,
);
assert.ok(
  textBlock.text.includes('图已经作为图片附件给你了'),
  `hint 该提一句"图已附上"：${textBlock.text}`,
);

// 3. 图块：base64 与文件**逐字节一致**，mediaType 用信封给的（**不按扩展名猜**）
assert.equal(pngBlock.type, 'image');
assert.equal(pngBlock.mediaType, 'image/png');
assert.equal(pngBlock.data, PNG_BYTES.toString('base64'), 'base64 该是那份文件的原样编码');
assert.equal(Buffer.from(pngBlock.data, 'base64').compare(PNG_BYTES), 0, '解回来必须逐字节一致');
assert.ok(!('name' in pngBlock), '信封没给 name ⇒ 不许自己编一个');

assert.equal(webpBlock.type, 'image');
assert.equal(
  webpBlock.mediaType,
  'image/webp',
  '⚠️ 文件名是 .png 而信封说 webp ⇒ 必须**用信封的**（按扩展名猜就会在这里红）',
);
assert.equal(webpBlock.data, WEBP_BYTES.toString('base64'));
assert.equal(Buffer.from(webpBlock.data, 'base64').compare(WEBP_BYTES), 0);

// 4. 归档：成功那封进 done/，超限那封进 failed/ 并**带原因**
const doneNames = readdirSync(DONE);
assert.ok(
  doneNames.some((n) => n.startsWith(LETTER_ID) && n.endsWith('.json')),
  `成功那封该进 done/：${JSON.stringify(doneNames)}`,
);
const failedNames = readdirSync(FAILED);
const bigResult = failedNames.find((n) => n.startsWith(BIG_LETTER_ID) && n.endsWith('.result.json'));
assert.ok(bigResult, `超限那封该进 failed/ 并附说明：${JSON.stringify(failedNames)}`);
const bigNote = JSON.parse(readFileSync(join(FAILED, bigResult), 'utf8'));
assert.equal(bigNote.ok, false);
assert.equal(bigNote.stage, 'images');
assert.ok(bigNote.error.includes('超过'), `原因要写清楚：${bigNote.error}`);
assert.equal(bigNote.images.length, 1);

// 5. **不静默**：outbox 里留了一句"有一张图没能交给会话"（引擎会把它发到 QQ）
const outboxFiles = readdirSync(OUTBOX).filter((n) => n.endsWith('.json'));
const notices = outboxFiles.map((n) => JSON.parse(readFileSync(join(OUTBOX, n), 'utf8')));
assert.ok(
  notices.some((item) => String(item.text).includes('有一张图没能交给会话')),
  `超限要留一句给主人：${JSON.stringify(notices)}`,
);
// 6. `ack:false` ⇒ 不该有回执（那一句"（已交给会话）"）
assert.ok(
  !notices.some((item) => item.text === '（已交给会话）'),
  `ack:false 时不该写回执：${JSON.stringify(notices)}`,
);

console.log('B1 content ->', JSON.stringify({
  blocks: request.content.map((b) => (b.type === 'text' ? { type: 'text', chars: b.text.length } : { type: b.type, mediaType: b.mediaType, bytes: Math.round(b.data.length * 3 / 4) })),
  hintMentionsImages: textBlock.text.includes('图已经作为图片附件给你了'),
}));
console.log('B2 archived -> done:', JSON.stringify(doneNames), '| failed:', JSON.stringify(failedNames));
console.log('B3 outbox notices ->', JSON.stringify(notices.map((n) => n.text)));

// ---------------------------------------------------------------- 收尾
for (const dispose of disposers) dispose();
rmSync(FIXTURE, { recursive: true, force: true }); // 夹具里有 ~10MB 的超限图，别留着
console.log('host images test: PASS');
