"use strict";

window.PTPrefsUI = {
  init() {
    const apiKey     = Zotero.Prefs.get("extensions.paper-translator.geminiApiKey") || "";
    const skipRefs   = Zotero.Prefs.get("extensions.paper-translator.skipReferences") !== false;
    const summLines  = String(Zotero.Prefs.get("extensions.paper-translator.summaryLines") || 3);
    const autoTrans  = Zotero.Prefs.get("extensions.paper-translator.autoTranslate") === true;

    const q = id => document.getElementById(id);
    if (q("pt-api-key"))       q("pt-api-key").value = apiKey;
    if (q("pt-skip-refs"))     q("pt-skip-refs").checked = skipRefs;
    if (q("pt-summary-lines")) q("pt-summary-lines").value = summLines;
    if (q("pt-auto-translate")) q("pt-auto-translate").checked = autoTrans;

    if (apiKey) this._status("API 키 저장됨 ✓", "green");
  },

  saveApiKey() {
    const input = document.getElementById("pt-api-key");
    if (!input) return;
    const key = input.value.trim();
    Zotero.Prefs.set("extensions.paper-translator.geminiApiKey", key);
    this._status(key ? "저장됨 ✓" : "비어있음", key ? "green" : "red");
  },

  toggleVisibility() {
    const input = document.getElementById("pt-api-key");
    const btn   = document.getElementById("pt-toggle-btn");
    if (!input || !btn) return;
    input.type = input.type === "password" ? "text" : "password";
    btn.setAttribute("label", input.type === "password" ? "표시" : "숨기기");
  },

  async testApi() {
    Zotero.debug("[PaperFlow] Test connection clicked");
    this.saveApiKey();
    const key = Zotero.Prefs.get("extensions.paper-translator.geminiApiKey") || "";
    if (!key) {
      this._status("Gemini API key is empty", "red");
      this._reportError("Gemini API key is empty");
      return;
    }

    this._status("확인 중...", "gray");
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${encodeURIComponent(key)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5 } }),
      });
      if (r.ok || r.status === 400) {
        this._status("✓ 연결 성공 — Gemini 3.1 Flash-Lite 사용 가능", "green");
      } else if (r.status === 403) {
        this._status("✗ API 키가 유효하지 않습니다.", "red");
        this._reportError(`Gemini connection test failed: HTTP ${r.status} ${await this._readErrorBody(r)}`);
      } else if (r.status === 429) {
        this._status("✓ 키 유효 (Rate limit 일시 초과)", "orange");
      } else {
        this._status(`✗ 오류 ${r.status}`, "red");
        this._reportError(`Gemini connection test failed: HTTP ${r.status} ${await this._readErrorBody(r)}`);
      }
    } catch (e) {
      this._status(`✗ 네트워크 오류: ${e.message}`, "red");
      this._reportError(`Gemini connection test failed: ${e.message}`);
    }
  },

  save(key, value) {
    Zotero.Prefs.set(`extensions.paper-translator.${key}`, value);
  },

  openLink(e) {
    e.preventDefault();
    if (e.target.href) Zotero.launchURL(e.target.href);
  },

  _status(msg, color) {
    const el = document.getElementById("pt-api-status");
    if (!el) return;
    el.setAttribute("value", msg);
    const colors = { green: "#2da44e", red: "#cf222e", orange: "#fb8f44", gray: "#888" };
    el.setAttribute("style", `font-size:11px;color:${colors[color] || colors.gray};flex:1;`);
  },

  async _readErrorBody(response) {
    try { return (await response.text()).slice(0, 500); }
    catch (_) { return ""; }
  },

  _reportError(msg) {
    const text = `[PaperFlow] ${msg}`;
    try { Zotero.debug(text); } catch (_) {}
    try { Components.utils.reportError(text); } catch (_) {}
  },
};
