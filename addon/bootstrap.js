"use strict";

var PaperTranslator;
var PaperFlowChromeHandle;

function log(msg) {
  Zotero.debug(`[PaperFlow] ${msg}`);
}

async function startup({ id, version, rootURI }) {
  log(`startup v${version}`);
  registerChrome(rootURI);

  // ── 유틸 먼저 로드 ────────────────────────────────────────────────────────
  Services.scriptloader.loadSubScript(rootURI + "src/utils/logger.js");
  Services.scriptloader.loadSubScript(rootURI + "src/utils/prefs.js");
  Services.scriptloader.loadSubScript(rootURI + "src/utils/errors.js");
  Services.scriptloader.loadSubScript(rootURI + "src/utils/tokenEstimate.js");

  // ── 모듈 로드 ─────────────────────────────────────────────────────────────
  Services.scriptloader.loadSubScript(rootURI + "src/modules/itemResolver.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/extractor.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/cleaner.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/sectionizer.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/chunker.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/rateLimiter.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/jobQueue.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/translator.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/storage.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/chat.js");
  Services.scriptloader.loadSubScript(rootURI + "src/modules/readerSidebar.js");

  // ── 메인 클래스 로드 ──────────────────────────────────────────────────────
  Services.scriptloader.loadSubScript(rootURI + "src/addon.js");

  // ── 설정 패널 등록 ────────────────────────────────────────────────────────
  Zotero.PreferencePanes.register({
    pluginID: "paperflow@06-month",
    src: rootURI + "content/preferences.xhtml",
    scripts: [rootURI + "content/preferences.js"],
    label: "PaperFlow",
    image: rootURI + "content/icons/icon.png",
  });

  PaperTranslator = new PaperTranslatorAddon(rootURI);
  await PaperTranslator.init();

  // ── Reader sidebar PoC 등록 (실패해도 startup을 죽이지 않음) ─────────────
  try {
    if (typeof PaperFlowReaderSidebar !== "undefined") {
      PaperFlowReaderSidebar.install();
    }
  } catch (e) {
    log(`reader sidebar install failed: ${e.message}`);
    try { Components.utils.reportError(e); } catch (_) {}
  }
}

function shutdown({ id, version, rootURI }, reason) {
  log("shutdown");
  try {
    if (typeof PaperFlowReaderSidebar !== "undefined") {
      PaperFlowReaderSidebar.remove();
    }
  } catch (e) {
    try { Zotero.debug(`[PaperFlow] reader sidebar remove failed: ${e.message}`); } catch (_) {}
  }
  try {
    if (PaperTranslator) {
      PaperTranslator.destroy();
      PaperTranslator = undefined;
    }
  } finally {
    unregisterChrome();
  }
}

function install() { log("install"); }
function uninstall() { log("uninstall"); }

function registerChrome(rootURI) {
  try {
    if (PaperFlowChromeHandle) {
      PaperFlowChromeHandle.destruct();
      PaperFlowChromeHandle = undefined;
    }
    const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    PaperFlowChromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "paperflow", "content/"],
    ]);
    log("registered chrome://paperflow/content/");
  } catch (e) {
    try { Components.utils.reportError(e); } catch (_) {}
    throw e;
  }
}

function unregisterChrome() {
  if (!PaperFlowChromeHandle) return;
  try {
    PaperFlowChromeHandle.destruct();
  } catch (e) {
    try {
      Zotero.debug(`[PaperFlow] chrome registration cleanup failed: ${e.message}`);
      Components.utils.reportError(e);
    } catch (_) {}
  } finally {
    PaperFlowChromeHandle = undefined;
  }
}
