# dsh-qq-relay

让 QQ 消息进入指定的 DeepSeek Harness 会话窗口的插件。

支持从 QQ 发图片、文件、动图、表情包、视频、B 站链接到指定的 DSH 会话窗口。

## 安装

跟你的 DSH 说：
```
安装这个插件：https://github.com/HDHKVT/dsh-qq-relay
```

## 首次使用

1. 搜索引擎搜 QQ 开放平台 → 注册一个官方的 QQ 机器人 → 进后台获取 AppId / AppSecret。
2. 回到 DSH 设置页 → 「QQ 中继」→ 填 AppId / AppSecret → 保存；
3. 找一个会话，点锁定按钮：

   ![锁定会话说明](./assets/smtp.png)

4. 在 QQ 里给机器人发个消息。

## 功能

### 发文字

当 QQ 消息进入 DSH 会话时，QQ 会获得一个回执。

这么做是因为 DSH 收到消息后需要时间处理发来的消息（比如图片、视频、文件）、思考、生成回复，并不会第一时间回 QQ 消息。

如果自己发消息过去，没有回执表明 DSH 收到消息了，就会显得有点尴尬。

设置页面 - 回执：

是否发送回执 - 可以开关。

收到哪类消息才发送回执 - 可以选全部 或 只在发送图片、文件后收到回执。

可以自定义回执文案。

### 发图片

#### 动态图
DSH 默认看动态图只看一帧。为了让它能看懂动态图，就需要让它多看几帧。

说白了就是每过很短的一点时间，给动态图截个静态的图出来，然后几张静态图拼到一起发给 DSH，方便它理解。

那么截几张图呢？设置页面可以调。（设置 - QQ 中继 - 图片 - 动图帧数）

---

#### 多张图片
在 QQ 一次选中了好几张图片，发送的时候有细微的时间差。

时间差反应在 DSH 会话窗口里，就是一张图进来了，DSH 开始看图、思考、准备回复，紧接着另一张图才进来。

这就造成图片消息排队了。对我们发 QQ 消息的人来说，这是不能接受的。我们需要的是 DSH 一次性处理这好几张一起发的图。

从而需要一个时间窗口，等这些图片全都集合到同一条 DSH 会话消息中，才能达成一次消息、多张图片的效果。

设置 - QQ 中继 - 图片 - 连发合并，这里可以设置这个时间窗口有多长。

---

#### 图片库
图片发过来之后，有两个地方收纳这些图片。incoming - 临时图片库；stickers - 表情包库。

临时图片库会定时清理图片。在设置页可以设定自动删除过了多久的图片。也可以在这里一键清空临时图片库。

表情包库不会自动删除图片。

---

#### 表情包
在 QQ 上，给机器人发一张图，然后说一句暗号，DSH 就会把这张图存进表情包库，留待以后 DSH 自己发表情包。

暗号可以自定义，在设置页。

有三种方式让 DSH 收录表情包：

1.引用一张图（或动图）说暗号，就收被引用的那张

2.图跟暗号在同一条消息里发（不引用），收这条带的图。（让图跟暗号在同一条消息，这个操作一般在电脑端）

3.先发图，下一条消息只说暗号也能收。（120 秒内）

收了表情包，DSH 就可以主动发送表情包。频率可调，在设置页。

---

#### 文件
类似图片，QQ 发文件过去，DSH 会放到专门的地方。

发文件，无论是 QQ → DSH，要 DSH 处理文件；还是 DSH → QQ，让 DSH 干活的产物发到 QQ 来，都可以。

最多能发送多大的文件，可以设置。

| 能力 | 说明 | 额外依赖 |
|---|---|---|
| 表情 | `<faceType=…>` →「（表情：名字）」，名字表可导入 | 无 |
| 表情包仓库 | 引用图/直发图 + 暗号触发收录；模型负责起名；可主动发 | 无 |
| 回执 | 收到图片/文件先回一句，1.2 秒节流 | 无 |
| 视频理解 | 本地转字幕 + 抽帧拼图，模型逐张看图给**带时间线**的总结 | **Python 3.12 + venv + 模型** |
| B 站下载 | BV / av / b23 短链 / 分享文案；720P 单文件 mp4；可只下音频 | 无（纯 Node） |

## 架构

```
QQ 开放平台  ⇄  dsh-qq-relay（Node 宿主插件）
                    ├─ lib/qq-direct.js   token / 网关 / 心跳 / 重连
                    ├─ lib/delivery.js    主人门禁 → 去重 → 投进会话
                    ├─ lib/qq-reply.js    按 turn 关联回答，切好再发回
                    ├─ lib/vision.js · gif.js · files.js · stickers.js
                    ├─ lib/bilibili.js    wbi 签名 / 解析 / 下载
                    └─ video/video_processor.py   ASR + 抽帧 + 拼图（可选）
```

浏览器侧 `lib/client.js` 提供「皮肤管理 → QQ 中继」设置页。

## 依赖与下载清单（给安装代理）

### A. 必装（不做，插件跑不起来）

1. **DSH 0.2.x**（宿主）。检查：`dsh --version`。
2. **Node.js ≥ 20**。检查：`node --version`。
3. **一个 QQ 机器人**：appId、appSecret、主人 openid（QQ 开放平台后台拿）。
4. **挂载插件**：把本仓库放到 `D:\dsh-plugins\dsh-qq-relay`（或任意目录），
   在 profile（如 `~/.dsh/profiles/web/cordis.patch.yml`）加一条 `link:` 指向它，重启 `dsh web`。

> 本插件**没有 npm 依赖**，不需要 `npm install`。

### B. 可选：视频理解（不做，视频/B 站下载之外的"看视频"不可用）

5. **Python 3.12**（**不要 3.13/3.14**，ctranslate2 / opencv 轮子未必有）。检查：`py -3.12 --version`。
6. 建 venv 并装依赖（约 **500MB**）：
   ```powershell
   py -3.12 -m venv video\.venv
   video\.venv\Scripts\python -m pip install -r video\requirements.txt
   ```
   验证：
   ```powershell
   video\.venv\Scripts\python -c "import faster_whisper, cv2, av, numpy, PIL; print('ok')"
   ```
   > `av` 与 `huggingface_hub` 已在 requirements 里钉版本，**不要手动升级**。
7. **Whisper 模型**：
   - 默认 `base`（约 **145MB**）：**首次跑视频时自动下载**，缓存在 `<数据目录>\hf-cache`；
   - 想更准可换 `large-v3-turbo`（约 **1.6GB**）：手动下载到任意目录，在设置页「视频 → 模型目录」指过去。
     文件：`config.json`、`model.bin`、`tokenizer.json`、`vocabulary.json`、`preprocessor_config.json`。
   - 国内网络已默认走 `HF_ENDPOINT=https://hf-mirror.com` 且关掉 xet（插件注入，不用手配）。

### C. 不需要下载

- **FFmpeg**：不需要（ASR 由 PyAV 解码，抽帧由 OpenCV，B 站下的是单文件 mp4）。

### D. 功能降级表（缺什么会怎样）

| 缺失 | 后果 |
|---|---|
| 没配 appId / appSecret / ownerId | 网关不连，设置页报错，QQ 无响应 |
| 没有 Python 3.12 / venv | `analyze_video` 报错「python 不存在」；文字、图片、文件、B 站下载**不受影响** |
| venv 里少依赖 | `analyze_video` 返回 Python 报错（stderr 原文会转给你） |
| 没有 base 模型 | 首次分析会先下载（慢，但不报错）；网络不通则报下载失败 |
| 没设 `sessionId` | 消息进不来（提示 `no-session`） |

### E. 验证清单（装完逐条打勾）

```powershell
node --version                                  # ≥ v20
dsh --version                                   # 0.2.x
node test/config.test.mjs                       # 纯 Node 测试，应通过
node test/bilibili.test.mjs                     # 同上
video\.venv\Scripts\python -c "import faster_whisper, cv2, av; print('ok')"
```

然后在 DSH 里问一句"QQ 中继状态如何"，能读到 `qqRelay/status` 即为挂载成功。

## 配置（`relay.json` 关键项）

| 键 | 默认 | 说明 |
|---|---|---|
| `transport` | `direct` | 直连；`mailbox` 是旧的引擎信箱腿（保留不删） |
| `sessionId` | — | 锁定哪条会话 |
| `direct.appId` / `.appSecret` / `.ownerId` | — | QQ 机器人凭据（接口对外只回 `hasSecret`） |
| `reply.maxChars` | 900 | 单条回复上限 |
| `image.maxMb` / `retentionDays` | 12 / 7 | 收图上限 / 保留天数（0 = 不落盘） |
| `file.maxMb` | 20 | 收文件上限 |
| `send.fileMaxMb` | 30 | 发文件上限 |
| `ack.enabled` / `.mode` / `.text` | 开 / `media` | 回执开关、范围、文案 |
| `sticker.trigger` | `存表情包` | 收录暗号 |
| `video.mode` / `.model` / `.modelDir` / `.maxGrid` | `accurate` / `auto` / 空 / 8 | 视频功能 |
| `video.biliCookie` | 空 | 可选 SESSDATA（不下发浏览器、不写日志） |
| `video.biliDir` / `retentionDays` | 空 / 7 | B 站下载目录（空= `<数据目录>/bili`）/ 保留天数（0=不清理） |
| `ui.showCard` | `true` | 会话右上角那张 QQ 中继卡片是否显示 |

完整默认值与校验见 `lib/config.js`。

## 视频模式

- `fast`：base + VAD，约 **12 倍实时**，适合新闻/口播；
- `accurate`：large-v3-turbo、不切音频，约 **2.4 倍实时**，适合长纪录片；
- 抽帧：每 2 秒采样，HSV 直方图判换场景，长视频按时间轴均匀取帧；
- 字幕分页（`from`/`limit`），结果按视频路径缓存，翻页不重跑。

## 隐私与安全

- 所有数据只在本机：图片、文件、视频、字幕、日志都在插件数据目录；
- 日志**只打 CDN 主机名**，不打印带签名的下载地址；
- `biliCookie` 只存本地 `relay.json`，接口只回「有没有配」，值不下发浏览器；
- 仓库里没有任何凭据；`relay.json`、媒体目录、虚拟环境都在 `.gitignore` 里。

## 测试

19 个测试文件，纯 Node，无外部依赖：

```bash
node test/config.test.mjs
node test/bilibili.test.mjs
# 全部（Windows cmd）
for %f in (test\*.test.mjs) do node %f
```

视频相关测试另需 Python（用 `QQ_RELAY_PYTHON` 可指定解释器）。

## 已知限制

- **只支持私聊**；群聊（`GROUP_AT_MESSAGE_CREATE`）还没做；
- 视频 ASR 在纯音乐上会“脑补字幕”，已做三层过滤，宁可返回 0 条也不编；
- B 站 1080P 需要登录且可能切 DASH（音视频分离），目前只做 720P 单文件与纯音频；
- 没有 GPU 加速，ASR 走 CPU int8；
- 旧的「引擎信箱」链路保留但冻结，仅为兼容旧配置。

## 给装这个插件的 AI / 修改指南

> 这一节是给"要装这个插件、或者要改它"的 AI 看的。装的部分看前面「依赖与下载清单」，改的部分看这里。

### 1. 代码地图：要改什么去哪里

| 你想改 | 改哪里 |
|---|---|
| QQ 连接、token、网关、心跳 | `lib/qq-direct.js` |
| 谁能使唤它、消息怎么写进会话 | `lib/delivery.js`（主人门禁、去重、B 站链接提示） |
| 回答怎么切分、怎么发回 QQ | `lib/qq-reply.js` |
| 图片/GIF/图库 | `lib/vision.js`、`lib/gif.js` |
| 文件收发 | `lib/files.js` |
| 表情包仓库 | `lib/stickers.js` |
| 视频理解（调用 Python） | `lib/video.js` + `video/video_processor.py` |
| B 站解析与下载 | `lib/bilibili.js` |
| 配置默认值与校验 | `lib/config.js`（**改配置先改这里**） |
| 设置页 UI | `lib/client.js`（品牌插件，无 JSX，用 `React.createElement`） |
| 工具注册、RPC、信箱、启动流程 | `index.js` |

### 2. 加一个"工具"（让模型能调的新能力）

1. 在 `index.js` 的 `registerTools` 里 `defs.push({ name, description, parameters, output: TOOL_OUTPUT, execute })`；
2. `parameters` 用 JSON Schema，`additionalProperties: false`；
3. `execute` 返回 `{ content: [{ type: 'text', text }] }`；失败也要返回文字原因，**不要抛裸错**；
4. 在 `test/host-behaviour.test.mjs` 的期望工具名数组里加上它，否则测试挂；
5. 要让它出现在"设置页"或"卡片"里，再去 `lib/client.js` 加 UI，并在 `REMOTE_METHOD_NAMES` 注册对应 RPC。

### 3. 加一个"设置项"

1. `lib/config.js`：加进 `DEFAULTS`、`TOP_KEYS`（或子对象的 `*_KEYS`）、`readConfig` 的合并、`writeConfig` 的校验；
2. `publicConfig` 里决定要不要暴露给浏览器（**密钥类只回布尔**，例如 `hasSecret`）；
3. `lib/client.js`：draft 里加字段、`adopt` 里读、保存时按"和快照不同才写"生成 patch、UI 里加控件；
4. 文档：本 README 的配置表 + `技能\技能-专题-dsh-qq-relay.md`。

### 4. 信箱：留着的一个"对外接口"

插件里有两条腿：`transport: "direct"`（现在默认，插件自己连 QQ）和 `transport: "mailbox"`（旧的引擎信箱腿，**保留但冻结**）。

信箱本身可以当成**进程无关的接入协议**——任何程序（微信/飞书/钉钉的适配器、脚本、别的 AI）只要能读写文件，就能和 DSH 对话：

```
<mailbox>/
├─ inbox/    投递方写：一封一个 json
├─ outbox/   插件写回执（一封一个 json）
├─ done/     已处理的信（插件归档）
└─ failed/   处理失败的信（插件归档，附带原因）
```

**投递格式**（写进 `inbox/`，文件名建议 `<yyyymmdd>-<hhmmss>-<随机6位>.json`）：

```json
{
  "protocol": 1,
  "id": "20261021-120000-abc123",
  "at": 1761000000000,
  "text": "要问的话"
}
```

**回执格式**（插件写进 `outbox/`，适配器取走再转成自己平台的消息）：

```json
{
  "protocol": 1,
  "id": "receipt-20261021-120000-abc123",
  "at": 1761000005000,
  "kind": "text",
  "text": "答完的内容",
  "replyTo": "20261021-120000-abc123"
}
```

**接之前必须知道的三个限制**（别踩）：

1. **信箱腿只在 `transport: "mailbox"` 时运行**；现在是 `direct`，所以外部队列**不会**被消费。要接外部入口，得先把 `transport` 改回 `mailbox`，或按"入口模型"改造（见 `记忆\记忆-专题-dsh-qq-relay.md` 的待办）；
2. 回执只是文件，**不负责发到平台**——把微信消息发出去是适配器的事；
3. 协议目前没有鉴权、没有幂等键（只靠 `id` 去重）——跨机器用之前要先补这两样。

### 5. 视频管线（Python 侧）

- 只有一个入口：`video_processor.py --input <媒体> --output <json> --mode fast|accurate --model auto --model-dir <目录> --max-grid <n>`；
- 结果 JSON 的字段是**契约**：`status / duration_seconds / subtitles[{time,text}] / images[] / media / mode / model`；
- 改 Python 时别破坏这个结构，否则 `lib/video.js` 的 `validateResult` 会拒收；
- 依赖版本是钉死的（`av==13.1.0`、`huggingface_hub<1`），别随手升级，原因见 `video/requirements.txt` 的注释。

### 6. 改完怎么验

```bash
node test/<对应文件>.test.mjs        # 单点
for %f in (test\*.test.mjs) do node %f   # 全量（cmd）
```

- 纯逻辑改动：加/改单测，保持全绿；
- 界面改动：`test/client-contract.test.mjs` 会渲染组件，改 UI 后要跑；
- 宿主行为改动：`test/host-behaviour.test.mjs` 用一个假的 DSH 装载插件，验证工具名、RPC、信箱、回执；
- 真机改动（QQ/视频）：必须实际发一条，别只看单测。

### 7. 约定与坑

- QQ 回复**纯文本、900 字以内、不带 Markdown**；
- 调 `session/prompt` **必须**带 `AbortSignal`（漏了会静默不回）；
- Windows 路径带中文时，OpenCV/ffmpeg 常打不开——`lib/video.js` 有硬链接兜底；
- 日志里**不要打印带签名的下载 URL**，只打主机名；
- 配置写盘是"原子写 + 留 `.bak`"，别绕过 `writeConfig` 直接改 `relay.json`。

> **给"帮用户装插件"的 AI**：本插件**不需要 npm 依赖**，但**视频功能需要额外下载 Python 和模型**。
> 请直接看下面 §「依赖与下载清单」，按顺序执行并逐条验证；缺了会让对应功能不可用（见降级表）。

## 外观

插件图标：assets/icon.png（320×320，Q 版头像）。
鲸鱼娘形象基于上善无形（B站）、Zipzippipe（B站）原创角色二创，依 CC BY-NC-SA 4.0 非商业使用，二创同协议授权。

## 许可

- **代码**：[MIT](LICENSE) © 2026 Daisy
- **角色图片**（`assets/` 下所有 png/gif）：**CC BY-NC-SA 4.0**，原角色「上善无形」，**不可商用**。
  本仓库里的图标是对原立绘的裁剪/缩放等二次创作，同样按 CC BY-NC-SA 4.0 共享。
  详见 [`assets/LICENSE.md`](assets/LICENSE.md)。
