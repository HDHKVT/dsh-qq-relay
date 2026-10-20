/**
 * Browser half of `dsh-qq-relay` — v6: a real control card, not a probe.
 *
 * Format: the lazy-CJS registration table the DSH shell's vendored Cordis
 * Loader consumes. Executing this file only REGISTERS a factory; the module
 * body runs at materialization. The artifact is hand-written in exactly the
 * shape tsdown emits for a client package, so no bundler and no build step
 * are involved.
 *
 *   window.__ModuleLoader__.load({ id: <package name>, factory: (require) => { ... } })
 *
 * `react` is a platform seed word and is therefore requested through the
 * injected `require`; nothing else is imported, so `dsh.client.external`
 * stays empty.
 *
 * ## How this half talks to the Host half
 *
 * `ctx.connection.rpc.call("/api", "<namespace>/<method>", { args })` — the
 * generic Connection unary channel. The Host's `typertGateway` claims the
 * endpoint (`claimsEndpoint`) and dispatches it in SRC mode to the Cordis
 * service the Host half registered as `ctx.qqRelayRemote`. The wire payload
 * is ALWAYS exactly one `{ args: <plain object> }` field, and that object's
 * keys must equal the Host method's parameter names — `{ args: {} }` for
 * `qqRelay/status`, `{ args: { args: { action, … } } }` for `qqRelay/act`.
 * Every call resolves to `{ ok: true, value }` or `{ ok: false, error }`;
 * it never rejects for a transport problem, so this half only has to read
 * the branch — and it must SHOW the failure, never swallow it.
 *
 * @module dsh-qq-relay/client
 */
window.__ModuleLoader__.load({
	id: "dsh-qq-relay",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useCallback, useEffect, useRef, useState } = React;
		/**
		 * Timer seats. They are resolved from the module scope (not `globalThis`)
		 * so a test can drive the component inside a `node:vm` context that has no
		 * timers of its own; in a browser these are simply the page's functions.
		 */
		const setInterval = globalThis.setInterval || (() => 0);
		const clearInterval = globalThis.clearInterval || (() => {});

		/**
		 * This entry's browser-side plugin context, captured by `apply()`.
		 *
		 * Slot components receive framework props (owner/session/hooks/locale) —
		 * the Cordis context is NOT among them, so the registrant hands it to its
		 * own components through this closure instead.
		 */
		let pluginCtx = null;

		/** Remote namespace/method names — must match `index.js`. */
		const NS_STATUS = "qqRelay/status";
		const NS_ACT = "qqRelay/act";
		/** 🆕 设置页的两个端点（与 index.js 的 REMOTE_METHOD_NAMES 对齐）。 */
		const NS_CONFIG = "qqRelay/config";
		const NS_CONFIG_UPDATE = "qqRelay/configUpdate";
		const NS_IMAGE_CLEAR = "qqRelay/imageClear";
		const NS_IMAGE_DIR = "qqRelay/openImageDir";
		const NS_LOG_TAIL = "qqRelay/logTail";
		const NS_LOG_CLEAR = "qqRelay/logClear";
		const NS_FACES = "qqRelay/faces";
		const NS_FACES_IMPORT = "qqRelay/facesImport";
		const NS_FACES_RESET = "qqRelay/facesReset";
		const NS_FILE_CLEAR = "qqRelay/fileClear";
		const NS_FILE_DIR = "qqRelay/openFileDir";
		const NS_VIDEO_CLEAR = "qqRelay/videoClear";
		const NS_VIDEO_DIR = "qqRelay/openVideoDir";
		const NS_BILI_CLEAR = "qqRelay/biliClear";
		const NS_BILI_DIR = "qqRelay/openBiliDir";
		/** Status poll while the card is open (the Host caches for 30s). */
		const POLL_MS = 10000;
		/** Longest session id shown before truncation. */
		const ID_MAX = 24;

		// ---------------------------------------------------------------- copy
		// Chinese literals on purpose: this plugin ships no locale dictionary yet
		// (the shipped packages pass `locale:` and render through `t`; that is a
		// worthwhile follow-up, not a requirement of this round).
		const TEXT = {
			title: "QQ 中继",
			open: "展开",
			close: "收起",
			refresh: "刷新",
			loading: "读取中…",
			locked: "锁定会话",
			unlocked: "未锁定",
			engine: "引擎模式",
			mailbox: "信箱",
			decl: "声明",
			counts: "条数",
			busy: "…",
			lock: "锁定当前会话",
			unlock: "解锁",
			relay: "切到 relay",
			answer: "切到 answer",
			lockHint: "把 QQ 消息投进这条会话",
			unlockHint: "停止投递（不动引擎模式）",
			// 这张卡片挂在 `shell.overlay` —— 一个 **root 级**座位，座位不会给它
			// `sessionId`。当前会话必须自己从标准 props 的 `useSessions` 里取
			// （见 selectCurrentSessionId）；取不到时**说清楚**，不假装成功。
			noSession: "拿不到「当前会话」id ⇒ 锁定请用会话标题旁的「锁定这条会话」；解锁仍可用",
		};

		// ------------------------------------------------------------- helpers
		/** Truncate a long session id for display. */
		function shortId(value) {
			const text = String(value ?? "");
			if (text.length <= ID_MAX) return text;
			return `${text.slice(0, ID_MAX)}…`;
		}

		// ------------------------------------------------- current session id
		/**
		 * Which session the frame currently has selected — read from the
		 * `useSessions` standard prop, NOT from a prop the root seat never sends.
		 *
		 * Why this rule and not something else: the selection lives in the
		 * runtime sessions service, and the ONLY marker a root-scoped occupant
		 * can see is the retention source. `ui-workspace` retains the main-view
		 * session with `{ source: "mainView" }`, and `ui-session`'s own
		 * `publishMain()` picks the main binding by exactly
		 * `(row.retainedBy.mainView ?? 0) > 0` — so this predicate IS the
		 * platform's definition of "current session", not a guess of ours.
		 *
		 * `SessionListState` = `{ ids, byId, phase, projectionsBySession }`
		 * (see `@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.d.ts`).
		 * @param sessions - the `SessionListState` snapshot.
		 * @returns the selected session id, or undefined when nothing is selected.
		 */
		function selectCurrentSessionId(sessions) {
			if (!sessions || !sessions.byId) return undefined;
			const ids = Array.isArray(sessions.ids) && sessions.ids.length
				? sessions.ids
				: Object.keys(sessions.byId);
			for (const id of ids) {
				const row = sessions.byId[id];
				if (row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0) return id;
			}
			return undefined;
		}

		/**
		 * Stand-in for a seat that hands down no `useSessions`. It keeps the Hook
		 * call unconditional (so a seat that DOES provide the hook does not
		 * change this component's Hook order) and reads as "nothing selected".
		 * @param selector - the same selector the real hook would run.
		 * @returns the selector applied to absence.
		 */
		function useNoSessions(selector) {
			return selector(undefined);
		}

		/**
		 * Resolve the Connection RPC face at CALL time (not at registration):
		 * the `connection` service is injected by `dsh-client-connection`, whose
		 * activation order relative to this plugin is not something to rely on.
		 * @param ctx - this entry's browser-side plugin context.
		 * @returns the rpc face, or undefined while the service is absent.
		 */
		function rpcOf(ctx) {
			let conn;
			try {
				conn = typeof ctx.get === "function" ? ctx.get("connection") : undefined;
			} catch (error) {
				return { error: `ctx.get("connection") 抛错：${messageOf(error)}` };
			}
			if (!conn || !conn.rpc || typeof conn.rpc.call !== "function") {
				return { error: "拿不到 connection 服务（rpc.call 不可用）⇒ 客户端半腿与宿主的通道没起来" };
			}
			return { rpc: conn.rpc };
		}

		/** Normalize any thrown value to a displayable message. */
		function messageOf(error) {
			if (error && typeof error.message === "string" && error.message) return error.message;
			return String(error);
		}

		/**
		 * One unary Remote call. NEVER rejects: a transport problem, an offline
		 * carrier and a business failure all come back as `{ok:false, text}` so
		 * the card has something to show.
		 * @param ctx - plugin context.
		 * @param endpoint - `<namespace>/<method>`.
		 * @param args - the Host method's named arguments object.
		 * @returns `{ok:true, value}` or `{ok:false, text}`.
		 */
		async function callRemote(ctx, endpoint, args) {
			const resolved = rpcOf(ctx);
			if (resolved.error) return { ok: false, text: resolved.error };
			let result;
			try {
				result = await resolved.rpc.call("/api", endpoint, { args: args || {} });
			} catch (error) {
				// A carrier throw folds into a failure here rather than escaping.
				return { ok: false, text: `${endpoint} 调用抛错：${messageOf(error)}` };
			}
			if (!result || typeof result !== "object") {
				return { ok: false, text: `${endpoint} 返回了非对象结果：${JSON.stringify(result)}` };
			}
			if (result.ok === true) return { ok: true, value: result.value };
			const error = result.error || {};
			const code = error.code || "（无 code）";
			const details = error.details === undefined ? "" : ` ${JSON.stringify(error.details)}`;
			return { ok: false, text: `${endpoint} → ${code}：${error.message || "（无 message）"}${details}` };
		}

		// ------------------------------------------------------------- copying
		const C = {
			label: "var(--dsw-alias-label-primary)",
			label2: "var(--dsw-alias-label-secondary)",
			caption: "var(--dsw-alias-label-caption)",
			bg: "var(--dsw-alias-bg-layer-1)",
			border: "var(--dsw-alias-border-l3)",
			border2: "var(--dsw-alias-border-l2)",
			hover: "var(--dsw-alias-interactive-bg-hover)",
			error: "var(--dsw-alias-state-error-primary)",
			ok: "var(--dsw-alias-state-business-primary)",
			mono: "var(--dsw-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
		};

		/** Small pill button; `tone` picks the label colour. */
		function Btn(props) {
			const [hover, setHover] = useState(false);
			const disabled = Boolean(props.disabled);
			return React.createElement(
				"button",
				{
					type: "button",
					disabled,
					title: props.title,
					onClick: props.onClick,
					onMouseEnter: () => setHover(true),
					onMouseLeave: () => setHover(false),
					style: {
						appearance: "none",
						cursor: disabled ? "default" : "pointer",
						opacity: disabled ? 0.55 : 1,
						padding: "2px 8px",
						borderRadius: "6px",
						border: `1px solid ${hover && !disabled ? C.border : C.border2}`,
						background: hover && !disabled ? C.hover : "transparent",
						color: props.tone || C.label,
						font: "inherit",
						fontSize: "11px",
						lineHeight: "18px",
						whiteSpace: "nowrap",
					},
				},
				props.children,
			);
		}

		/**
		 * One `标签 值` row.
		 *
		 * The value WRAPS instead of being ellipsised: on the real machine the
		 * counts line (`inbox … · failed 1 · sent …`) was cut mid-word by the old
		 * `nowrap + hidden + ellipsis` inside a fixed 300px card. `title` still
		 * carries the untruncated text for hover.
		 */
		function Row(props) {
			return React.createElement(
				"div",
				{ style: { display: "flex", gap: "6px", alignItems: "baseline", flexWrap: "wrap" } },
				React.createElement("span", { style: { color: C.caption, flex: "0 0 auto" } }, props.label),
				React.createElement(
					"span",
					{
						style: {
							color: C.label,
							flex: "1 1 auto",
							minWidth: "0",
							overflowWrap: "anywhere",
							wordBreak: "break-word",
							whiteSpace: "pre-wrap",
							fontFamily: props.mono ? C.mono : "inherit",
						},
						title: props.title,
					},
					props.children,
				),
			);
		}

		// ------------------------------------------------------ settings page
		/**
		 * 「QQ 中继」设置页（`settings.section`，root 座位）。
		 *
		 * 为什么管的是**插件自己的配置**：直连 QQ 是插件自己连的，凭据就该跟着插件走；
		 * 小屋那套额度/人设仍归小屋。数据源是 `relay.json`，唯一写者是 Host 的
		 * `lib/config.js`（白名单 + 校验 + 原子写），这一页只是它的一个窗口。
		 */

		/** 受控输入框；`secret` 默认按密码显示，可点旁边看一眼。 */
		function TextInput(props) {
			return React.createElement("input", {
				type: props.secret && !props.reveal ? "password" : "text",
				value: props.value,
				placeholder: props.placeholder || "",
				spellCheck: false,
				autoComplete: "off",
				disabled: props.disabled,
				onChange: (event) => props.onChange(event.target.value),
				style: {
					boxSizing: "border-box",
					width: "100%",
					padding: "6px 10px",
					borderRadius: "8px",
					border: `1px solid ${C.border2}`,
					background: C.bg,
					color: C.label,
					font: "inherit",
					fontSize: "13px",
					lineHeight: "20px",
				},
			});
		}

		/** 「标题 + 控件 + 说明」的一行。 */
		function Field(props) {
			return React.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "4px" } },
				React.createElement("div", { style: { color: C.label, fontSize: "12px", lineHeight: "18px" } }, props.label),
				props.children,
				props.hint
					? React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px", lineHeight: "16px" } },
						props.hint,
					)
					: null,
			);
		}

		/** 示意图里的“气泡”：一个圆角框，里面放图块/文字条。 */
		function MiniBubble(props) {
			return React.createElement(
				"div",
				{ style: { border: `1px solid ${props.highlight ? C.border2 : C.border2}`, borderRadius: "10px", padding: "6px", background: C.bg, width: props.width || "104px", display: "flex", flexDirection: "column", gap: "4px" } },
				props.children,
			);
		}

		/** 示意图里的“图”：一块带斜纹的空框，不画真图，省得加载资源。 */
		function MiniImage(props) {
			return React.createElement("div", {
				style: {
					height: props.height || "34px",
					borderRadius: "6px",
					background: `repeating-linear-gradient(45deg, ${C.border2} 0 6px, transparent 6px 12px)`,
					border: `1px solid ${C.border2}`,
				},
			});
		}

		/** 示意图里的“文字”：一条灰条。 */
		function MiniLine(props) {
			return React.createElement("div", {
				style: { height: "5px", borderRadius: "3px", background: C.caption, opacity: 0.55, width: props.width || "80%" },
			});
		}

		/** 互斥选择里的一项。 */
		function Choice(props) {
			const active = Boolean(props.active);
			const [hover, setHover] = useState(false);
			return React.createElement(
				"button",
				{
					type: "button",
					disabled: props.disabled,
					onClick: props.onClick,
					onMouseEnter: () => setHover(true),
					onMouseLeave: () => setHover(false),
					style: {
						appearance: "none",
						cursor: props.disabled ? "default" : "pointer",
						padding: "4px 12px",
						borderRadius: "8px",
						border: `1px solid ${active ? C.ok : C.border2}`,
						background: active ? C.hover : hover ? C.hover : "transparent",
						color: active ? C.ok : C.label,
						font: "inherit",
						fontSize: "12px",
						lineHeight: "18px",
					},
				},
				props.children,
			);
		}

		/** 设置页正文：凭据三项 + 链路开关 + 锁定状态。 */
		function RelaySettings(props) {
			const hasSessionHook = Boolean(props && typeof props.useSessions === "function");
			const useSelector = hasSessionHook ? props.useSessions : useNoSessions;
			const currentSessionId = useSelector((state) => selectCurrentSessionId(state));

			const [snapshot, setSnapshot] = useState(null);
			const [draft, setDraft] = useState({
				appId: "", appSecret: "", ownerId: "", transport: "mailbox", reveal: false,
				imageEnabled: true, maxMb: "12", retentionDays: "7", gifFrames: "4", batchMs: "800",
				fileEnabled: true, fileMaxMb: "20", fileRetentionDays: "7",
				ackEnabled: true, ackMode: "media", ackText: "收到啦，正在看你的{what}，稍等一下～",
				captionMode: "merge",
				stickerTrigger: "存表情包",
				stickerByQuote: true, stickerByAttach: true, stickerByRecent: true,
				stickerFrequency: "normal",
				sendFileMaxMb: "30",
				videoEnabled: true, videoMaxMb: "2048", videoTimeoutSec: "1800",
				videoMode: "accurate", videoModel: "auto", videoModelDir: "", videoMaxGrid: "8",
				videoRetentionDays: "7", showCard: true,
			});
			const [busy, setBusy] = useState(false);
			const [note, setNote] = useState("");
			const [error, setError] = useState("");

			const adopt = useCallback((value) => {
				setSnapshot(value);
				const image = value.image || {};
				const file = value.file || {};
				const ack = value.ack || {};
				const sending = value.send || {};
				const sticker = value.sticker || {};
				const video = value.video || {};
				setDraft((prev) => ({
					...prev,
					appId: (value.direct && value.direct.appId) || "",
					ownerId: (value.direct && value.direct.ownerId) || "",
					transport: value.transport || "mailbox",
					appSecret: "",
					imageEnabled: image.enabled !== false,
					maxMb: String(image.maxMb ?? 12),
					retentionDays: String(image.retentionDays ?? 7),
					gifFrames: String(image.gifFrames ?? 4),
					batchMs: String(image.batchMs ?? 800),
					fileEnabled: file.enabled !== false,
					fileMaxMb: String(file.maxMb ?? 20),
					fileRetentionDays: String(file.retentionDays ?? 7),
					ackEnabled: ack.enabled !== false,
					ackMode: ack.mode === "all" ? "all" : "media",
					ackText: String(ack.text ?? "收到啦，正在看你的{what}，稍等一下～"),
					captionMode: sending.captionMode === "separate" ? "separate" : "merge",
					sendFileMaxMb: String(sending.fileMaxMb ?? 30),
					stickerTrigger: String(sticker.trigger ?? "存表情包"),
					stickerByQuote: sticker.byQuote !== false,
					stickerByAttach: sticker.byAttach !== false,
					stickerByRecent: sticker.byRecent !== false,
					stickerFrequency: ["off", "rare", "often"].includes(sticker.frequency) ? sticker.frequency : "normal",
					videoEnabled: video.enabled !== false,
					videoMaxMb: String(video.maxMb ?? 2048),
					videoTimeoutSec: String(video.timeoutSec ?? 1800),
					videoMode: video.mode === "fast" ? "fast" : "accurate",
					videoModel: ["auto", "base", "small", "medium", "large-v3-turbo"].includes(video.model) ? video.model : "auto",
					videoModelDir: String(video.modelDir ?? ""),
					videoRetentionDays: String(video.retentionDays ?? 7),
					videoMaxGrid: String(video.maxGrid ?? 8),
					showCard: (value.ui && value.ui.showCard) !== false,
				}));
			}, []);

			const load = useCallback(async () => {
				setBusy(true);
				setError("");
				const out = await callRemote(pluginCtx, NS_CONFIG, {});
				setBusy(false);
				if (!out.ok) {
					setError(out.text);
					return;
				}
				adopt(out.value);
				setNote("");
			}, [adopt]);

			useEffect(() => {
				load();
			}, [load]);

			const save = useCallback(async () => {
				if (!snapshot) return;
				const direct = {};
				if (draft.appId !== (snapshot.direct.appId || "")) direct.appId = draft.appId;
				if (draft.ownerId !== (snapshot.direct.ownerId || "")) direct.ownerId = draft.ownerId;
				if (draft.appSecret !== "") direct.appSecret = draft.appSecret;
				const patch = {};
				if (Object.keys(direct).length > 0) patch.direct = direct;
				if (draft.transport !== snapshot.transport) patch.transport = draft.transport;
				const img = {};
				const base = snapshot.image || {};
				if (draft.imageEnabled !== (base.enabled !== false)) img.enabled = draft.imageEnabled;
				if (Number(draft.maxMb) !== Number(base.maxMb ?? 12)) img.maxMb = Number(draft.maxMb);
				if (Number(draft.retentionDays) !== Number(base.retentionDays ?? 7)) img.retentionDays = Number(draft.retentionDays);
				if (Number(draft.gifFrames) !== Number(base.gifFrames ?? 4)) img.gifFrames = Number(draft.gifFrames);
				if (Number(draft.batchMs) !== Number(base.batchMs ?? 800)) img.batchMs = Number(draft.batchMs);
				if (Object.keys(img).length > 0) patch.image = img;
				const fl = {};
				const fbase = snapshot.file || {};
				if (draft.fileEnabled !== (fbase.enabled !== false)) fl.enabled = draft.fileEnabled;
				if (Number(draft.fileMaxMb) !== Number(fbase.maxMb ?? 20)) fl.maxMb = Number(draft.fileMaxMb);
				if (Number(draft.fileRetentionDays) !== Number(fbase.retentionDays ?? 7)) fl.retentionDays = Number(draft.fileRetentionDays);
				if (Object.keys(fl).length > 0) patch.file = fl;
				const vb = {};
				const vbase = snapshot.video || {};
				if (draft.videoEnabled !== (vbase.enabled !== false)) vb.enabled = draft.videoEnabled;
				if (Number(draft.videoMaxMb) !== Number(vbase.maxMb ?? 2048)) vb.maxMb = Number(draft.videoMaxMb);
				if (Number(draft.videoTimeoutSec) !== Number(vbase.timeoutSec ?? 1800)) vb.timeoutSec = Number(draft.videoTimeoutSec);
				if (draft.videoMode !== (vbase.mode === "fast" ? "fast" : "accurate")) vb.mode = draft.videoMode;
				if (draft.videoModel !== (["auto", "base", "small", "medium", "large-v3-turbo"].includes(vbase.model) ? vbase.model : "auto")) vb.model = draft.videoModel;
				if (draft.videoModelDir.trim() !== String(vbase.modelDir ?? "")) vb.modelDir = draft.videoModelDir.trim();
				if (Number(draft.videoMaxGrid) !== Number(vbase.maxGrid ?? 8)) vb.maxGrid = Number(draft.videoMaxGrid);
				if (Number(draft.videoRetentionDays) !== Number(vbase.retentionDays ?? 7)) vb.retentionDays = Number(draft.videoRetentionDays);
				if (Object.keys(vb).length > 0) patch.video = vb;
				const ub = {};
				const ubase = snapshot.ui || {};
				if (draft.showCard !== (ubase.showCard !== false)) ub.showCard = draft.showCard;
				if (Object.keys(ub).length > 0) patch.ui = ub;
				const ak = {};
				const abase = snapshot.ack || {};
				if (draft.ackEnabled !== (abase.enabled !== false)) ak.enabled = draft.ackEnabled;
				if (draft.ackMode !== (abase.mode === "all" ? "all" : "media")) ak.mode = draft.ackMode;
				if (draft.ackText !== String(abase.text ?? "收到啦，正在看你的{what}，稍等一下～")) ak.text = draft.ackText;
				if (Object.keys(ak).length > 0) patch.ack = ak;
				const sbase = snapshot.send || {};
				if (draft.captionMode !== (sbase.captionMode === "separate" ? "separate" : "merge")) {
					patch.send = { captionMode: draft.captionMode };
				}
				if (Number(draft.sendFileMaxMb) !== Number(sbase.fileMaxMb ?? 30)) {
					patch.send = { ...(patch.send || {}), fileMaxMb: Number(draft.sendFileMaxMb) };
				}
				const stbase = snapshot.sticker || {};
				const stTrigger = String(stbase.trigger ?? "存表情包");
				if (draft.stickerTrigger.trim() !== "" && draft.stickerTrigger.trim() !== stTrigger) {
					patch.sticker = { trigger: draft.stickerTrigger.trim() };
				}
				const stBaseQuote = stbase.byQuote !== false;
				const stBaseAttach = stbase.byAttach !== false;
				const stBaseRecent = stbase.byRecent !== false;
				if (draft.stickerByQuote !== stBaseQuote || draft.stickerByAttach !== stBaseAttach || draft.stickerByRecent !== stBaseRecent) {
					patch.sticker = {
						...(patch.sticker || {}),
						byQuote: draft.stickerByQuote,
						byAttach: draft.stickerByAttach,
						byRecent: draft.stickerByRecent,
					};
				}
				const stBaseFreq = ["off", "rare", "often"].includes(stbase.frequency) ? stbase.frequency : "normal";
				if (draft.stickerFrequency !== stBaseFreq) {
					patch.sticker = { ...(patch.sticker || {}), frequency: draft.stickerFrequency };
				}
				if (Object.keys(patch).length === 0) {
					setNote("没有改动");
					setError("");
					return;
				}
				setBusy(true);
				setError("");
				const out = await callRemote(pluginCtx, NS_CONFIG_UPDATE, { patch });
				setBusy(false);
				if (!out.ok) {
					setError(out.text);
					return;
				}
				if (!out.value || out.value.saved !== true) {
					setError(`没保存：${(out.value && out.value.why) || "原因未知"}`);
					return;
				}
				setNote("已保存（引擎每条消息重读，不用重启）");
				// 会话卡片的显示/隐藏要立刻响应，不用刷新页面
				try {
					if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
						window.dispatchEvent(new CustomEvent("qq-relay:ui", { detail: { showCard: draft.showCard } }));
					}
				} catch {
					/* 非浏览器环境忽略 */
				}
				await load();
			}, [draft, snapshot, load]);

			const act = useCallback(async (args) => {
				setBusy(true);
				setError("");
				const out = await callRemote(pluginCtx, NS_ACT, { args });
				setBusy(false);
				if (!out.ok) {
					setError(out.text);
					return;
				}
				await load();
			}, [load]);

			/** 图库的两个动作：清空 / 打开目录（都直接走 RPC，不经过保存）。 */
			const imageAction = useCallback(async (endpoint, describe) => {
				setBusy(true);
				setError("");
				const out = await callRemote(pluginCtx, endpoint, {});
				setBusy(false);
				if (!out.ok) {
					setError(out.text);
					return;
				}
				setNote(describe(out.value));
			}, []);

			// ---- 日志：启动台只留一行，详细都在这里看 ----
			const [log, setLog] = useState({ path: "", lines: [], error: "" });
			const loadLog = useCallback(async () => {
				const out = await callRemote(pluginCtx, NS_LOG_TAIL, { lines: 200 });
				if (out.ok) {
					setLog({ path: out.value.path || "", lines: out.value.lines || [], error: out.value.error || "" });
				} else {
					setLog({ path: "", lines: [], error: out.text });
				}
			}, []);

			useEffect(() => {
				loadLog();
			}, [loadLog]);

			// ---- 表情表（内置 + 自定义；可手动换） ----
			const [faces, setFaces] = useState({ path: "", builtin: 0, custom: 0 });
			const [facePath, setFacePath] = useState("");
			const loadFaces = useCallback(async () => {
				const out = await callRemote(pluginCtx, NS_FACES, {});
				if (out.ok && out.value) {
					setFaces(out.value);
					setFacePath((prev) => prev || out.value.path || "");
				}
			}, []);

			useEffect(() => {
				loadFaces();
			}, [loadFaces]);

			const importFaces = useCallback(async () => {
				setBusy(true);
				setError("");
				const out = await callRemote(pluginCtx, NS_FACES_IMPORT, { file: facePath.trim() });
				setBusy(false);
				if (!out.ok) { setError(out.text); return; }
				if (!out.value || out.value.ok !== true) {
					setError(`导入失败：${(out.value && out.value.why) || "原因未知"}`);
					return;
				}
				setNote(`已导入 ${out.value.imported} 条${out.value.skipped ? `（跳过 ${out.value.skipped} 条）` : ""}`);
				await loadFaces();
			}, [facePath, loadFaces]);

			const resetFaces = useCallback(async () => {
				setBusy(true);
				setError("");
				const out = await callRemote(pluginCtx, NS_FACES_RESET, {});
				setBusy(false);
				if (!out.ok) { setError(out.text); return; }
				setNote("已恢复内置表");
				setFacePath("");
				await loadFaces();
			}, [loadFaces]);

			const lockedId = snapshot && snapshot.sessionId ? snapshot.sessionId : "";
			const transport = draft.transport === "direct" ? "direct" : "mailbox";

			return React.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "16px", padding: "8px 24px 24px", maxWidth: "720px" } },
				// 标题栏 + 两个动作**吸顶**：滚到哪儿都点得到「保存」
				React.createElement(
					"div",
					{
						style: {
							position: "sticky",
							top: 0,
							zIndex: 2,
							display: "flex",
							alignItems: "center",
							gap: "8px",
							padding: "8px 0",
							margin: "-8px 0 0",
							background: "var(--dsw-alias-bg-layer-2)",
						},
					},
					React.createElement("div", { style: { color: C.label, fontSize: "16px", fontWeight: 600 } }, "QQ 中继"),
					React.createElement(
						"span",
						{ style: { color: C.caption, fontSize: "12px" } },
						busy ? "读取中…" : snapshot ? (snapshot.direct.hasSecret ? "凭据已配置" : "凭据未配置") : "",
					),
					React.createElement("span", { style: { flex: "1 1 auto" } }),
					React.createElement(Btn, { onClick: load, disabled: busy, title: "重新从 relay.json 读一遍" }, "重读"),
					React.createElement(Btn, { disabled: busy || !snapshot, onClick: save, tone: C.ok, title: "写进 relay.json（改完要点它才生效）" }, busy ? "保存中…" : "保存"),
				),
				error
					? React.createElement(
						"div",
						{ style: { color: C.error, fontSize: "12px", lineHeight: "18px", overflowWrap: "anywhere" } },
						`⚠️ ${error}`,
					)
					: null,
				note
					? React.createElement("div", { style: { color: C.ok, fontSize: "12px", lineHeight: "18px" } }, `✓ ${note}`)
					: null,
				// ---- 登录 ----
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px", borderRadius: "10px", border: `1px solid ${C.border2}` } },
					React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "登录"),
					React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px", lineHeight: "16px" } },
						"填完信息要点一次下面的「保存」才生效（只改输入框不算）",
					),
					React.createElement(
						Field,
						{ label: "AppID", hint: "QQ 开放平台 → 你的机器人 → 开发设置" },
						React.createElement(TextInput, {
							value: draft.appId,
							placeholder: "例如 1029xxxxx",
							onChange: (value) => setDraft((prev) => ({ ...prev, appId: value })),
						}),
					),
					React.createElement(
						Field,
						{
							label: "AppSecret",
							hint: snapshot && snapshot.direct.hasSecret ? "已经配过；留空 = 不修改" : "从没配过；填一次以后只回「已配置」",
						},
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "6px", alignItems: "center" } },
							React.createElement(TextInput, {
								secret: true,
								reveal: draft.reveal,
								value: draft.appSecret,
								placeholder: snapshot && snapshot.direct.hasSecret ? "••••••（留空不改）" : "粘贴 AppSecret",
								onChange: (value) => setDraft((prev) => ({ ...prev, appSecret: value })),
							}),
							React.createElement(
								Btn,
								{ onClick: () => setDraft((prev) => ({ ...prev, reveal: !prev.reveal })) },
								draft.reveal ? "隐藏" : "显示",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "Owner OpenID", hint: "只认这个人的私聊；别人的消息一律不进会话" },
						React.createElement(TextInput, {
							value: draft.ownerId,
							placeholder: "主人的 user_openid",
							onChange: (value) => setDraft((prev) => ({ ...prev, ownerId: value })),
						}),
					),
				),
				// ---- 链路 ----
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px", borderRadius: "10px", border: `1px solid ${C.border2}` } },
					React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "链路"),
					React.createElement(
						Field,
						{ label: "消息从哪来", hint: "直连 = 插件自己连 QQ（不依赖小屋）；信箱 = 旧的引擎转发" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: transport === "mailbox", onClick: () => setDraft((prev) => ({ ...prev, transport: "mailbox" })) },
								"信箱",
							),
							React.createElement(
								Choice,
								{ active: transport === "direct", onClick: () => setDraft((prev) => ({ ...prev, transport: "direct" })) },
								"直连",
							),
						),
					),
					React.createElement(Row, { label: "锁定会话", mono: true }, lockedId ? shortId(lockedId) : "未锁定"),
					React.createElement(
						"div",
						{ style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
						React.createElement(
							Btn,
							{
								disabled: busy || !currentSessionId,
								title: currentSessionId ? "把 QQ 消息投进这条会话" : "拿不到当前会话 id",
								onClick: () => act({ action: "lock", sessionId: currentSessionId }),
							},
							"锁定当前会话",
						),
						React.createElement(Btn, { disabled: busy || !lockedId, onClick: () => act({ action: "unlock" }) }, "解锁"),
						hasSessionHook
							? null
							: React.createElement(
								"span",
								{ style: { color: C.caption, fontSize: "11px" } },
								"拿不到「当前会话」id ⇒ 请用会话标题旁的「锁定这条会话」",
							),
					),
				),
				// ---- 回执 ----
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px", borderRadius: "10px", border: `1px solid ${C.border2}` } },
					React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "回执"),
					React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px", lineHeight: "17px" } },
						"收到你的消息后，先自动回你一句，让你知道“我收到了、在处理”，不用干等。回执只发给主人自己。",
					),
					React.createElement(
						Field,
						{ label: "发回执", hint: "关掉就不发；连发多条时 1.2 秒内只发一次" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.ackEnabled, onClick: () => setDraft((prev) => ({ ...prev, ackEnabled: true })) },
								"开",
							),
							React.createElement(
								Choice,
								{ active: !draft.ackEnabled, onClick: () => setDraft((prev) => ({ ...prev, ackEnabled: false })) },
								"关",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "什么时候发", hint: "图片/文件最有用；文字也发的话每条都会先回一句" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.ackMode !== "all", onClick: () => setDraft((prev) => ({ ...prev, ackMode: "media" })) },
								"只图片和文件",
							),
							React.createElement(
								Choice,
								{ active: draft.ackMode === "all", onClick: () => setDraft((prev) => ({ ...prev, ackMode: "all" })) },
								"全部消息",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "回执文案", hint: "可以用 {what}，会被换成「图片」「文件」或「消息」" },
						React.createElement(TextInput, {
							value: draft.ackText,
							onChange: (value) => setDraft((prev) => ({ ...prev, ackText: value })),
						}),
					),
				),
				// ---- 图片 ----
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px", borderRadius: "10px", border: `1px solid ${C.border2}` } },
					React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "图片"),
					React.createElement(
						Field,
						{ label: "收图片 / 动图", hint: "动图会被抽帧拼成一张网格图再投进会话" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.imageEnabled, onClick: () => setDraft((prev) => ({ ...prev, imageEnabled: true })) },
								"开",
							),
							React.createElement(
								Choice,
								{ active: !draft.imageEnabled, onClick: () => setDraft((prev) => ({ ...prev, imageEnabled: false })) },
								"关",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "连发合并（毫秒）", hint: "QQ 一次发多张会拆成几条消息；这里攒一下再合并成一轮。1 秒 = 1000 毫秒；0 = 不合" },
						React.createElement(TextInput, {
							value: draft.batchMs,
							onChange: (value) => setDraft((prev) => ({ ...prev, batchMs: value })),
						}),
					),
					React.createElement(
						Field,
						{ label: "DSH 主动发图配文" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.captionMode !== "separate", onClick: () => setDraft((prev) => ({ ...prev, captionMode: "merge" })) },
								"并进同一条",
							),
							React.createElement(
								Choice,
								{ active: draft.captionMode === "separate", onClick: () => setDraft((prev) => ({ ...prev, captionMode: "separate" })) },
								"分开两条",
							),
						),
					),
					React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px", lineHeight: "18px" } },
						React.createElement(
							"div",
							null,
							"并进同一条：图和配文在同一个气泡里，配文紧贴在图下面；图比文字窄时，右侧会留一点空白。",
						),
						React.createElement(
							"div",
							null,
							"分开两条：先发一条纯图，再发一条文字，各自一个气泡；图那条刚好贴着图，不会留白，但消息条数多一条。",
						),
					),
					React.createElement(
						"div",
						{ style: { display: "flex", gap: "20px", alignItems: "flex-start", flexWrap: "wrap" } },
						React.createElement(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "6px", alignItems: "center" } },
							React.createElement(
								MiniBubble,
								null,
								React.createElement(MiniImage, null),
								React.createElement(MiniLine, { width: "78%" }),
								React.createElement(MiniLine, { width: "56%" }),
							),
							React.createElement("div", { style: { color: C.caption, fontSize: "10px" } }, "并进同一条"),
						),
						React.createElement(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "6px", alignItems: "center" } },
							React.createElement(MiniBubble, { width: "64px" }, React.createElement(MiniImage, { height: "46px" })),
							React.createElement(
								MiniBubble,
								null,
								React.createElement(MiniLine, { width: "82%" }),
								React.createElement(MiniLine, { width: "60%" }),
							),
							React.createElement("div", { style: { color: C.caption, fontSize: "10px" } }, "分开两条"),
						),
					),
					React.createElement(
						"div",
						{ style: { display: "flex", gap: "12px", alignItems: "flex-end", flexWrap: "wrap" } },
						React.createElement(
							Field,
							{ label: "单图上限（MB）", hint: "1~50" },
							React.createElement(TextInput, {
								value: draft.maxMb,
								onChange: (value) => setDraft((prev) => ({ ...prev, maxMb: value })),
							}),
						),
						React.createElement(
							Field,
							{ label: "动图帧数", hint: "2~8，默认 4" },
							React.createElement(TextInput, {
								value: draft.gifFrames,
								onChange: (value) => setDraft((prev) => ({ ...prev, gifFrames: value })),
							}),
						),
						React.createElement(
							Field,
							{ label: "图库保留（天）", hint: "填 0 = 不落盘；0~90" },
							React.createElement(TextInput, {
								value: draft.retentionDays,
								onChange: (value) => setDraft((prev) => ({ ...prev, retentionDays: value })),
							}),
						),
					),
					React.createElement(
						"div",
						{ style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
						React.createElement(
							Btn,
							{
								disabled: busy,
								title: "立刻清空 images\\incoming\\ 里的所有图片",
								onClick: () => imageAction(NS_IMAGE_CLEAR, (value) => `已清空：${value.removed} 个 / ${Math.round((value.bytes || 0) / 1024)} KB`),
							},
							"清空临时图库的所有图片",
						),
						React.createElement(
							Btn,
							{ disabled: busy, onClick: () => imageAction(NS_IMAGE_DIR, (value) => (value.opened ? `已打开：${value.dir}` : `打不开：${value.why || ""}`)) },
							"打开图库目录",
						),
					),
					React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px", lineHeight: "16px" } },
						"图存在插件自己的 images\\ 下（incoming 会按天数清；stickers 是以后的永久区）",
					),
					// ---- 表情小词典（并进「图片」这块） ----
					React.createElement("div", { style: { height: "1px", background: C.border2, margin: "4px 0" } }),
					React.createElement(
						"div",
						{ style: { display: "flex", alignItems: "baseline", gap: "8px" } },
						React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "表情小词典"),
						React.createElement("span", { style: { flex: "1 1 auto" } }),
						React.createElement(
							"span",
							{ style: { color: C.caption, fontSize: "11px" } },
							`内置 ${faces.builtin} 条 · 自定义 ${faces.custom} 条`,
						),
					),
					React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px", lineHeight: "17px" } },
						"QQ 自带的小表情在消息里只有编号、没有名字（例如 478）。这张表把编号翻成名字，我才能说清你发的是哪一个；表里没有的会显示成「（表情 #478）」。你要是告诉我它是什么，我就能加进去。表放在插件里，不联网。",
					),
					React.createElement(
						Field,
						{ label: "表文件（JSON）", hint: '形如 {"478":"微笑"}；留空 = 用插件数据目录里的 faces.json' },
						React.createElement(TextInput, {
							value: facePath,
							placeholder: faces.path || "D:\\…\\_media\\dsh-qq-relay\\faces.json",
							onChange: setFacePath,
						}),
					),
					React.createElement(
						"div",
						{ style: { display: "flex", gap: "8px", alignItems: "center" } },
						React.createElement(Btn, { disabled: busy, onClick: importFaces }, "导入"),
						React.createElement(Btn, { disabled: busy, onClick: resetFaces }, "恢复内置表"),
					),
				),
				// ---- 表情包 ----
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px", borderRadius: "10px", border: `1px solid ${C.border2}` } },
					React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "表情包"),
					React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px", lineHeight: "17px" } },
						"在 QQ 里把图收进表情包（引用 / 直接发 / 用最近一张），以及我主动发表情包的频率。名字由我自己起，之后还能改。",
					),
					React.createElement(
						Field,
						{
							label: "表情包暗号",
							hint: "在 QQ 里引用一张图（或动图）、说这句话，我就把它收进表情包；名字我自己起，之后还能改",
						},
						React.createElement(TextInput, {
							value: draft.stickerTrigger,
							onChange: (value) => setDraft((prev) => ({ ...prev, stickerTrigger: value })),
						}),
					),
					React.createElement(
						Field,
						{ label: "引用 + 暗号", hint: "引用一张图（或动图）说暗号，就收被引用的那张" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.stickerByQuote, onClick: () => setDraft((prev) => ({ ...prev, stickerByQuote: true })) },
								"开",
							),
							React.createElement(
								Choice,
								{ active: !draft.stickerByQuote, onClick: () => setDraft((prev) => ({ ...prev, stickerByQuote: false })) },
								"关",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "直发图 + 暗号", hint: "图跟暗号在同一条消息里发（不引用），收这条带的图" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.stickerByAttach, onClick: () => setDraft((prev) => ({ ...prev, stickerByAttach: true })) },
								"开",
							),
							React.createElement(
								Choice,
								{ active: !draft.stickerByAttach, onClick: () => setDraft((prev) => ({ ...prev, stickerByAttach: false })) },
								"关",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "最近一张图 + 暗号", hint: "先发图、下一条只说暗号也能收（120 秒内）——QQ 常把图和字拆成两条消息" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.stickerByRecent, onClick: () => setDraft((prev) => ({ ...prev, stickerByRecent: true })) },
								"开",
							),
							React.createElement(
								Choice,
								{ active: !draft.stickerByRecent, onClick: () => setDraft((prev) => ({ ...prev, stickerByRecent: false })) },
								"关",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "主动发表情包的频率", hint: "这是给我看的约束：会随每条消息一起送来，我按它把握尺度；严肃话题时一律不发" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
							React.createElement(
								Choice,
								{ active: draft.stickerFrequency === "off", onClick: () => setDraft((prev) => ({ ...prev, stickerFrequency: "off" })) },
								"关",
							),
							React.createElement(
								Choice,
								{ active: draft.stickerFrequency === "rare", onClick: () => setDraft((prev) => ({ ...prev, stickerFrequency: "rare" })) },
								"偶尔",
							),
							React.createElement(
								Choice,
								{ active: draft.stickerFrequency === "normal", onClick: () => setDraft((prev) => ({ ...prev, stickerFrequency: "normal" })) },
								"正常",
							),
							React.createElement(
								Choice,
								{ active: draft.stickerFrequency === "often", onClick: () => setDraft((prev) => ({ ...prev, stickerFrequency: "often" })) },
								"常发",
							),
						),
					),
				),
				// ---- 文件 ----
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px", borderRadius: "10px", border: `1px solid ${C.border2}` } },
					React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "文件"),
					React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px", lineHeight: "17px" } },
						"你在 QQ 里发的非图片文件会存到插件自己的 files\\ 目录，消息里会写「已存到 …」；我再用文件工具去读。按天数清，填 0 = 不存。",
					),
					React.createElement(
						Field,
						{ label: "收文件", hint: "关掉之后，文件消息只留一句文字，不下载" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.fileEnabled, onClick: () => setDraft((prev) => ({ ...prev, fileEnabled: true })) },
								"开",
							),
							React.createElement(
								Choice,
								{ active: !draft.fileEnabled, onClick: () => setDraft((prev) => ({ ...prev, fileEnabled: false })) },
								"关",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "大小上限（MB）", hint: "你发进来的文件：超了只回一句「文件太大」，不下载" },
						React.createElement(TextInput, {
							value: draft.fileMaxMb,
							onChange: (value) => setDraft((prev) => ({ ...prev, fileMaxMb: value })),
						}),
					),
					React.createElement(
						Field,
						{ label: "发文件上限（MB）", hint: "我从这边发给你的文件：超了直接回「太大」，不传" },
						React.createElement(TextInput, {
							value: draft.sendFileMaxMb,
							onChange: (value) => setDraft((prev) => ({ ...prev, sendFileMaxMb: value })),
						}),
					),
					React.createElement(
						Field,
						{ label: "保留天数", hint: "填 0 = 不落盘（消息里仍会说明收到的文件名）" },
						React.createElement(TextInput, {
							value: draft.fileRetentionDays,
							onChange: (value) => setDraft((prev) => ({ ...prev, fileRetentionDays: value })),
						}),
					),
					React.createElement(
						"div",
						{ style: { display: "flex", gap: "8px" } },
						React.createElement(
							Btn,
							{ disabled: busy, onClick: () => imageAction(NS_FILE_CLEAR, (value) => `已清空：${value.removed} 个文件`) },
							"清空文件",
						),
						React.createElement(
							Btn,
							{ disabled: busy, onClick: () => imageAction(NS_FILE_DIR, (value) => (value.opened ? `已打开：${value.dir}` : `打不开：${value.why || ""}`)) },
							"打开文件目录",
						),
					),
				),
				// ---- 视频 ----
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px", borderRadius: "10px", border: `1px solid ${C.border2}` } },
					React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "视频"),
					React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px", lineHeight: "17px" } },
						"你在 QQ 里发的视频会落到 files\\，我用 analyze_video 调本地 Python：语音转字幕、抽关键帧拼图，再逐张看图、结合字幕给你一段带时间线的总结。视频本身不上传。",
					),
					React.createElement(
						Field,
						{ label: "看视频", hint: "关掉之后，视频只当普通文件存，不做分析" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.videoEnabled, onClick: () => setDraft((prev) => ({ ...prev, videoEnabled: true })) },
								"开",
							),
							React.createElement(
								Choice,
								{ active: !draft.videoEnabled, onClick: () => setDraft((prev) => ({ ...prev, videoEnabled: false })) },
								"关",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "大小上限（MB）", hint: "超了直接回「视频太大」，不下载（默认 2048）" },
						React.createElement(TextInput, {
							value: draft.videoMaxMb,
							onChange: (value) => setDraft((prev) => ({ ...prev, videoMaxMb: value })),
						}),
					),
					React.createElement(
						Field,
						{ label: "超时（秒）", hint: "本地处理最多等多久；30 分钟的视频大约 2~3 分钟" },
						React.createElement(TextInput, {
							value: draft.videoTimeoutSec,
							onChange: (value) => setDraft((prev) => ({ ...prev, videoTimeoutSec: value })),
						}),
					),
					React.createElement(
						Field,
						{ label: "模式", hint: "极速＝base＋VAD（快）；准确＝large-v3-turbo、不切音频（慢，但少漏字）" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
							React.createElement(
								Choice,
								{ active: draft.videoMode === "fast", onClick: () => setDraft((prev) => ({ ...prev, videoMode: "fast" })) },
								"极速",
							),
							React.createElement(
								Choice,
								{ active: draft.videoMode === "accurate", onClick: () => setDraft((prev) => ({ ...prev, videoMode: "accurate" })) },
								"准确",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "识别模型", hint: "自动＝按模式选（极速 base / 准确 large-v3-turbo）；也可手动指定" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
							React.createElement(
								Choice,
								{ active: draft.videoModel === "auto", onClick: () => setDraft((prev) => ({ ...prev, videoModel: "auto" })) },
								"自动",
							),
							React.createElement(
								Choice,
								{ active: draft.videoModel === "base", onClick: () => setDraft((prev) => ({ ...prev, videoModel: "base" })) },
								"base",
							),
							React.createElement(
								Choice,
								{ active: draft.videoModel === "small", onClick: () => setDraft((prev) => ({ ...prev, videoModel: "small" })) },
								"small",
							),
							React.createElement(
								Choice,
								{ active: draft.videoModel === "large-v3-turbo", onClick: () => setDraft((prev) => ({ ...prev, videoModel: "large-v3-turbo" })) },
								"turbo",
							),
						),
					),
					React.createElement(
						Field,
						{ label: "模型目录（可选）", hint: "填了就直接用这个本地目录里的模型，不再联网下载；留空＝按上面自动" },
						React.createElement(TextInput, {
							value: draft.videoModelDir,
							onChange: (value) => setDraft((prev) => ({ ...prev, videoModelDir: value })),
						}),
					),
					React.createElement(
						Field,
						{ label: "拼图上限（张）", hint: "每张 4 帧；越多我看得越细，也越费 token（1~16）" },
						React.createElement(TextInput, {
							value: draft.videoMaxGrid,
							onChange: (value) => setDraft((prev) => ({ ...prev, videoMaxGrid: value })),
						}),
					),
					React.createElement(
						Field,
						{ label: "B 站下载保留天数", hint: "B 站下的视频/音频单独存，填 0 = 不清理（默认 7 天）" },
						React.createElement(TextInput, {
							value: draft.videoRetentionDays,
							onChange: (value) => setDraft((prev) => ({ ...prev, videoRetentionDays: value })),
						}),
					),
					React.createElement(
						"div",
						{ style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
						React.createElement(
							Btn,
							{ disabled: busy, onClick: () => imageAction(NS_VIDEO_CLEAR, (value) => `已清空：${value.removed} 个文件`) },
							"清空视频缓存",
						),
						React.createElement(
							Btn,
							{ disabled: busy, onClick: () => imageAction(NS_VIDEO_DIR, (value) => (value.opened ? `已打开：${value.dir}` : `打不开：${value.why || ""}`)) },
							"打开缓存目录",
						),
						React.createElement(
							Btn,
							{ disabled: busy, onClick: () => imageAction(NS_BILI_CLEAR, (value) => `已清空：${value.removed} 个文件`) },
							"清空 B 站下载",
						),
						React.createElement(
							Btn,
							{ disabled: busy, onClick: () => imageAction(NS_BILI_DIR, (value) => (value.opened ? `已打开：${value.dir}` : `打不开：${value.why || ""}`)) },
							"打开 B 站目录",
						),
					),
				),
				// ---- 界面 ----
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px", borderRadius: "10px", border: `1px solid ${C.border2}` } },
					React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "界面"),
					React.createElement(
						Field,
						{ label: "会话卡片", hint: "会话右上角那张 QQ 中继卡片；关掉只是不显示，链路照常工作" },
						React.createElement(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							React.createElement(
								Choice,
								{ active: draft.showCard, onClick: () => setDraft((prev) => ({ ...prev, showCard: true })) },
								"显示",
							),
							React.createElement(
								Choice,
								{ active: !draft.showCard, onClick: () => setDraft((prev) => ({ ...prev, showCard: false })) },
								"隐藏",
							),
						),
					),
				),
				// ---- 日志 ----
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "8px", padding: "16px 20px", borderRadius: "10px", border: `1px solid ${C.border2}` } },
					React.createElement(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: "8px" } },
						React.createElement("div", { style: { color: C.label, fontSize: "13px", fontWeight: 600 } }, "日志"),
						React.createElement("span", { style: { flex: "1 1 auto" } }),
						React.createElement(Btn, {
							disabled: busy,
							onClick: async () => {
								await loadLog();
								const now = new Date();
								setNote(`日志已刷新（${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}）`);
							},
						}, "刷新"),
						React.createElement(
							Btn,
							{
								disabled: busy,
								title: "清空 probe.log（会先留一份 .bak）",
								onClick: async () => {
									const out = await callRemote(pluginCtx, NS_LOG_CLEAR, {});
									if (!out.ok) { setError(out.text); return; }
									setNote(`日志已清空（${Math.round((out.value.bytes || 0) / 1024)} KB）`);
									await loadLog();
								},
							},
							"清空",
						),
					),
					log.path
						? React.createElement("div", { style: { color: C.caption, fontSize: "11px", overflowWrap: "anywhere" } }, log.path)
						: null,
					log.error
						? React.createElement("div", { style: { color: C.error, fontSize: "11px" } }, `⚠️ ${log.error}`)
						: null,
					React.createElement(
						"pre",
						{
							style: {
								margin: 0,
								maxHeight: "220px",
								overflow: "auto",
								padding: "8px 10px",
								borderRadius: "8px",
								background: C.bg,
								color: C.label2,
								fontFamily: C.mono,
								fontSize: "11px",
								lineHeight: "16px",
								whiteSpace: "pre-wrap",
							},
						},
						log.lines.length > 0 ? log.lines.join("\n") : "（还没有日志）",
					),
					React.createElement(
						"div",
						{ style: { color: C.caption, fontSize: "11px" } },
						"启动台只打一行；详细过程都在这个文件里，超过 2MB 会自动轮转（留两份历史）",
					),
				),
			);
		}

		// ----------------------------------------------------------- the card
		/**
		 * The relay card: Host state + three actions.
		 *
		 * Failures are rendered in the card's own error band (never console-only),
		 * and a failed action never clears the previously shown state.
		 *
		 * ## Where the session id comes from (v7 fix)
		 *
		 * This component sits in `shell.overlay`, a ROOT-scope seat, so the
		 * framework passes no `sessionId` — that is why the card's lock button
		 * used to be dead on the real machine while the session-header button
		 * worked. The seat's GlobalStandardProps DO carry `useSessions`
		 * (`shell.overlay.standardProps` in the shipped slot catalogue lists it),
		 * so the current session is read from there and passed to the Host
		 * explicitly. `props.sessionId` is still honoured first, so the same
		 * component would work unchanged if it were ever seated per-session.
		 * @param props - root-scope slot props (`useSessions`, no `sessionId`).
		 */
		function RelayCard(props) {
			const ctx = pluginCtx;
			const [open, setOpen] = useState(true);
			const [state, setState] = useState(null);
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);
			const [busy, setBusy] = useState(null);
			// 设置页可以隐藏这张卡片（只影响显示，不影响链路）
			const [showCard, setShowCard] = useState(true);
			const aliveRef = useRef(true);
			// Called unconditionally (Hook order stays fixed) — the fallback is not
			// a Hook, which mirrors how the platform itself swaps in
			// `useAbsentSnapshot` when an optional source is missing.
			const hasSessionHook = Boolean(props && typeof props.useSessions === "function");
			const useSelector = hasSessionHook ? props.useSessions : useNoSessions;
			const selectedSessionId = useSelector(selectCurrentSessionId);
			const sessionId = (props && props.sessionId) || selectedSessionId || null;

			useEffect(() => {
				let alive = true;
				callRemote(ctx, NS_CONFIG, {}).then((out) => {
					if (!alive || !out.ok) return;
					setShowCard((out.value.ui && out.value.ui.showCard) !== false);
				});
				const onUi = (event) => {
					const detail = event && event.detail;
					if (detail && typeof detail.showCard === "boolean") setShowCard(detail.showCard);
				};
				const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function";
				if (canListen) window.addEventListener("qq-relay:ui", onUi);
				return () => {
					alive = false;
					if (canListen) window.removeEventListener("qq-relay:ui", onUi);
				};
			}, [ctx]);

			const refresh = useCallback(async () => {
				const out = await callRemote(ctx, NS_STATUS, {});
				if (!aliveRef.current) return;
				if (out.ok) {
					setState(out.value);
					setError(null);
				} else {
					setError(out.text);
				}
			}, [ctx]);

			useEffect(() => {
				aliveRef.current = true;
				refresh();
				const timer = setInterval(refresh, POLL_MS);
				return () => {
					aliveRef.current = false;
					clearInterval(timer);
				};
			}, [refresh]);

			/** Run one action, then re-read the status immediately. */
			const act = useCallback(
				async (action, extra) => {
					if (busy) return;
					setBusy(action);
					setNotice(null);
					const out = await callRemote(ctx, NS_ACT, { args: { action, ...(extra || {}) } });
					if (!aliveRef.current) return;
					setBusy(null);
					if (!out.ok) {
						setError(out.text);
						return;
					}
					const value = out.value || {};
					if (value.ok === false) {
						// A business failure arrives as an ok result with ok:false inside.
						setError(value.text || "动作失败（宿主没给原因）");
						return;
					}
					setError(null);
					setNotice(value.text || "完成");
					try {
						if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
							// value.sessionId 在锁定时有，解锁时为 null
							window.dispatchEvent(new CustomEvent("qq-relay:lock", { detail: { sessionId: value.sessionId || null } }));
						}
					} catch {
						/* 忽略 */
					}
					await refresh();
				},
				[busy, ctx, refresh],
			);

			const mode = state && state.engineMode;
			const locked = state && state.sessionId;
			const mb = (state && state.mailbox) || {};
			const decl = (state && state.declaration) || {};
			const disabled = Boolean(busy);
			// A seat that hands down no `useSessions` cannot be papered over: say it
			// in the card's own error band instead of leaving a dead button behind.
			const shownError = error || (hasSessionHook ? null : TEXT.noSession);

			const head = React.createElement(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: "6px" } },
				React.createElement("span", { style: { color: C.label, fontWeight: 600 } }, TEXT.title),
				React.createElement(
					"span",
					{ style: { width: "6px", height: "6px", borderRadius: "50%", background: shownError ? C.error : C.ok } },
				),
				React.createElement("span", { style: { flex: "1 1 auto" } }),
				React.createElement(
					Btn,
					{ onClick: () => (open ? setOpen(false) : setOpen(true)), title: open ? TEXT.close : TEXT.open },
					open ? "收起" : "展开",
				),
			);

			const body = [];
			body.push(
				React.createElement(
					Row,
					{ key: "lock", label: TEXT.locked, mono: true, title: (state && state.sessionId) || "" },
					state ? (locked ? shortId(locked) : "（没锁）") : TEXT.loading,
				),
			);
			// 📌 2026-10-18 精简：直连模式下 **信箱/引擎/心跳** 都不存在了，
			//    再显示「心跳 2752s ⚠️ 已过期」只会吓人。只有真的走信箱时才显示那三行。
			if (state && state.transport === "mailbox") {
				body.push(
					React.createElement(
						Row,
						{ key: "mode", label: TEXT.engine },
						state ? `${mode || "?"}${mode === "relay" ? "（转进信箱）" : "（引擎自己答）"}` : TEXT.loading,
					),
				);
				body.push(
					React.createElement(
						Row,
						{ key: "counts", label: TEXT.counts, mono: true },
						state
							? mb.root
								? `inbox ${mb.inbox} · outbox ${mb.outbox} · done ${mb.done} · failed ${mb.failed} · sent ${mb.sent}`
								: "（信箱还没定位到）"
							: TEXT.loading,
					),
				);
				body.push(
					React.createElement(
						Row,
						{ key: "decl", label: TEXT.decl },
						state
							? decl.published
								? `心跳 ${decl.heartbeatAgeSec}s ${decl.fresh ? "✓" : "⚠️ 已过期"}`
								: "（还没发布）"
							: TEXT.loading,
					),
				);
			}

			if (shownError) {
				body.push(
					React.createElement(
						"div",
						{
							key: "error",
							style: {
								marginTop: "2px",
								padding: "4px 6px",
								borderRadius: "6px",
								border: `1px solid ${C.error}`,
								color: C.error,
								whiteSpace: "pre-wrap",
								wordBreak: "break-word",
								maxHeight: "120px",
								overflow: "auto",
							},
						},
						`⚠️ ${shownError}`,
					),
				);
			} else if (notice) {
				body.push(
					React.createElement(
						"div",
						{
							key: "notice",
							style: {
								marginTop: "2px",
								color: C.label2,
								whiteSpace: "pre-wrap",
								maxHeight: "80px",
								overflow: "auto",
							},
						},
						notice,
					),
				);
			}

			const actions = React.createElement(
				"div",
				{ style: { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "2px", flex: "0 0 auto" } },
				React.createElement(
					Btn,
					{
						disabled: disabled || !sessionId,
						title: sessionId ? `${TEXT.lockHint}：${sessionId}` : TEXT.noSession,
						// No id ⇒ show WHY in the error band rather than sending a
						// payload the Host must refuse (and rather than doing nothing
						// silently, which is what left the real machine puzzled).
						onClick: () => (sessionId ? act("lock", { sessionId }) : setError(TEXT.noSession)),
					},
					busy === "lock" ? TEXT.busy : TEXT.lock,
				),
				React.createElement(
					Btn,
					{ disabled: disabled, title: TEXT.unlockHint, onClick: () => act("unlock") },
					busy === "unlock" ? TEXT.busy : TEXT.unlock,
				),
			);

			if (!sessionId) {
				body.push(
					React.createElement(
						"div",
						{
							key: "nosess",
							style: {
								color: C.caption,
								whiteSpace: "pre-wrap",
								overflowWrap: "anywhere",
								wordBreak: "break-word",
							},
						},
						TEXT.noSession,
					),
				);
			}

			if (!showCard) return null;

			return React.createElement(
				"div",
				{
					"data-qq-relay-card": true,
					style: {
						// The overlay layer is `position:absolute; inset:0` with
						// `pointer-events:none` and `auto` on every direct child, so an
						// absolute child here receives clicks without opting in again.
						position: "absolute",
						right: "16px",
						// Above the composer's shadow, clear of the sidebar's bottom-left
						// Settings button (the old probe line sat on top of it).
						bottom: "96px",
						width: open ? "320px" : "auto",
						// A phone-width frame must not push the card off-screen …
						maxWidth: "calc(100vw - 32px)",
						// … and a long status must scroll INSIDE a bounded card. The
						// action row is a sibling of the scrolling body (below), so the
						// buttons stay visible no matter how long the status gets.
						maxHeight: "min(70vh, 460px)",
						boxSizing: "border-box",
						display: "flex",
						flexDirection: "column",
						gap: "3px",
						padding: "6px 8px",
						borderRadius: "10px",
						border: `1px solid ${C.border}`,
						background: C.bg,
						color: C.label,
						fontSize: "11px",
						lineHeight: "16px",
						boxShadow: "0 4px 16px var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.18))",
					},
				},
				head,
				// minHeight:0 is what actually lets a flex child shrink and scroll.
				open && React.createElement(
					"div",
					{
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "2px",
							flex: "1 1 auto",
							minHeight: "0",
							overflowY: "auto",
							overflowX: "hidden",
						},
					},
					body,
				),
				open && actions,
			);
		}

		// ------------------------------------------------- header seat button
		/**
		 * Session-header action: `锁定这条会话`.
		 *
		 * Registered into `conversation.session.header.actions` (a `list` seat
		 * declared by `dsh-client-ui-conversation`) rather than
		 * `conversation.header` (a `single` seat that ui-conversation itself
		 * occupies — writing there would REPLACE the header).
		 *
		 * @param props - session-scoped props; `sessionId` is the current session.
		 */
		function LockSessionAction(props) {
			const ctx = pluginCtx;
			const [busy, setBusy] = useState(false);
			const [result, setResult] = useState(null);
			// 当前锁定的是哪条会话（没锁 = null）
			const [lockedId, setLockedId] = useState(null);
			const sessionId = props && props.sessionId;

			// 挂载时读一次 + 听卡片发出的锁定/解锁事件
			useEffect(() => {
				let alive = true;
				callRemote(ctx, NS_STATUS, {}).then((out) => {
					if (!alive || !out.ok) return;
					setLockedId((out.value && out.value.sessionId) || null);
				});
				const onLock = (event) => {
					const detail = event && event.detail;
					if (detail && "sessionId" in detail) setLockedId(detail.sessionId || null);
				};
				const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function";
				if (canListen) window.addEventListener("qq-relay:lock", onLock);
				return () => {
					alive = false;
					if (canListen) window.removeEventListener("qq-relay:lock", onLock);
				};
			}, [ctx]);

			const isHere = Boolean(sessionId && lockedId === sessionId);

			// 同一个按钮做开关：这条已锁定 ⇒ 点它就是解锁；否则就是锁定
			const run = useCallback(async () => {
				if (busy || !sessionId) return;
				setBusy(true);
				setResult(null);
				const unlocking = Boolean(sessionId && lockedId === sessionId);
				const out = await callRemote(ctx, NS_ACT, {
					args: unlocking ? { action: "unlock" } : { action: "lock", sessionId },
				});
				setBusy(false);
				if (!out.ok) {
					setResult({ ok: false, text: out.text });
					return;
				}
				const value = out.value || {};
				setResult({ ok: value.ok !== false, text: value.text || "完成" });
				if (value.ok !== false) {
					const next = unlocking ? null : sessionId;
					setLockedId(next);
					try {
						if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
							window.dispatchEvent(new CustomEvent("qq-relay:lock", { detail: { sessionId: next } }));
						}
					} catch {
						/* 忽略 */
					}
				}
			}, [busy, ctx, lockedId, sessionId]);
			const failed = result && result.ok === false;
			return React.createElement(
				"div",
				{ "data-qq-relay-lock": true, style: { display: "flex", alignItems: "center", gap: "4px" } },
				isHere &&
					React.createElement("span", {
						"data-qq-relay-locked": true,
						title: "这条会话就是 QQ 中继当前锁定接收的会话",
						style: {
							width: "7px",
							height: "7px",
							borderRadius: "50%",
							background: C.ok || "#22c55e",
							boxShadow: "0 0 0 2px rgba(34,197,94,0.18)",
							display: "inline-block",
						},
					}),
				React.createElement(
					Btn,
					{
						disabled: busy || !sessionId,
						title: isHere ? "这条会话已锁定（QQ 消息会进这里）" : sessionId ? `锁定 ${sessionId}` : TEXT.noSession,
						tone: failed ? C.error : isHere ? C.ok || C.label : C.label,
						onClick: run,
					},
					busy ? TEXT.busy : isHere ? "已锁定" : "锁定这条会话",
				),
				failed &&
					React.createElement(
						"span",
						{
							title: result.text,
							style: {
								color: C.error,
								maxWidth: "280px",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							},
						},
						`⚠️ ${result.text}`,
					),
			);
		}

		/** Services this browser module needs; each seat's declaration injects its own. */
		const inject = ["slots", "connection"];

		/**
		 * `ctx.slots.inject(<key>, register)` defers the registration until that
		 * seat's declaration exists and reinstalls it if the declaration ever
		 * returns, so nothing here depends on package load order.
		 * @param ctx - this entry's browser-side plugin context.
		 */
		function apply(ctx) {
			pluginCtx = ctx;
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{ name: "shell.overlay", id: "qq-relay.card", order: 100 },
					RelayCard,
				),
			);
			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register(
					{ name: "conversation.session.header.actions", id: "qq-relay.lock", order: 40 },
					LockSessionAction,
				),
			);
			// 🆕 设置页：排在「皮肤管理」（order 115）后面
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{ name: "settings.section", id: "qq-relay", order: 120, label: () => "QQ 中继" },
					RelaySettings,
				),
			);
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
