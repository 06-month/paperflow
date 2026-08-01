"use strict";

function PTPanelConsoleLog(message) {
  try { Zotero.debug(message); } catch (_) {}
  try {
    Services.console.logStringMessage(message);
  } catch (_) {
    try { Components.utils.reportError(message); } catch (__) {}
  }
}

try {
  PTPanelConsoleLog("[PaperFlow] panel.js top-level loaded");
  document.addEventListener("DOMContentLoaded", () => {
    PTPanelConsoleLog("[PaperFlow] panel DOMContentLoaded");
    const status = document.getElementById("pt-status");
    if (status) status.textContent = "Panel JS loaded.";
  });
  window.addEventListener("load", () => {
    PTPanelConsoleLog("[PaperFlow] panel window load");
    const status = document.getElementById("pt-status");
    if (status) status.textContent = "Panel window loaded.";
  });
} catch (e) {
  try { Components.utils.reportError(e); } catch (_) {}
}

window.PTPanel = {
  itemID: null,
  rawParentItemID: null,
  rawItemID: null,
  rootURI: null,
  zotero: null,
  parentItem: null,
  bundle: null,
  bundleError: null,
  unavailableMessage: null,
  layoutMode: "split",
  started: false,
  chatSending: false,
  composing: false,
  hintTimer: null,
  hintIndex: 0,
  chatHistory: [],
  pendingAttachments: [],
  attachmentSeq: 0,
  readerSidebarBridge: null,
  readerSelectionBridgeArg: null,

  get isConnected() {
    return !window.closed;
  },

  async start() {
    if (this.started) return;
    this.started = true;

    this._setStatus("Panel JS loaded. Loading paper data...");

    try {
      await this._runPhase("read arguments", () => this._readArguments());
      await this._runPhase("setup chat", () => {
        this._wireBasicTabs();
        this._wireChatStub();
        this._wireResize();
      });
    } catch (e) {
      this._setFailure("startup", e);
      this._disableChat("PaperFlow panel failed to load.");
      return;
    }

    if (!this.itemID) {
      this._setUnavailable("논문 item을 선택한 뒤 Open PaperFlow Panel을 실행하세요.");
      return;
    }

    try {
      await this._runPhase("ensure scripts", () => this._ensureScripts());
    } catch (e) {
      this._setFailure("ensure scripts", e);
      this._disableChat("PaperFlow panel failed to load.");
      return;
    }

    // PTConstants가 올라온 뒤에야 추천 문구 목록을 읽을 수 있다.
    this._startComposerHint();

    let parentResult;
    try {
      parentResult = await this._runPhase("resolve parent item", () => this._resolveParentItemFromArgs());
    } catch (e) {
      this._setFailure("resolve parent item", e);
      this._disableChat("번역 결과가 없어 채팅 context를 만들 수 없습니다.");
      return;
    }
    if (!parentResult?.item) {
      const reason = parentResult?.reason || "unknown";
      PTPanelConsoleLog(`[PaperFlow] Panel parent item resolve failed: ${reason}`);
      this._setUnavailable(`논문 item을 선택한 뒤 Open PaperFlow Panel을 실행하세요.\nReason: ${reason}`);
      return;
    }
    this.parentItem = parentResult.item;
    PTPanelConsoleLog(`[PaperFlow] Panel parent item resolved: ${parentResult.reason || "unknown"}`);
    this._connectReaderSelectionBridge();

    try {
      this.bundle = await this._runPhase("load bundle", () => PTStorage.loadBundle(this.parentItem));
    } catch (e) {
      this.bundleError = e;
      this._logPanelError("load bundle", e);
      this._setStatus("PaperFlow 결과를 읽지 못했습니다.");
      this._setContent(`PaperFlow 결과를 읽지 못했습니다: ${this._errorSummary(e)}`);
      this._disableChat("번역 결과가 없어 채팅 context를 만들 수 없습니다.");
      return;
    }

    try {
      this._renderHeader();
      await this._runPhase("render summary", () => this._renderSummary());
      this._setStatus("PaperFlow panel ready.");
    } catch (e) {
      this._setFailure("render summary", e);
    }
  },

  async _runPhase(name, fn) {
    this._phase = name;
    PTPanelConsoleLog(`[PaperFlow] Panel phase: ${name}`);
    try {
      const result = await fn();
      PTPanelConsoleLog(`[PaperFlow] Panel phase complete: ${name}`);
      return result;
    } catch (e) {
      this._logPanelError(name, e);
      throw e;
    }
  },

  _readArguments() {
    const hasArguments = typeof window.arguments !== "undefined" && Boolean(window.arguments);
    const argLength = hasArguments && typeof window.arguments.length === "number"
      ? window.arguments.length
      : 0;
    const firstArg = hasArguments && argLength > 0 ? window.arguments[0] : null;
    const args = firstArg && typeof firstArg === "object"
      ? window.arguments[0]
      : {};
    this.rawParentItemID = args.parentItemID ?? null;
    this.rawItemID = args.itemID ?? null;
    const rawItemID = this.rawParentItemID ?? this.rawItemID ?? null;
    const numericItemID = Number(rawItemID);
    this.itemID = Number.isInteger(numericItemID) && numericItemID > 0 ? numericItemID : rawItemID;
    this.rootURI = args.rootURI || null;
    this.readerSelectionBridgeArg = args.readerSelectionBridge || null;
    this.title = args.title || "PaperFlow";
    const parentNumber = Number(this.rawParentItemID);
    const itemNumber = Number(this.rawItemID);
    PTPanelConsoleLog(`[PaperFlow] Panel arguments: exists=${hasArguments ? "true" : "false"}, length=${argLength}, firstType=${typeof firstArg}`);
    PTPanelConsoleLog(`[PaperFlow] Panel argument keys: ${this._argumentKeys(args).join(",") || "(none)"}`);
    PTPanelConsoleLog(`[PaperFlow] Panel argument parentItemID raw=${this._formatArgValue(this.rawParentItemID)}, number=${Number.isFinite(parentNumber) ? parentNumber : "NaN"}`);
    PTPanelConsoleLog(`[PaperFlow] Panel argument itemID raw=${this._formatArgValue(this.rawItemID)}, number=${Number.isFinite(itemNumber) ? itemNumber : "NaN"}`);
    PTPanelConsoleLog(`[PaperFlow] Panel arguments summary: itemID=${this.itemID ? "present" : "missing"}, rootURI=${this.rootURI ? "present" : "missing"}, title=${args.title ? "present" : "missing"}`);
    return args;
  },

  async _ensureScripts() {
    if (!this.rootURI) throw new Error("rootURI가 전달되지 않았습니다.");
    await this._runPhase("prepare Zotero API", () => this._prepareZoteroAPI());
    const load = p => Services.scriptloader.loadSubScript(this.rootURI + p, window);
    if (typeof PTConstants === "undefined") load("src/utils/constants.js");
    if (typeof PTLogger === "undefined") load("src/utils/logger.js");
    if (typeof PTPrefs === "undefined") load("src/utils/prefs.js");
    if (typeof PTApiError === "undefined") load("src/utils/errors.js");
    if (typeof PTRateLimiter === "undefined") load("src/modules/rateLimiter.js");
    if (typeof PTStorage === "undefined") load("src/modules/storage.js");
    if (typeof PTChat === "undefined") load("src/modules/chat.js");
    if (typeof PTResponseRenderer === "undefined") load("src/modules/responseRenderer.js");
    this._logScriptState("PTLogger", typeof PTLogger !== "undefined");
    this._logScriptState("PTPrefs", typeof PTPrefs !== "undefined");
    this._logScriptState("PTApiError", typeof PTApiError !== "undefined");
    this._logScriptState("PTStorage", typeof PTStorage !== "undefined");
    this._logScriptState("PTChat", typeof PTChat !== "undefined");
    this._logScriptState("PTResponseRenderer", typeof PTResponseRenderer !== "undefined");
    if (typeof PTStorage === "undefined") {
      throw new ReferenceError("PTStorage is not defined after loading storage.js");
    }
    try {
      PTPanelConsoleLog("[PaperFlow] PTPrefs init started in panel");
      if (typeof PTPrefs !== "undefined" && typeof PTPrefs.init === "function") {
        PTPrefs.init();
      }
      PTPanelConsoleLog("[PaperFlow] PTPrefs init completed in panel");
    } catch (e) {
      PTPanelConsoleLog(`[PaperFlow] PTPrefs init failed in panel: ${e.message}`);
      try { Components.utils.reportError(e); } catch (_) {}
    }
  },

  _logScriptState(name, loaded) {
    PTPanelConsoleLog(`[PaperFlow] ${name} loaded: ${loaded ? "true" : "false"}`);
  },

  _prepareZoteroAPI() {
    const context = this._findZoteroAPI();
    this.zotero = context.zotero || null;
    PTPanelConsoleLog(`[PaperFlow] panel window has Zotero: ${context.panelHasZotero ? "true" : "false"}`);
    PTPanelConsoleLog(`[PaperFlow] opener has Zotero: ${context.openerHasZotero ? "true" : "false"}`);
    PTPanelConsoleLog(`[PaperFlow] argument has Zotero: ${context.argumentHasZotero ? "true" : "false"}`);
    PTPanelConsoleLog(`[PaperFlow] Zotero.Items available: ${this.zotero?.Items ? "true" : "false"}`);

    let injected = false;
    if (this.zotero && (!window.Zotero || !window.Zotero.Items)) {
      try {
        window.Zotero = this.zotero;
        injected = true;
      } catch (e) {
        PTPanelConsoleLog(`[PaperFlow] failed to inject opener Zotero into panel window: ${e.message}`);
      }
    }
    PTPanelConsoleLog(`[PaperFlow] injected opener Zotero into panel window: ${injected ? "true" : "false"}`);
  },

  _findZoteroAPI() {
    const panelZotero = typeof window.Zotero !== "undefined" ? window.Zotero : null;
    const openerZotero = window.opener && window.opener.Zotero ? window.opener.Zotero : null;
    const argZotero = this._argumentZotero();
    const hasItems = z => Boolean(z && z.Items);
    return {
      zotero: hasItems(panelZotero) ? panelZotero
        : hasItems(openerZotero) ? openerZotero
        : hasItems(argZotero) ? argZotero
        : null,
      panelHasZotero: hasItems(panelZotero),
      openerHasZotero: hasItems(openerZotero),
      argumentHasZotero: hasItems(argZotero),
    };
  },

  _argumentZotero() {
    try {
      const args = window.arguments && window.arguments[0] && typeof window.arguments[0] === "object"
        ? window.arguments[0]
        : null;
      return args?.Zotero || null;
    } catch (_) {
      return null;
    }
  },

  async _resolveParentItemFromArgs() {
    const rawID = this.rawParentItemID ?? this.rawItemID ?? this.itemID;
    const itemID = Number(rawID);
    if (!Number.isInteger(itemID) || itemID <= 0) {
      return { item: null, reason: "missing-item-id" };
    }
    if (!this.zotero) {
      this._prepareZoteroAPI();
    }
    if (!this.zotero || !this.zotero.Items) {
      return { item: null, reason: "zotero-items-unavailable" };
    }

    const item = await this._getZoteroItem(itemID);
    if (!item) {
      return { item: null, reason: `item-not-found:${itemID}` };
    }

    if (item.isRegularItem && item.isRegularItem()) {
      return { item, reason: "direct" };
    }

    if (item.isAttachment && item.isAttachment()) {
      const parent = await this._getParentItem(item);
      return parent
        ? { item: parent, reason: "attachment-parent" }
        : { item: null, reason: `attachment-parent-not-found:${itemID}` };
    }

    const parent = await this._getParentItem(item);
    if (parent) {
      return { item: parent, reason: "child-parent" };
    }

    return { item: null, reason: `unsupported-item:${itemID}` };
  },

  async _getParentItem(item) {
    const parentID = item?.parentItemID || item?.parentID || (item?.getSource && item.getSource()) || null;
    if (!parentID) return null;
    const parent = await this._getZoteroItem(parentID);
    if (parent && parent.isRegularItem && parent.isRegularItem()) return parent;
    return parent || null;
  },

  async _getZoteroItem(itemID) {
    const z = this.zotero || this._findZoteroAPI().zotero;
    if (!z || !z.Items) {
      return null;
    }
    let item = null;
    if (typeof z.Items.get === "function") {
      try {
        item = z.Items.get(itemID);
      } catch (e) {
        PTPanelConsoleLog(`[PaperFlow] Zotero.Items.get failed for itemID=${itemID}: ${e.message}`);
      }
    }
    if (!item && typeof z.Items.getAsync === "function") {
      try {
        item = await z.Items.getAsync(itemID);
        if (Array.isArray(item)) item = item[0] || null;
      } catch (e) {
        PTPanelConsoleLog(`[PaperFlow] Zotero.Items.getAsync failed for itemID=${itemID}: ${e.message}`);
      }
    }
    return item || null;
  },

  _argumentKeys(args) {
    try { return Object.keys(args || {}); }
    catch (_) { return []; }
  },

  _formatArgValue(value) {
    if (value === null || value === undefined) return "missing";
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      return String(value);
    }
    return `[${typeof value}]`;
  },

  _wireBasicTabs() {
    this._el("pt-tab-summary")?.addEventListener("click", () => this._renderSummary());
    this._el("pt-tab-translation")?.addEventListener("click", () => this._renderTranslation());
    this._el("pt-tab-meta")?.addEventListener("click", () => this._renderMeta());
  },

  _wireChatStub() {
    const content = this._el("pt-content");
    const input = this._el("pt-chat-input");
    this._el("pt-chat-send")?.addEventListener("click", () => this._ask());
    this._el("pt-chat-attach")?.addEventListener("click", () => this._openFilePicker());

    content?.addEventListener("mouseup", () => {
      window.setTimeout(() => this._captureContentSelection(), 0);
    });
    this._onSelectionChange = () => this._handleSelectionChange();
    document.addEventListener("selectionchange", this._onSelectionChange);

    // Enter sends; Shift+Enter inserts a newline. Guard IME composition so a
    // Korean composition-commit Enter does not fire a send.
    input?.addEventListener("paste", event => this._handlePaste(event));
    input?.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this._ask();
      }
    });
    // 조합 상태를 직접 추적한다. 전송 버튼 클릭처럼 keydown을 거치지 않는
    // 경로에서도 조합을 확정한 뒤 값을 읽어야 잔여 글자가 남지 않는다.
    input?.addEventListener("compositionstart", () => { this.composing = true; });
    input?.addEventListener("compositionend", () => { this.composing = false; });
    input?.addEventListener("input", () => {
      this._autoGrowInput();
      this._syncComposerHint();
    });
    this._autoGrowInput();
    window.addEventListener("unload", () => this._disconnectReaderSelectionBridge(), { once: true });
  },

  // 입력 줄 수에 맞춰 textarea를 키운다. 컴포저는 chat pane 아래쪽에 고정돼
  // 있으므로, 높이가 늘면 아래로 밀리는 대신 윗변이 위로 올라간다.
  _autoGrowInput() {
    const input = this._el("pt-chat-input");
    if (!input) return;
    const limit = parseFloat(window.getComputedStyle(input).maxHeight);
    const max = Number.isFinite(limit) ? limit : 200;
    input.style.height = "auto";
    const next = Math.min(input.scrollHeight, max);
    input.style.height = `${next}px`;
    input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
    this._syncChatHeight();
  },

  // 첨부 칩과 컴포저가 실제로 요구하는 chat pane 높이. divider를 아무리 내려도
  // 이 값 밑으로는 내려가지 않아야 입력창 아래쪽이 창 밖으로 잘리지 않는다.
  _minChatHeight() {
    const chat = this._el("pt-chat");
    const composer = this._el("pt-chat-composer");
    // pane이 숨겨져 있으면(content-only) 실측이 0이라 의미가 없다.
    if (!chat || !composer || !composer.offsetHeight) return 0;
    const px = value => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };
    const styles = window.getComputedStyle(chat);
    const frame = px(styles.paddingTop) + px(styles.paddingBottom)
      + px(styles.borderTopWidth) + px(styles.borderBottomWidth);
    const gap = px(styles.rowGap);
    const attachments = this._el("pt-chat-attachments");
    const attachHeight = attachments && attachments.offsetHeight
      ? attachments.offsetHeight + gap
      : 0;
    const LOG_FLOOR = 32; // 답변 한 줄은 항상 남겨 둔다
    return Math.ceil(frame + gap + LOG_FLOOR + attachHeight + composer.offsetHeight);
  },

  _preferredChatHeight() {
    let saved = null;
    try { saved = parseInt(localStorage.getItem("paperflow-chat-height"), 10); } catch (_) {}
    return Number.isInteger(saved) && saved >= 170 ? saved : 210;
  },

  // 첨부/입력 줄 수가 바뀔 때마다 chat pane 높이를 다시 맞춘다. 늘어난 높이는
  // 위쪽 본문 pane에서 가져오므로 박스 아래쪽은 그대로 있고 윗변만 올라간다.
  _syncChatHeight() {
    const rootEl = this._el("pt-root");
    const workspace = this._el("pt-main");
    if (!rootEl || !workspace || this.layoutMode !== "split") return;
    const floor = this._minChatHeight();
    if (!floor) return;
    const parentHeight = workspace.offsetHeight || rootEl.offsetHeight || window.innerHeight;
    // 본문이 완전히 사라지지 않도록 상한을 두되, floor가 더 크면 floor를 지킨다.
    // floor 자체도 workspace를 넘길 수는 없다 (넘기면 어차피 담을 곳이 없다).
    const hardCap = Math.max(170, Math.floor(parentHeight - 24));
    const cappedFloor = Math.min(floor, hardCap);
    const ceiling = Math.max(cappedFloor, this._getMaxChatHeight(parentHeight, 170));
    const target = Math.min(Math.max(this._preferredChatHeight(), cappedFloor), ceiling);
    // height와 min-height를 함께 내려 flex 재분배에 기대지 않도록 한다.
    rootEl.style.setProperty("--paperflow-chat-min", `${cappedFloor}px`);
    rootEl.style.setProperty("--paperflow-chat-height", `${target}px`);
  },

  // 전송/취소 후 입력창 초기화. IME 조합이 열린 채로 비우면 조합 중이던 음절이
  // 뒤늦게 커밋되어 한 글자가 남으므로, 조합을 먼저 확정시킨다.
  _clearComposer() {
    const input = this._el("pt-chat-input");
    if (!input) return;
    const clear = () => {
      input.value = "";
      this._autoGrowInput();
      this._syncComposerHint();
    };
    clear();
    if (this.composing) {
      // blur가 조합을 이미 끝냈다면 발생하지 않는다. 남아 있는 경우에만 한 번 더.
      input.addEventListener("compositionend", () => clear(), { once: true });
    }
  },

  // 열려 있는 IME 조합을 확정한다. blur가 조합을 즉시 커밋하므로 이후에 읽는
  // value에는 마지막 음절까지 포함되고, 되돌아오는 잔여 글자도 없다.
  _commitComposition() {
    if (!this.composing) return;
    const input = this._el("pt-chat-input");
    if (!input) return;
    const refocus = document.activeElement === input;
    input.blur();
    this.composing = false;
    if (refocus) input.focus();
  },

  _composerSuggestions() {
    const list = typeof PTConstants !== "undefined" ? PTConstants.CHAT_SUGGESTIONS : null;
    return Array.isArray(list) && list.length ? list : [];
  },

  // 입력 중이거나 채팅이 비활성화된 동안에는 추천 문구를 감춘다.
  // 타이핑이 시작되면 페이드 없이 즉시 사라져야 하므로 별도 클래스를 쓴다.
  _syncComposerHint() {
    const hint = this._el("pt-composer-hint");
    const input = this._el("pt-chat-input");
    if (!hint || !input) return;
    hint.classList.toggle("pt-hint-off", !!input.value);
    const show = this.hintTimer !== null && !input.disabled && !input.value;
    hint.classList.toggle("pt-hint-visible", show && !!hint.textContent);
  },

  _startComposerHint() {
    const hint = this._el("pt-composer-hint");
    const input = this._el("pt-chat-input");
    const suggestions = this._composerSuggestions();
    if (!hint || !input || !suggestions.length || this.hintTimer !== null) return;

    // 회전 문구가 실제로 동작할 때만 기본 placeholder를 넘겨받는다.
    input.placeholder = "";
    this.hintIndex = Math.floor(Math.random() * suggestions.length);
    hint.textContent = suggestions[this.hintIndex];

    const VISIBLE_MS = 4500;
    const FADE_MS = 500;
    const advance = () => {
      const list = this._composerSuggestions();
      if (!list.length) return;
      hint.classList.remove("pt-hint-visible");
      window.setTimeout(() => {
        this.hintIndex = (this.hintIndex + 1) % list.length;
        hint.textContent = list[this.hintIndex];
        this._syncComposerHint();
      }, FADE_MS);
    };

    this.hintTimer = window.setInterval(advance, VISIBLE_MS + FADE_MS);
    this._syncComposerHint();
    window.addEventListener("unload", () => this._stopComposerHint(), { once: true });
  },

  _stopComposerHint() {
    if (this.hintTimer === null) return;
    window.clearInterval(this.hintTimer);
    this.hintTimer = null;
    this._el("pt-composer-hint")?.classList.remove("pt-hint-visible");
  },

  _connectReaderSelectionBridge() {
    try {
      const mainWindow = this.zotero?.getMainWindow?.() || window.opener || null;
      const bridge = this.readerSelectionBridgeArg
        || this.zotero?.PaperFlowReaderSidebar
        || mainWindow?.PaperFlowReaderSidebar
        || window.opener?.PaperFlowReaderSidebar
        || null;
      if (!bridge?._activePanels || typeof bridge._activePanels.add !== "function") {
        PTPanelConsoleLog("[PaperFlow] standalone panel PDF selection bridge unavailable");
        return;
      }
      bridge._activePanels.add(this);
      this.readerSidebarBridge = bridge;
      PTPanelConsoleLog("[PaperFlow] standalone panel connected to PDF selection bridge");
    } catch (e) {
      PTPanelConsoleLog(`[PaperFlow] standalone panel PDF selection bridge failed: ${e.message}`);
    }
  },

  _disconnectReaderSelectionBridge() {
    try {
      if (this.readerSidebarBridge?._activePanels) {
        this.readerSidebarBridge._activePanels.delete(this);
      }
      if (this._onSelectionChange) {
        document.removeEventListener("selectionchange", this._onSelectionChange);
        this._onSelectionChange = null;
      }
    } catch (_) {}
    this.readerSidebarBridge = null;
  },

  matchesParentItemID(parentItemID) {
    return Boolean(this.parentItem && Number(this.parentItem.id) === Number(parentItemID));
  },

  _selectionSourceLabel(source) {
    return ({ pdf: "PDF 원문", summary: "Summary", translation: "Translation" })[source] || source;
  },

  _captureContentSelection() {
    try {
      const content = this._el("pt-content");
      const source = content?.classList.contains("pt-summary-view")
        ? "summary"
        : content?.classList.contains("pt-translation-view") ? "translation" : null;
      if (!source) return;
      const selection = window.getSelection?.();
      const text = selection ? String(selection).trim() : "";
      if (text.length < 2 || !selection.anchorNode || !content.contains(selection.anchorNode)) return;
      this.addSelectionAttachment(source, text);
    } catch (e) {
      PTPanelConsoleLog(`[PaperFlow] panel content selection capture failed: ${e.message}`);
    }
  },

  _handleSelectionChange() {
    try {
      const hasViewSelection = this.pendingAttachments.some(
        item => item.kind === "selection" && (item.source === "summary" || item.source === "translation")
      );
      if (!hasViewSelection) return;
      const selection = window.getSelection?.();
      const text = selection ? String(selection).trim() : "";
      const content = this._el("pt-content");
      if (text.length >= 2 && selection.anchorNode && content?.contains(selection.anchorNode)) return;
      const active = document.activeElement;
      if (active && this._el("pt-chat")?.contains(active)) return;
      this.removeSelectionAttachment("summary");
      this.removeSelectionAttachment("translation");
    } catch (_) {}
  },

  addSelectionAttachment(source, text) {
    try {
      if (this._el("pt-chat-input")?.disabled) return;
      const maxChars = 6000;
      const truncated = text.length > maxChars;
      const clipped = truncated ? text.slice(0, maxChars) : text;
      const existing = this.pendingAttachments.find(
        item => item.kind === "selection" && item.source === source
      );
      if (existing) {
        existing.text = clipped;
        existing.truncated = truncated;
      } else {
        this.pendingAttachments.push({
          id: ++this.attachmentSeq,
          kind: "selection",
          source,
          label: this._selectionSourceLabel(source),
          text: clipped,
          truncated,
        });
      }
      this._renderAttachmentChips();
    } catch (e) {
      PTPanelConsoleLog(`[PaperFlow] panel selection attach failed: ${e.message}`);
    }
  },

  removeSelectionAttachment(source) {
    const count = this.pendingAttachments.length;
    this.pendingAttachments = this.pendingAttachments.filter(
      item => !(item.kind === "selection" && item.source === source)
    );
    if (count !== this.pendingAttachments.length) this._renderAttachmentChips();
  },

  _attachmentPreview(attachment) {
    if (attachment.kind === "media-pdf") return `PDF 문서 · ${this._formatBytes(attachment.sizeBytes)}`;
    const text = String(attachment.text || "").replace(/\s+/g, " ").trim();
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  },

  _formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
    if (value >= 1024) return `${Math.round(value / 1024)}KB`;
    return `${value}B`;
  },

  _renderAttachmentChips() {
    const box = this._el("pt-chat-attachments");
    if (!box) return;
    box.textContent = "";
    if (!this.pendingAttachments.length) {
      box.classList.remove("pt-has-attachments");
      this._syncChatHeight();
      return;
    }
    box.classList.add("pt-has-attachments");
    for (const attachment of this.pendingAttachments) {
      const chip = this._createHTML("div");
      const remove = this._createHTML("button", "pt-attach-chip-remove", "×");
      remove.setAttribute("type", "button");
      remove.setAttribute("title", "첨부 제거");
      remove.setAttribute("aria-label", "첨부 제거");
      remove.addEventListener("click", () => {
        this.pendingAttachments = this.pendingAttachments.filter(item => item.id !== attachment.id);
        this._renderAttachmentChips();
      });

      if (attachment.kind === "image" && attachment.data && attachment.mimeType) {
        chip.className = "pt-attach-chip pt-attach-chip-image";
        remove.className = "pt-attach-chip-remove pt-attach-img-remove";
        chip.appendChild(remove);
        this._renderImageInto(chip, attachment, "pt-attach-chip-img", remove);
      } else {
        chip.className = "pt-attach-chip";
        if (attachment.text) chip.setAttribute("title", attachment.text.slice(0, 400));
        const head = this._createHTML("div", "pt-attach-chip-head");
        head.appendChild(this._createHTML("strong", "pt-attach-chip-source", attachment.label));
        head.appendChild(remove);
        chip.appendChild(head);
        chip.appendChild(this._createHTML("div", "pt-attach-chip-preview", this._attachmentPreview(attachment)));
      }
      box.appendChild(chip);
    }
    // 칩이 차지한 만큼 chat pane을 위로 넓혀 컴포저가 잘리지 않게 한다.
    this._syncChatHeight();
  },

  _openFilePicker() {
    try {
      const Ci = Components.interfaces;
      const picker = Components.classes["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      try {
        picker.init(window.browsingContext, "대화에 첨부할 파일 선택", Ci.nsIFilePicker.modeOpen);
      } catch (_) {
        picker.init(window, "대화에 첨부할 파일 선택", Ci.nsIFilePicker.modeOpen);
      }
      try {
        picker.appendFilter("텍스트/이미지/PDF", "*.txt; *.md; *.json; *.csv; *.html; *.xml; *.tex; *.png; *.jpg; *.jpeg; *.webp; *.pdf");
        picker.appendFilters(Ci.nsIFilePicker.filterAll);
      } catch (_) {}
      picker.open(result => {
        if (result !== Ci.nsIFilePicker.returnOK || !picker.file) return;
        this._attachLocalFile(picker.file.path, picker.file.leafName).catch(error => {
          this._attachmentError("attach local file failed", error);
          this._setStatus(`첨부 실패: ${error.message}`);
        });
      });
    } catch (e) {
      this._attachmentError("file picker open failed", e);
      this._setStatus("파일 선택창을 열지 못했습니다.");
    }
  },

  async _attachLocalFile(path, name) {
    const extension = (String(name || "").split(".").pop() || "").toLowerCase();
    const imageTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
    const textTypes = ["txt", "md", "markdown", "json", "csv", "tsv", "html", "htm", "xml", "tex", "log", "yaml", "yml", "js", "py", "java", "c", "cpp", "h"];
    this._setStatus(`"${name}" 첨부 중...`);

    if (imageTypes[extension]) {
      const bytes = await this._readFileBytes(path);
      if (bytes.length > 6 * 1024 * 1024) {
        this._setStatus(`이미지가 너무 큽니다. (${this._formatBytes(bytes.length)} > 6MB)`);
        return;
      }
      this._addMediaAttachment({ kind: "image", label: name, mimeType: imageTypes[extension], data: this._bytesToBase64(bytes), sizeBytes: bytes.length, bytes });
      return;
    }
    if (extension === "pdf") {
      const bytes = await this._readFileBytes(path);
      if (bytes.length > 10 * 1024 * 1024) {
        this._setStatus(`PDF가 너무 큽니다. (${this._formatBytes(bytes.length)} > 10MB)`);
        return;
      }
      this._addMediaAttachment({ kind: "media-pdf", label: name, mimeType: "application/pdf", data: this._bytesToBase64(bytes), sizeBytes: bytes.length });
      return;
    }
    if (textTypes.includes(extension)) {
      const zotero = this.zotero || window.Zotero;
      let text = await zotero.File.getContentsAsync(path);
      if (extension === "html" || extension === "htm") text = this._plainTextWithBreaks(text);
      text = String(text || "").trim();
      if (!text) { this._setStatus(`"${name}"에서 텍스트를 읽지 못했습니다.`); return; }
      const truncated = text.length > 12000;
      if (truncated) text = text.slice(0, 12000);
      this.pendingAttachments.push({ id: ++this.attachmentSeq, kind: "file", source: "file", label: name, text, truncated });
      this._renderAttachmentChips();
      this._setStatus(`"${name}" 첨부됨 (${text.length}자${truncated ? ", 잘림" : ""})`);
      return;
    }
    this._setStatus("지원하지 않는 파일 형식입니다. (텍스트/이미지/PDF)");
  },

  async _readFileBytes(path) {
    if (typeof IOUtils !== "undefined" && typeof IOUtils.read === "function") return IOUtils.read(path);
    throw new Error("IOUtils를 사용할 수 없습니다.");
  },

  _bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return window.btoa(binary);
  },

  _renderImageInto(container, attachment, className, beforeNode) {
    try {
      const canvas = this._createHTML("canvas", className);
      canvas.setAttribute("title", `${attachment.label} (${this._formatBytes(attachment.sizeBytes)})`);
      if (beforeNode?.parentNode === container) container.insertBefore(canvas, beforeNode);
      else container.appendChild(canvas);
      this._drawDataImageCanvas(canvas, `data:${attachment.mimeType};base64,${attachment.data}`);
    } catch (e) {
      const fallback = this._createHTML("div", "pt-attach-chip-preview", `${attachment.label} (${this._formatBytes(attachment.sizeBytes)})`);
      if (beforeNode?.parentNode === container) container.insertBefore(fallback, beforeNode);
      else container.appendChild(fallback);
    }
  },

  _addMediaAttachment({ kind, label, mimeType, data, sizeBytes, bytes }) {
    this.pendingAttachments.push({ id: ++this.attachmentSeq, kind, source: "file", label, mimeType, data, sizeBytes, bytes: bytes || null, truncated: false });
    this._renderAttachmentChips();
    this._setStatus(`"${label}" 첨부됨 (${this._formatBytes(sizeBytes)})`);
  },

  _handlePaste(event) {
    try {
      const clipboard = event.clipboardData;
      let file = null;
      let mimeType = "";
      for (const item of Array.from(clipboard?.items || [])) {
        if (item.kind === "file" && item.type?.startsWith("image/")) {
          file = item.getAsFile();
          mimeType = item.type;
          if (file) break;
        }
      }
      if (!file) {
        for (const candidate of Array.from(clipboard?.files || [])) {
          if (candidate.type?.startsWith("image/")) { file = candidate; mimeType = candidate.type; break; }
        }
      }
      if (file) {
        event.preventDefault();
        this._attachImageFile(file, mimeType);
        return;
      }
      const image = this._readClipboardImage();
      if (!image) return;
      event.preventDefault();
      if (image.bytes.length > 6 * 1024 * 1024) {
        this._setStatus(`이미지가 너무 큽니다. (${this._formatBytes(image.bytes.length)} > 6MB)`);
        return;
      }
      this._addMediaAttachment({
        kind: "image",
        label: `클립보드 이미지 ${new Date().toLocaleTimeString("ko-KR", { hour12: false })}`,
        mimeType: image.mimeType,
        data: this._bytesToBase64(image.bytes),
        sizeBytes: image.bytes.length,
        bytes: image.bytes,
      });
    } catch (e) {
      this._attachmentError("paste handling failed", e);
    }
  },

  _attachImageFile(file, mimeType) {
    if (file.size > 6 * 1024 * 1024) {
      this._setStatus(`이미지가 너무 큽니다. (${this._formatBytes(file.size)} > 6MB)`);
      return;
    }
    const generic = !file.name || /^image\.(png|jpe?g|webp)$/i.test(file.name);
    const label = generic ? `클립보드 이미지 ${new Date().toLocaleTimeString("ko-KR", { hour12: false })}` : file.name;
    file.arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer);
      this._addMediaAttachment({ kind: "image", label, mimeType: mimeType || file.type || "image/png", data: this._bytesToBase64(bytes), sizeBytes: file.size, bytes });
    }).catch(error => {
      this._attachmentError("clipboard image read failed", error);
      this._setStatus(`이미지 첨부 실패: ${error.message}`);
    });
  },

  _readClipboardImage() {
    try {
      const Ci = Components.interfaces;
      const Cc = Components.classes;
      const clipboard = Cc["@mozilla.org/widget/clipboard;1"].getService(Ci.nsIClipboard);
      for (const flavor of ["image/png", "image/jpeg", "image/jpg"]) {
        try {
          const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
          transferable.init(null);
          transferable.addDataFlavor(flavor);
          clipboard.getData(transferable, clipboard.kGlobalClipboard);
          const data = {};
          try { transferable.getTransferData(flavor, data); }
          catch (_) { transferable.getTransferData(flavor, data, {}); }
          if (!data.value) continue;
          const stream = data.value.QueryInterface(Ci.nsIInputStream);
          const binaryStream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
          binaryStream.setInputStream(stream);
          const available = binaryStream.available();
          if (!available) continue;
          return { mimeType: flavor === "image/jpg" ? "image/jpeg" : flavor, bytes: new Uint8Array(binaryStream.readByteArray(available)) };
        } catch (_) {}
      }
    } catch (e) {
      PTPanelConsoleLog(`[PaperFlow] panel clipboard image read failed: ${e.message}`);
    }
    return null;
  },

  _attachmentError(label, error) {
    const detail = `[PaperFlow] panel ${label}: ${error?.stack || error?.message || String(error)}`;
    PTPanelConsoleLog(detail);
    try { Components.utils.reportError(detail); } catch (_) {}
  },

  _wireResize() {
    const divider = this._el("pt-divider");
    const chat = this._el("pt-chat");
    const rootEl = this._el("pt-root");
    const workspace = this._el("pt-main");
    if (!divider || !chat || !rootEl || !workspace) return;

    let isDragging = false;
    let startY = 0;
    let startHeight = 0;
    // 드래그 한 번 동안 고정되는 바닥값. content-only로 스냅되면 chat pane이
    // display:none이 되어 실측값이 0으로 떨어지는데, 그 값으로 임계점을 다시
    // 계산하면 같은 마우스 위치가 split 조건을 만족해 무한 토글(깜빡임)이 된다.
    let dragFloor = 0;
    const snapOvershoot = 56;
    const chatFloor = () => Math.max(170, this._minChatHeight());

    const onMouseDown = (e) => {
      isDragging = true;
      startY = e.clientY;
      startHeight = chat.offsetHeight;
      dragFloor = chatFloor();
      document.body.style.userSelect = "none";
      divider.classList.add("pt-dragging");
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const dy = startY - e.clientY;
      let newHeight = startHeight + dy;

      const parentHeight = workspace.offsetHeight || rootEl.offsetHeight || window.innerHeight;
      const minHeight = dragFloor || chatFloor();
      const maxHeight = Math.max(minHeight, this._getMaxChatHeight(parentHeight, minHeight));

      // 최소/최대 크기를 56px 이상 넘겨 끌면 한쪽 pane으로 스냅한다.
      // 스냅 후에도 divider는 남아 있어 반대 방향으로 다시 끌 수 있다.
      if (newHeight <= minHeight - snapOvershoot) {
        this._setLayoutMode("content-only");
        return;
      }
      if (newHeight >= maxHeight + snapOvershoot) {
        this._setLayoutMode("chat-only");
        return;
      }

      this._setLayoutMode("split");

      newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));
      rootEl.style.setProperty('--paperflow-chat-height', newHeight + "px");

      try {
        localStorage.setItem("paperflow-chat-height", String(newHeight));
      } catch (_) {}
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      dragFloor = 0;
      document.body.style.userSelect = "";
      divider.classList.remove("pt-dragging");
    };

    divider.addEventListener("mousedown", onMouseDown);
    divider.setAttribute("title", "끝까지 드래그하면 본문 또는 채팅만 표시합니다.");
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    // Restore saved height
    try {
      const savedHeight = localStorage.getItem("paperflow-chat-height");
      if (savedHeight) {
        const h = parseInt(savedHeight, 10);
        if (Number.isInteger(h) && h >= 170) {
          const parentHeight = workspace.offsetHeight || rootEl.offsetHeight || window.innerHeight;
          const clamped = Math.max(170, Math.min(h, this._getMaxChatHeight(parentHeight, 170)));
          rootEl.style.setProperty('--paperflow-chat-height', clamped + "px");
        } else {
          rootEl.style.setProperty('--paperflow-chat-height', "210px");
        }
      } else {
        rootEl.style.setProperty('--paperflow-chat-height', "210px");
      }
    } catch (_) {
      rootEl.style.setProperty('--paperflow-chat-height', "210px");
    }

    // 창 크기가 바뀌면 상한/바닥을 다시 계산한다.
    window.addEventListener("resize", () => this._syncChatHeight());

    this._restoreLayoutMode();
    // 복원된 높이가 컴포저를 담기에 부족하면 여기서 위로 넓힌다.
    this._syncChatHeight();
  },

  _getMaxChatHeight(containerHeight, minHeight = 170) {
    const height = Math.max(minHeight, Math.floor(Number(containerHeight) || 0));
    const reservedContentHeight = 180;
    const ratioLimit = Math.floor(height * 0.72);
    const reserveLimit = Math.floor(height - reservedContentHeight);
    return Math.max(minHeight, Math.min(ratioLimit, reserveLimit));
  },

  _setLayoutMode(mode, persist = true) {
    const normalized = ["split", "content-only", "chat-only"].includes(mode)
      ? mode
      : "split";
    const rootEl = this._el("pt-root");
    if (!rootEl) return;

    const changed = this.layoutMode !== normalized;
    this.layoutMode = normalized;
    rootEl.classList.toggle("pt-layout-content-only", normalized === "content-only");
    rootEl.classList.toggle("pt-layout-chat-only", normalized === "chat-only");

    if (persist && changed) {
      try { localStorage.setItem("paperflow-panel-layout-mode-v1", normalized); }
      catch (_) {}
    }
  },

  _restoreLayoutMode() {
    let mode = "split";
    try { mode = localStorage.getItem("paperflow-panel-layout-mode-v1") || "split"; }
    catch (_) {}
    this._setLayoutMode(mode, false);
  },

  _renderSummary() {
    this._setActiveTab("pt-tab-summary");
    if (this.unavailableMessage) {
      this._setContent(this.unavailableMessage);
      return;
    }
    if (this.bundleError) {
      this._setContent(`PaperFlow 결과를 읽지 못했습니다: ${this._errorSummary(this.bundleError)}`);
      return;
    }
    if (!this.bundle) {
      this._setContent("Loading...");
      return;
    }
    if (this.bundle.noteHTML) {
      this._renderHTMLContent(this.bundle.noteHTML, "pt-summary-view", "요약 노트가 없습니다.");
      return;
    }
    this._setContent("요약 노트가 없습니다. 먼저 Tools → Translate Paper를 실행하세요.");
  },

  _renderTranslation() {
    this._setActiveTab("pt-tab-translation");
    if (this.unavailableMessage) {
      this._setContent(this.unavailableMessage);
      return;
    }
    if (this.bundleError) {
      this._setContent(`PaperFlow 결과를 읽지 못했습니다: ${this._errorSummary(this.bundleError)}`);
      return;
    }
    if (!this.bundle) {
      this._setContent("Loading...");
      return;
    }
    if (this.bundle.htmlText) {
      this._renderHTMLContent(this.bundle.htmlText, "pt-translation-view", "전체 번역본이 없습니다.");
      return;
    }
    this._setContent("translated.ko.html이 없습니다. 먼저 Tools → Translate Paper를 실행하세요.");
  },

  _renderMeta() {
    this._setActiveTab("pt-tab-meta");
    if (this.unavailableMessage) {
      this._setContent(this.unavailableMessage);
      return;
    }
    if (this.bundleError) {
      this._setContent(this._formatError("load bundle", this.bundleError));
      return;
    }
    if (!this.bundle) {
      this._setContent("Loading...");
      return;
    }
    this._renderMetaContent(this.bundle.meta || {});
  },

  // 초기/사용자 말풍선은 textContent로 만들고, 모델 답변만 공용 안전
  // 렌더러가 DOM 노드로 구성한다. 모델 문자열을 innerHTML로 넣지 않는다.
  _appendBubble(role, text) {
    const log = this._el("pt-chat-log");
    if (!log) return null;
    const div = this._createHTML("div", `pt-msg pt-msg-${role}`, text);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  },

  async _ask() {
    if (this.chatSending) return; // 전송 중이면 Enter 연타/중복 클릭 무시
    const input = this._el("pt-chat-input");
    const send = this._el("pt-chat-send");
    const log = this._el("pt-chat-log");
    // 조합 중인 마지막 음절까지 확정한 뒤에 읽는다.
    this._commitComposition();
    const question = (input?.value || "").trim();
    if (!question || !log) return;
    this.chatSending = true;
    if (send) send.disabled = true;
    // 전송이 확정되는 즉시 입력창을 비워서 응답 대기 중에도 새 질문을 쓸 수 있게 한다.
    this._clearComposer();

    const promptLabelFor = attachment => {
      if (attachment.kind === "selection") return `${attachment.label}에서 드래그한 텍스트`;
      if (attachment.kind === "image") return `첨부 이미지 "${attachment.label}"`;
      if (attachment.kind === "media-pdf") return `첨부 PDF "${attachment.label}"`;
      return `첨부 파일 "${attachment.label}"`;
    };
    const attachments = this.pendingAttachments.map(attachment => ({
      kind: attachment.kind,
      label: attachment.label,
      text: attachment.text || "",
      mimeType: attachment.mimeType || "",
      data: attachment.data || "",
      bytes: attachment.bytes || null,
      sizeBytes: attachment.sizeBytes || 0,
      promptLabel: promptLabelFor(attachment),
    }));

    const userBubble = this._appendBubble("user", question);
    if (attachments.length && userBubble) {
      for (const attachment of attachments) {
        if (attachment.kind === "image" && attachment.data && attachment.mimeType) {
          this._renderImageInto(userBubble, attachment, "pt-msg-img");
        }
      }
      const textAttachments = attachments.filter(attachment => attachment.kind !== "image");
      if (textAttachments.length) {
        userBubble.appendChild(this._createHTML(
          "div",
          "pt-msg-attach-note",
          `첨부: ${textAttachments.map(attachment => `${attachment.label}${attachment.kind === "selection" ? " 드래그" : ""}`).join(", ")}`
        ));
      }
    }
    const pending = this._appendBubble("assistant", "답변 생성 중...");
    try {
      if (typeof PTChat === "undefined") throw new Error("PTChat is not loaded.");
      if (!this.bundle) throw new Error("번역 결과가 없어 채팅 context를 만들 수 없습니다.");
      const answer = await PTChat.ask(question, this.bundle, {
        title: this.parentItem?.getField("title") || "제목 없음",
        history: this.chatHistory,
        attachments: attachments
          .filter(attachment => attachment.text)
          .map(attachment => ({ label: attachment.promptLabel, text: attachment.text })),
        media: attachments
          .filter(attachment => attachment.data && attachment.mimeType)
          .map(attachment => ({ label: attachment.promptLabel, mimeType: attachment.mimeType, data: attachment.data })),
      });
      if (pending) {
        if (typeof PTResponseRenderer !== "undefined") PTResponseRenderer.render(pending, answer);
        else pending.textContent = answer;
        log.scrollTop = log.scrollHeight;
      }
      const historyQuestion = attachments.length
        ? `${question}\n(첨부: ${attachments.map(attachment => attachment.promptLabel).join(", ")})`
        : question;
      this.chatHistory.push(
        { role: "user", text: historyQuestion },
        { role: "assistant", text: answer }
      );
      if (this.chatHistory.length > 24) this.chatHistory = this.chatHistory.slice(-24);
      this.pendingAttachments = [];
      this._renderAttachmentChips();
    } catch (e) {
      if (pending) {
        pending.setAttribute("class", "pt-msg pt-msg-error");
        pending.textContent = `오류: ${e.message}`;
      }
    } finally {
      this.chatSending = false;
      if (send) send.disabled = false;
    }
  },

  _textFromHTML(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || "").replace(/<!-- PT_META:[\s\S]*?-->/g, ""), "text/html");
    return doc.body?.textContent?.trim() || "표시할 내용이 없습니다.";
  },

  _renderHTMLContent(html, className, emptyMessage) {
    const content = this._clearContent(className);
    if (!content) return;

    const cleanHTML = String(html || "").replace(/<!-- PT_META:[\s\S]*?-->/g, "");
    const doc = new DOMParser().parseFromString(cleanHTML, "text/html");
    doc.querySelectorAll("script, style, iframe, object, embed").forEach(node => node.remove());

    const wrapper = this._createHTML("div", `pt-doc ${className}`);
    this._appendSanitizedChildren(doc.body || doc, wrapper);

    if (!wrapper.textContent.trim()) {
      wrapper.textContent = emptyMessage || "표시할 내용이 없습니다.";
    } else if (!this._hasBlockChildren(wrapper)) {
      wrapper.textContent = this._plainTextWithBreaks(cleanHTML);
    }

    content.appendChild(wrapper);
  },

  _appendSanitizedChildren(source, target) {
    for (const child of Array.from(source.childNodes || [])) {
      const sanitized = this._sanitizeNode(child);
      if (sanitized) target.appendChild(sanitized);
    }
  },

  _sanitizeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.nodeValue || "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const tag = node.localName ? node.localName.toLowerCase() : "";
    const allowed = new Set([
      "article", "section", "figure", "figcaption", "div", "p", "br", "span", "img",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "strong", "b", "em", "i",
      "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td",
      "details", "summary",
    ]);
    const mathTags = new Set([
      "math", "mrow", "mi", "mn", "mo", "mtext", "mspace", "ms",
      "mfrac", "msqrt", "mroot", "mstyle", "merror", "mpadded", "mphantom",
      "msub", "msup", "msubsup", "munder", "mover", "munderover",
      "mmultiscripts", "mprescripts", "none", "mtable", "mlabeledtr", "mtr", "mtd",
      "menclose", "mfenced",
    ]);
    const safeClasses = Array.from(node.classList || [])
      .filter(c => /^(pt-|badge$|partial$|failed$)/.test(c))
      .join(" ");

    if (tag === "img") {
      const src = node.getAttribute("src") || "";
      if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(src)) return null;
      const out = this._createHTML("canvas");
      if (safeClasses) out.setAttribute("class", safeClasses);
      const alt = String(node.getAttribute("alt") || "").slice(0, 500);
      if (alt) {
        out.setAttribute("aria-label", alt);
        out.setAttribute("title", alt);
      }
      this._drawDataImageCanvas(out, src);
      return out;
    }

    if (mathTags.has(tag)) {
      const out = document.createElementNS("http://www.w3.org/1998/Math/MathML", tag);
      const safeMathAttributes = new Set([
        "display", "mathvariant", "mathsize", "mathcolor", "mathbackground",
        "scriptlevel", "displaystyle", "stretchy", "symmetric", "maxsize", "minsize",
        "largeop", "movablelimits", "accent", "accentunder", "linethickness",
        "numalign", "denomalign", "bevelled", "notation", "open", "close", "separators",
        "columnalign", "rowalign", "columnspacing", "rowspacing", "columnlines", "rowlines",
        "frame", "framespacing", "equalrows", "equalcolumns", "rowspan", "columnspan",
        "width", "height", "depth", "lspace", "rspace", "voffset",
      ]);
      for (const attribute of Array.from(node.attributes || [])) {
        const name = String(attribute.localName || attribute.name || "").toLowerCase();
        if (safeMathAttributes.has(name)) out.setAttribute(name, String(attribute.value || "").slice(0, 200));
      }
      this._appendSanitizedChildren(node, out);
      return out;
    }

    const outTag = allowed.has(tag) ? tag : "div";
    const out = this._createHTML(outTag);
    if (safeClasses) out.setAttribute("class", safeClasses);

    this._appendSanitizedChildren(node, out);
    return out;
  },

  _drawDataImageCanvas(canvas, dataURI) {
    try {
      const match = String(dataURI || "").match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i);
      const win = document.defaultView || window;
      if (!match || !win || typeof win.createImageBitmap !== "function") return;
      const binary = win.atob(match[2]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new win.Blob([bytes], { type: match[1] });
      win.createImageBitmap(blob)
        .then(bitmap => {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          if (typeof bitmap.close === "function") bitmap.close();
        })
        .catch(error => PTPanelConsoleLog(`[PaperFlow] source visual decode failed: ${error.message}`));
    } catch (error) {
      PTPanelConsoleLog(`[PaperFlow] source visual render failed: ${error.message}`);
    }
  },

  _plainTextWithBreaks(html) {
    return String(html || "")
      .replace(/<!-- PT_META:[\s\S]*?-->/g, "")
      .replace(/<\/(h[1-6]|p|div|section|article|li|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || "표시할 내용이 없습니다.";
  },

  _hasBlockChildren(node) {
    return Array.from(node.querySelectorAll("h1,h2,h3,h4,h5,h6,p,section,article,ul,ol,table")).length > 0;
  },

  _renderMetaContent(meta) {
    const content = this._clearContent("pt-meta-view");
    if (!content) return;

    const wrapper = this._createHTML("div", "pt-doc pt-meta-view");
    const table = this._createHTML("table", "pt-meta-summary");
    const tbody = this._createHTML("tbody");
    table.appendChild(tbody);

    const rows = [
      ["status", meta.status || this.bundle?.existing?.status || "unknown"],
      ["completedAt", meta.completedAt || meta.updatedAt || meta.savedAt || ""],
      ["total chunks", meta.totalChunks ?? meta.chunks?.length ?? ""],
      ["done chunks", meta.doneChunks ?? this._countChunks(meta, "done")],
      ["failed chunks", meta.failedChunks ?? this._countChunks(meta, "failed")],
      ["layout analysis", meta.layoutAnalysis?.status || "text-only"],
      ["layout mode", meta.layout?.mode || meta.layoutAnalysis?.mode || "-"],
      ["source visuals", meta.layout?.stats?.visualBlocks ?? 0],
      ["LaTeX expressions", meta.layout?.stats?.latexExpressions ?? 0],
      ["PDF split folder", meta.layout?.splitOutput?.rootPath || "-"],
      ["htmlAttachmentID", meta.htmlAttachmentID || meta.htmlAttachmentId || this.bundle?.existing?.htmlAttachmentID || ""],
      ["metaAttachmentID", meta.metaAttachmentID || meta.metaAttachmentId || this.bundle?.existing?.metaAttachmentID || ""],
    ];
    for (const [key, value] of rows) {
      const tr = this._createHTML("tr");
      const th = this._createHTML("th", "", key);
      const td = this._createHTML("td", "", value === "" || value === null || value === undefined ? "-" : String(value));
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    const rawTitle = this._createHTML("h2", "", "Raw JSON");
    const pre = this._createHTML("pre", "pt-raw-json", JSON.stringify(meta || {}, null, 2) || "{}");
    wrapper.appendChild(table);
    wrapper.appendChild(rawTitle);
    wrapper.appendChild(pre);
    content.appendChild(wrapper);
  },

  _countChunks(meta, status) {
    return Array.isArray(meta?.chunks)
      ? meta.chunks.filter(chunk => chunk && chunk.status === status).length
      : "";
  },

  _setActiveTab(activeId) {
    for (const id of ["pt-tab-summary", "pt-tab-translation", "pt-tab-meta"]) {
      const el = this._el(id);
      if (!el) continue;
      const base = "pt-tab" + (id === activeId ? " pt-tab-active" : "");
      el.setAttribute("class", base);
    }
    this._layout();
  },

  // JS layout fallback: guarantee #pt-content has a bounded height so it
  // scrolls internally even if XUL/HTML flex height does not propagate.
  _layout() {
    // Pure CSS flexbox handles all layout and scrolling.
    const content = this._el("pt-content");
    if (content) {
      content.style.height = "";
      content.style.overflowY = "auto";
    }
  },

  _renderHeader() {
    const titleEl = this._el("pt-paper-title");
    const title = this.bundle?.meta?.title
      || (this.parentItem?.getField ? this.parentItem.getField("title") : "")
      || this.title
      || "PaperFlow";
    if (titleEl) titleEl.textContent = title;

    const meta = this.bundle?.meta || {};
    const existing = this.bundle?.existing || {};
    const rawStatus = String(existing.status || meta.status || "missing").toLowerCase();
    let chipKind = "missing";
    if (/complete|done/.test(rawStatus)) chipKind = "completed";
    else if (/partial|running|pending/.test(rawStatus)) chipKind = "partial";
    else if (this.bundle && (this.bundle.noteHTML || this.bundle.htmlText)) chipKind = "partial";

    const chip = this._el("pt-status-chip");
    if (chip) {
      chip.textContent = chipKind;
      chip.setAttribute("class", `pt-chip pt-chip-${chipKind}`);
    }

    const prog = this._el("pt-chunk-progress");
    if (prog) {
      const total = meta.totalChunks ?? (Array.isArray(meta.chunks) ? meta.chunks.length : null);
      const done = meta.doneChunks ?? this._countChunks(meta, "done");
      prog.textContent = (total && Number.isFinite(Number(total)) && Number(total) > 0)
        ? `${done || 0}/${total} chunks`
        : "";
    }
    this._layout();
  },

  _setStatus(text) {
    const status = this._el("pt-status");
    if (status) status.textContent = text || "";
  },

  _setContent(text) {
    const content = this._clearContent("pt-text-view");
    if (content) content.textContent = text || "";
  },

  _clearContent(className) {
    const content = this._el("pt-content");
    if (!content) return null;
    content.textContent = "";
    content.setAttribute("class", className || "");
    return content;
  },

  _createHTML(tag, className, text) {
    const el = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (className) el.setAttribute("class", className);
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  },

  _disableChat(message) {
    const input = this._el("pt-chat-input");
    const send = this._el("pt-chat-send");
    const attach = this._el("pt-chat-attach");
    const log = this._el("pt-chat-log");
    if (input) input.disabled = true;
    if (send) send.disabled = true;
    if (attach) attach.disabled = true;
    this._syncComposerHint();
    this.pendingAttachments = [];
    this._renderAttachmentChips();
    if (log) log.textContent = message || "";
  },

  _setUnavailable(message) {
    this.unavailableMessage = message || "논문 item을 선택한 뒤 Open PaperFlow Panel을 실행하세요.";
    this._setStatus("논문 item을 선택한 뒤 Open PaperFlow Panel을 실행하세요.");
    this._setContent(this.unavailableMessage);
    this._disableChat("번역 결과가 없어 채팅 context를 만들 수 없습니다.");
  },

  _setFailure(phase, error) {
    const detail = this._formatError(phase, error);
    this._setStatus(`PaperFlow panel failed to load. Phase: ${phase}`);
    this._setContent(detail);
    this._logPanelError(phase, error);
  },

  _logPanelError(phase, error) {
    const detail = this._formatError(phase, error);
    PTPanelConsoleLog(`[PaperFlow] Panel phase failed: ${phase}: ${this._errorSummary(error)}`);
    try { Components.utils.reportError(detail); } catch (_) {}
  },

  _formatError(phase, error) {
    return [
      "PaperFlow panel failed to load.",
      `Phase: ${phase || this._phase || "unknown"}`,
      `Error: ${this._errorSummary(error)}`,
      "Stack:",
      this._errorStack(error),
    ].join("\n");
  },

  _errorSummary(error) {
    if (!error) return "Unknown error";
    const name = error.name || "Error";
    const message = error.message || String(error) || "No error message";
    return `${name}: ${message}`;
  },

  _errorStack(error) {
    if (!error) return "No stack";
    return error.stack || String(error) || "No stack";
  },

  _el(id) {
    return document.getElementById(id);
  },
};

let PTPanelStarted = false;
function PTPanelStart() {
  if (PTPanelStarted) return;
  PTPanelStarted = true;
  window.PTPanel.start().catch(e => {
    try {
      window.PTPanel._setFailure("start", e);
    } catch (_) {
      try { Components.utils.reportError(e); } catch (__) {}
      const status = document.getElementById("pt-status");
      if (status) status.textContent = "PaperFlow panel failed to load.";
    }
  });
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  PTPanelStart();
} else {
  document.addEventListener("DOMContentLoaded", PTPanelStart, { once: true });
}
window.addEventListener("load", PTPanelStart, { once: true });

function PTPanelRelayout() {
  try { window.PTPanel && window.PTPanel._layout && window.PTPanel._layout(); }
  catch (_) {}
}
window.addEventListener("load", PTPanelRelayout);
window.addEventListener("resize", PTPanelRelayout);
