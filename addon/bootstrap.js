"use strict";

var PaperTranslator;

function log(msg) {
  Zotero.debug(`[PaperFlow] ${msg}`);
}

async function startup({ id, version, rootURI }) {
  log(`startup v${version}`);

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
}

function shutdown({ id, version, rootURI }, reason) {
  log("shutdown");
  if (PaperTranslator) {
    PaperTranslator.destroy();
    PaperTranslator = undefined;
  }
}

function install() { log("install"); }
function uninstall() { log("uninstall"); }
