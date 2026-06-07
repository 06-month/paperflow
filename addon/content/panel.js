"use strict";

var PTPanel = {
  itemID: null,
  rootURI: null,
  parentItem: null,
  bundle: null,

  async init() {
    const args = window.arguments && window.arguments[0] ? window.arguments[0] : {};
    this.itemID = args.itemID || null;
    this.rootURI = args.rootURI || null;
    try {
      await this._ensureScripts();
      await this.reload();
    } catch (e) {
      this._setError(e);
    }
  },

  async _ensureScripts() {
    if (!this.rootURI) throw new Error("rootURI가 전달되지 않았습니다.");
    const load = p => Services.scriptloader.loadSubScript(this.rootURI + p, window);
    if (typeof PTLogger === "undefined") load("src/utils/logger.js");
    if (typeof PTPrefs === "undefined") load("src/utils/prefs.js");
    if (typeof PTApiError === "undefined") load("src/utils/errors.js");
    if (typeof PTStorage === "undefined") load("src/modules/storage.js");
    if (typeof PTChat === "undefined") load("src/modules/chat.js");
    PTPrefs.init();
  },

  async reload() {
    if (!this.itemID) throw new Error("itemID가 없습니다.");
    this.parentItem = Zotero.Items.get(this.itemID);
    if (!this.parentItem) throw new Error(`item ${this.itemID}을 찾지 못했습니다.`);
    this.bundle = await PTStorage.loadBundle(this.parentItem);
    this._render();
  },

  _render() {
    const title = this.bundle?.meta?.title || this.parentItem.getField("title") || "제목 없음";
    document.getElementById("pt-panel-title").textContent = title;
    document.getElementById("pt-panel-subtitle").textContent = this.bundle?.htmlAttachment
      ? "translated.ko.html 로드 완료"
      : "HTML attachment 없음 — Note/metadata 기준 표시";

    document.getElementById("pt-translation-view").innerHTML = this._buildTranslationHTML(this.bundle);
    document.getElementById("pt-meta-view").textContent = JSON.stringify(this.bundle?.meta || {}, null, 2);
  },

  _buildTranslationHTML(bundle) {
    const esc = s => (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const nl = s => esc(s).replace(/\n/g, "<br>");
    if (bundle?.sections?.length) {
      const render = (sec, depth = 0) => {
        const h = `h${Math.min(depth + 2, 5)}`;
        let out = `<div class="pt-section"><${h}>${esc(sec.heading || "Untitled")}</${h}>`;
        if (sec.summary) out += `<div class="pt-summary"><b>요약:</b><br>${nl(sec.summary)}</div>`;
        if (sec.translation) out += `<div class="pt-translation">${nl(sec.translation)}</div>`;
        if (sec.subsections?.length) out += sec.subsections.map(s => render(s, depth + 1)).join("");
        out += `</div>`;
        return out;
      };
      return bundle.sections.map(s => render(s)).join("");
    }
    if (bundle?.htmlText) return bundle.htmlText;
    return `<p>번역 데이터를 찾지 못했습니다. 먼저 Tools → Translate Paper를 실행하세요.</p>`;
  },

  async ask() {
    const input = document.getElementById("pt-chat-input");
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    this._appendMsg("user", question);
    const pending = this._appendMsg("assistant", "답변 생성 중...");
    try {
      const answer = await PTChat.ask(question, this.bundle, { title: this.parentItem.getField("title") });
      pending.textContent = answer;
    } catch (e) {
      pending.className = "pt-msg pt-error";
      pending.textContent = `오류: ${e.message}`;
    }
  },

  openHTML() {
    const att = this.bundle?.htmlAttachment;
    if (!att) return;
    const path = att.getFilePath && att.getFilePath();
    if (path) Zotero.launchFile(path);
  },

  _appendMsg(role, text) {
    const log = document.getElementById("pt-chat-log");
    const div = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    div.className = `pt-msg pt-${role}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  },

  _setError(e) {
    document.getElementById("pt-panel-subtitle").textContent = "오류";
    document.getElementById("pt-translation-view").textContent = e.message;
    document.getElementById("pt-meta-view").textContent = e.stack || e.message;
  },
};
