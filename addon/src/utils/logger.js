"use strict";

var PTLogger = {
  _prefix: "[PaperFlow]",
  info(msg)  { Zotero.debug(`${this._prefix} ${msg}`); },
  warn(msg)  { Zotero.debug(`${this._prefix} WARN: ${msg}`); },
  error(msg) {
    Zotero.debug(`${this._prefix} ERROR: ${msg}`);
    Components.utils.reportError(`${this._prefix} ${msg}`);
  },
};
