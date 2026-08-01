"use strict";

window.PTPrefsUI = {
  init() {
    const apiKey     = Zotero.Prefs.get("extensions.paper-translator.geminiApiKey") || "";
    const skipRefs   = Zotero.Prefs.get("extensions.paper-translator.skipReferences") !== false;
    const summLines  = String(Zotero.Prefs.get("extensions.paper-translator.summaryLines") || 3);
    const autoTrans  = Zotero.Prefs.get("extensions.paper-translator.autoTranslate") === true;
    const layoutAware = Zotero.Prefs.get("extensions.paper-translator.layoutAwareTranslation") !== false;
    const parallelRequests = String(Zotero.Prefs.get("extensions.paper-translator.parallelRequests") || 6);

    const q = id => document.getElementById(id);
    if (q("pt-api-key"))       q("pt-api-key").value = apiKey;
    if (q("pt-skip-refs"))     q("pt-skip-refs").checked = skipRefs;
    if (q("pt-summary-lines")) q("pt-summary-lines").value = summLines;
    if (q("pt-auto-translate")) q("pt-auto-translate").checked = autoTrans;
    if (q("pt-layout-aware")) q("pt-layout-aware").checked = layoutAware;
    if (q("pt-parallel-requests")) q("pt-parallel-requests").value = parallelRequests;
    this._renderSplitDirectory();

    if (apiKey) this._status("API 키 저장됨 ✓", "green");
  },

  // ── PDF 분해 저장 위치 ───────────────────────────────────────────────────
  chooseSplitDirectory() {
    try {
      const Ci = Components.interfaces;
      const picker = Components.classes["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      const title = "PDF 분해 결과를 저장할 폴더 선택";
      // Gecko 버전에 따라 init 시그니처가 다름 (browsingContext vs window)
      try {
        picker.init(window.browsingContext, title, Ci.nsIFilePicker.modeGetFolder);
      } catch (_) {
        picker.init(window, title, Ci.nsIFilePicker.modeGetFolder);
      }

      const current = String(Zotero.Prefs.get("extensions.paper-translator.pdfSplitDirectory") || "");
      if (current) {
        try {
          const dir = Components.classes["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          dir.initWithPath(current);
          if (dir.exists()) picker.displayDirectory = dir;
        } catch (_) { /* 지워진 경로면 무시하고 기본 위치에서 연다 */ }
      }

      picker.open(result => {
        try {
          if (result !== Ci.nsIFilePicker.returnOK || !picker.file) return;
          this._applySplitDirectory(picker.file);
        } catch (e) {
          this._splitStatus(`폴더를 설정하지 못했습니다: ${e.message}`, "red");
          this._reportError(`Split directory apply failed: ${e.message}`);
        }
      });
    } catch (e) {
      this._splitStatus(`폴더 선택 실패: ${e.message}`, "red");
      this._reportError(`Split directory picker failed: ${e.message}`);
    }
  },

  _applySplitDirectory(file) {
    const path = file.path;
    // 쓰기 권한이 없으면 번역 도중에야 실패하므로 지정 시점에 막는다.
    if (!file.isDirectory()) {
      this._splitStatus("폴더가 아닙니다.", "red");
      return;
    }
    if (!file.isWritable()) {
      this._splitStatus(`쓰기 권한이 없습니다: ${path}`, "red");
      return;
    }
    Zotero.Prefs.set("extensions.paper-translator.pdfSplitDirectory", path);
    this._renderSplitDirectory();
  },

  resetSplitDirectory() {
    Zotero.Prefs.set("extensions.paper-translator.pdfSplitDirectory", "");
    this._renderSplitDirectory();
  },

  _renderSplitDirectory() {
    const input = document.getElementById("pt-split-dir");
    const custom = String(Zotero.Prefs.get("extensions.paper-translator.pdfSplitDirectory") || "").trim();
    if (input) input.value = custom;

    if (!custom) {
      this._splitStatus(
        "Zotero 데이터 폴더에 저장됩니다. 페이지 렌더 이미지·그림/표·페이지 텍스트·Markdown이 PaperFlow_PdfSplit 아래에 쌓이며, 논문 한 편당 수십 MB까지 커질 수 있습니다.",
        "gray"
      );
      return;
    }
    this._splitStatus(`저장 위치: ${custom}/PaperFlow_PdfSplit — 폴더를 옮기거나 지우면 기본 위치로 자동 대체됩니다.`, "gray");
  },

  _splitStatus(msg, color) {
    const el = document.getElementById("pt-split-dir-status");
    if (!el) return;
    el.textContent = msg;
    const colors = { green: "#2da44e", red: "#cf222e", gray: "var(--fill-secondary)" };
    el.setAttribute("style", `font-size:11px;color:${colors[color] || colors.gray};margin:2px 0 4px 144px;`);
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
      const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent";
      const r = await fetch(url, {
        method: "POST",
        // API 키는 URL이 아닌 헤더로 전송 (로그/프록시 노출 방지)
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5 } }),
      });
      if (r.ok) {
        this._status("✓ 연결 성공 — Gemini 3.1 Flash-Lite 사용 가능", "green");
      } else if (r.status === 403) {
        const body = await this._readErrorBody(r);
        this._status("✗ API 키가 유효하지 않습니다. (HTTP 403)", "red");
        this._reportError(`Gemini connection test failed: HTTP ${r.status} ${body}`);
      } else if (r.status === 429) {
        const body = await this._readErrorBody(r);
        this._status("⚠ Rate limit 일시 초과 (HTTP 429)", "orange");
        this._reportError(`Gemini connection test warning: HTTP ${r.status} ${body}`);
      } else {
        const body = await this._readErrorBody(r);
        this._status(`✗ 오류 ${r.status}`, "red");
        this._reportError(`Gemini connection test failed: HTTP ${r.status} ${body}`);
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
