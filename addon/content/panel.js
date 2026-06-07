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
  started: false,

  async start() {
    if (this.started) return;
    this.started = true;

    this._setStatus("Panel JS loaded. Loading paper data...");

    try {
      await this._runPhase("read arguments", () => this._readArguments());
      await this._runPhase("setup chat", () => {
        this._wireBasicTabs();
        this._wireChatStub();
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
    if (typeof PTLogger === "undefined") load("src/utils/logger.js");
    if (typeof PTPrefs === "undefined") load("src/utils/prefs.js");
    if (typeof PTApiError === "undefined") load("src/utils/errors.js");
    if (typeof PTStorage === "undefined") load("src/modules/storage.js");
    if (typeof PTChat === "undefined") load("src/modules/chat.js");
    this._logScriptState("PTLogger", typeof PTLogger !== "undefined");
    this._logScriptState("PTPrefs", typeof PTPrefs !== "undefined");
    this._logScriptState("PTApiError", typeof PTApiError !== "undefined");
    this._logScriptState("PTStorage", typeof PTStorage !== "undefined");
    this._logScriptState("PTChat", typeof PTChat !== "undefined");
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
    this._el("pt-chat-send")?.addEventListener("click", () => this._ask());

    // Enter sends; Shift+Enter inserts a newline. Guard IME composition so a
    // Korean composition-commit Enter does not fire a send.
    this._el("pt-chat-input")?.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this._ask();
      }
    });

    // TODO: support optional user-provided supplementary files for chat context
    // in a future version (needs file parsing, privacy handling, token-limit
    // trimming, and context merging with the Zotero paper bundle).
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

  // 모델 응답은 항상 textContent로만 삽입 (innerHTML 금지)
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
    const question = (input?.value || "").trim();
    if (!question || !log) return;
    this.chatSending = true;
    if (send) send.disabled = true;
    log.textContent = "";
    this._appendBubble("user", question);
    const pending = this._appendBubble("assistant", "답변 생성 중...");
    try {
      if (typeof PTChat === "undefined") throw new Error("PTChat is not loaded.");
      if (!this.bundle) throw new Error("번역 결과가 없어 채팅 context를 만들 수 없습니다.");
      const answer = await PTChat.ask(question, this.bundle, {
        title: this.parentItem?.getField("title") || "제목 없음",
      });
      if (pending) pending.textContent = answer;
      input.value = "";
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
      "article", "section", "div", "p", "br", "span",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "strong", "b", "em", "i",
      "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td",
    ]);
    const outTag = allowed.has(tag) ? tag : "div";
    const out = this._createHTML(outTag);

    const safeClasses = Array.from(node.classList || [])
      .filter(c => /^(pt-|badge$|partial$|failed$)/.test(c))
      .join(" ");
    if (safeClasses) out.setAttribute("class", safeClasses);

    this._appendSanitizedChildren(node, out);
    return out;
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
    const content = this._el("pt-content");
    if (!content) return;
    const header = this._el("pt-header");
    const tabs = this._el("pt-tabs");
    const chat = this._el("pt-chat");
    const viewport = window.innerHeight || 720;
    const used = (header ? header.offsetHeight : 0)
      + (tabs ? tabs.offsetHeight : 0)
      + (chat ? chat.offsetHeight : 0);
    // root padding (20*2) + 3 gaps (12*3) ≈ 76px of chrome
    const available = viewport - used - 76;
    content.style.height = Math.max(180, available) + "px";
    content.style.overflowY = "auto";
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
    const log = this._el("pt-chat-log");
    if (input) input.disabled = true;
    if (send) send.disabled = true;
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
