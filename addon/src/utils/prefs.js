"use strict";

var PTPrefs = {
  _ns: "extensions.paper-translator",

  init() {
    this._setDefault("geminiApiKey", "");
    this._setDefault("autoTranslate", false);
    this._setDefault("summaryLines", 3);
    this._setDefault("skipReferences", true);
  },

  _setDefault(key, value) {
    const full = `${this._ns}.${key}`;
    try { if (Zotero.Prefs.get(full) === undefined) Zotero.Prefs.set(full, value); }
    catch (_) { Zotero.Prefs.set(full, value); }
  },

  get(key)        { return Zotero.Prefs.get(`${this._ns}.${key}`); },
  set(key, value) { Zotero.Prefs.set(`${this._ns}.${key}`, value); },
  getApiKey()     { return this.get("geminiApiKey") || ""; },
  isAutoTranslate()   { return this.get("autoTranslate") === true; },
  isSkipReferences()  { return this.get("skipReferences") !== false; },
  getSummaryLines()   { return parseInt(this.get("summaryLines") || 3, 10); },
};
