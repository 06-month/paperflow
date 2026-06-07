"use strict";

var PTPrefs = {
  _ns: "extensions.paper-translator",
  _initialized: false,
  _defaults: {
    geminiApiKey: "",
    autoTranslate: false,
    summaryLines: 3,
    skipReferences: true,
  },

  init() {
    if (this._initialized) return;
    this._log("PTPrefs init started");
    for (const [key, value] of Object.entries(this._defaults)) {
      this._setDefault(key, value);
    }
    this._initialized = true;
    this._log("PTPrefs init completed");
  },

  _setDefault(key, value) {
    if (!key) {
      this._warn("PTPrefs default skipped: missing key");
      return;
    }
    const full = `${this._ns}.${key}`;
    try {
      if (this._hasZoteroPrefs()) {
        try {
          if (Zotero.Prefs.get(full) !== undefined) return;
        } catch (e) {
          this._warn(`Zotero.Prefs.get failed for ${full}: ${e.message}`);
        }
        try {
          Zotero.Prefs.set(full, value);
          return;
        } catch (e) {
          this._warn(`Zotero.Prefs.set failed for ${full}: ${e.message}`);
        }
      }

      this._setDefaultWithServices(full, value);
    } catch (e) {
      this._warn(`PTPrefs default skipped for ${full}: ${e.message}`);
    }
  },

  get(key) {
    const full = `${this._ns}.${key}`;
    if (this._hasZoteroPrefs()) {
      try { return Zotero.Prefs.get(full); }
      catch (e) { this._warn(`Zotero.Prefs.get failed for ${full}: ${e.message}`); }
    }
    return this._getWithServices(full);
  },

  set(key, value) {
    const full = `${this._ns}.${key}`;
    if (this._hasZoteroPrefs()) {
      try {
        Zotero.Prefs.set(full, value);
        return;
      } catch (e) {
        this._warn(`Zotero.Prefs.set failed for ${full}: ${e.message}`);
      }
    }
    this._setWithServices(full, value);
  },

  getApiKey()     { return this.get("geminiApiKey") || ""; },
  isAutoTranslate()   { return this.get("autoTranslate") === true; },
  isSkipReferences()  { return this.get("skipReferences") !== false; },
  getSummaryLines()   { return parseInt(this.get("summaryLines") || 3, 10); },

  _hasZoteroPrefs() {
    return typeof Zotero !== "undefined"
      && Zotero.Prefs
      && typeof Zotero.Prefs.get === "function"
      && typeof Zotero.Prefs.set === "function";
  },

  _setDefaultWithServices(full, value) {
    if (typeof Services === "undefined" || !Services.prefs) {
      this._warn(`Services.prefs unavailable for ${full}`);
      return;
    }
    if (Services.prefs.getPrefType(full) !== this._prefConstant("PREF_INVALID", 0)) return;
    this._setWithServices(full, value);
  },

  _getWithServices(full) {
    try {
      if (typeof Services === "undefined" || !Services.prefs) return undefined;
      switch (Services.prefs.getPrefType(full)) {
        case this._prefConstant("PREF_BOOL", 128):
          return Services.prefs.getBoolPref(full);
        case this._prefConstant("PREF_INT", 64):
          return Services.prefs.getIntPref(full);
        case this._prefConstant("PREF_STRING", 32):
          if (typeof Services.prefs.getStringPref === "function") {
            return Services.prefs.getStringPref(full);
          }
          return Services.prefs.getCharPref(full);
        default:
          return undefined;
      }
    } catch (e) {
      this._warn(`Services.prefs read failed for ${full}: ${e.message}`);
      return undefined;
    }
  },

  _setWithServices(full, value) {
    try {
      if (typeof Services === "undefined" || !Services.prefs) {
        this._warn(`Services.prefs unavailable for ${full}`);
        return;
      }
      if (typeof value === "boolean") {
        Services.prefs.setBoolPref(full, value);
      } else if (Number.isInteger(value)) {
        Services.prefs.setIntPref(full, value);
      } else {
        if (typeof Services.prefs.setStringPref === "function") {
          Services.prefs.setStringPref(full, String(value));
        } else {
          Services.prefs.setCharPref(full, String(value));
        }
      }
    } catch (e) {
      this._warn(`Services.prefs write failed for ${full}: ${e.message}`);
    }
  },

  _prefConstant(name, fallback) {
    if (typeof Services !== "undefined" && Services.prefs && Services.prefs[name] !== undefined) {
      return Services.prefs[name];
    }
    try {
      const branch = Components.interfaces.nsIPrefBranch;
      if (branch && branch[name] !== undefined) return branch[name];
    } catch (_) {}
    return fallback;
  },

  _log(msg) {
    try { Zotero.debug(`[PaperFlow] ${msg}`); } catch (_) {}
  },

  _warn(msg) {
    const text = `[PaperFlow] ${msg}`;
    try { Zotero.debug(text); } catch (_) {}
    try { Components.utils.reportError(text); } catch (_) {}
  },
};
