"use strict";

class PaperTranslatorAddon {
  constructor(rootURI) {
    this.rootURI = rootURI;
    this._menuItems = []; // 정리 시 제거할 DOM 요소들
    this._windowListener = null;
  }

  async init() {
    PTLogger.info("init");
    PTPrefs.init();
    PTRateLimiter.init();

    // 모든 열린 창에 메뉴 추가
    this._registerWindowListener();
    this._addMenuToAllWindows();

    PTLogger.info("init 완료 — Tools 메뉴에서 'Translate Paper' 실행");
  }

  destroy() {
    PTLogger.info("destroy");

    // 큐 실행 중이면 취소
    if (PTJobQueue.isRunning()) PTJobQueue.cancel();

    // 창 리스너 해제
    if (this._windowListener) {
      Services.ww.unregisterNotification(this._windowListener);
      this._windowListener = null;
    }

    // 메뉴 아이템 제거
    this._removeMenuFromAllWindows();
  }

  // ── 창 리스너: 새 Zotero 창이 열릴 때 메뉴 추가 ──────────────────────────
  _registerWindowListener() {
    const self = this;
    this._windowListener = {
      observe(subject, topic) {
        if (topic === "domwindowopened") {
          const win = subject;
          win.addEventListener("load", () => {
            self._addMenuToWindow(win);
          }, { once: true });
        }
      },
    };
    Services.ww.registerNotification(this._windowListener);
  }

  _addMenuToAllWindows() {
    const wins = Services.wm.getEnumerator("navigator:browser");
    while (wins.hasMoreElements()) {
      this._addMenuToWindow(wins.getNext());
    }
  }

  _removeMenuFromAllWindows() {
    for (const el of this._menuItems) {
      try { el.remove(); } catch (_) {}
    }
    this._menuItems = [];
  }

  // ── Tools 메뉴에 "Translate Paper" 추가 ──────────────────────────────────
  _addMenuToWindow(win) {
    const doc = win.document;
    if (!doc) return;

    const toolsMenu = doc.getElementById("menu_ToolsPopup")
      || doc.getElementById("zotero-tb-tools-popup");
    if (!toolsMenu) return;

    // 이미 추가됐으면 스킵
    if (doc.getElementById("paper-translator-menuitem")) return;

    const separator = doc.createElementNS(
      "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
      "menuseparator"
    );
    separator.id = "paper-translator-separator";

    const menuitem = doc.createElementNS(
      "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
      "menuitem"
    );
    menuitem.id = "paper-translator-menuitem";
    menuitem.setAttribute("label", "Translate Paper");
    menuitem.setAttribute("accesskey", "T");
    menuitem.addEventListener("command", () => this.runTranslation(win));

    const panelItem = doc.createElementNS(
      "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
      "menuitem"
    );
    panelItem.id = "paper-translator-panel-menuitem";
    panelItem.setAttribute("label", "Open PaperFlow Panel");
    panelItem.addEventListener("command", () => this.openTranslationPanel(win));

    toolsMenu.appendChild(separator);
    toolsMenu.appendChild(menuitem);
    toolsMenu.appendChild(panelItem);

    this._menuItems.push(separator, menuitem, panelItem);
    PTLogger.info("메뉴 추가 완료");
  }

  // ── 메인 번역 실행 ────────────────────────────────────────────────────────
  async runTranslation(win) {
    PTLogger.info("번역 시작 요청");

    // 1. API 키 확인
    const apiKey = PTPrefs.getApiKey();
    if (!apiKey) {
      this._alert(win, "API 키가 설정되지 않았습니다.\nEdit → Preferences → PaperFlow에서 설정해주세요.");
      return;
    }

    // 2. 선택된 item 확인
    const selectedItem = PTItemResolver.getSelectedItem();
    if (!selectedItem) {
      this._alert(win, "번역할 논문을 선택해주세요.");
      return;
    }

    // 3. PDF attachment 식별
    let resolved;
    try {
      resolved = PTItemResolver.resolve(selectedItem);
    } catch (e) {
      this._alert(win, e.message);
      return;
    }

    // 4. 이미 번역 중이면 중단
    if (PTJobQueue.isRunning()) {
      const cancel = this._confirm(win, "번역이 이미 진행 중입니다. 취소하시겠습니까?");
      if (cancel) PTJobQueue.cancel();
      return;
    }

    const { parentItem, pdfAttachment } = resolved;
    const title = (parentItem || pdfAttachment).getField("title") || "제목 없음";

    PTLogger.info(`번역 대상: "${title}"`);

    // 5. progress 창 열기
    const progressWin = this._openProgressWindow(win, title);

    const startedAt = new Date().toISOString();

    try {
      // Phase 3: 텍스트 추출
      progressWin.update("PDF 텍스트 추출 중...", 0);
      const rawText = await PTExtractor.extract(pdfAttachment);

      // Phase 4: 정제
      progressWin.update("텍스트 정제 중...", 5);
      const cleanText = PTCleaner.clean(rawText, {
        skipReferences: PTPrefs.isSkipReferences(),
      });

      // Phase 5: 섹션 트리
      progressWin.update("섹션 분석 중...", 10);
      const sections = PTSectionizer.sectionize(cleanText);

      // Phase 6: chunking
      progressWin.update("청킹 중...", 15);
      const jobs = PTChunker.buildJobs(sections);
      PTLogger.info(`총 ${jobs.length}개 chunk 생성`);

      progressWin.update(`번역 시작 (총 ${jobs.length}개 chunk)...`, 20);

      // Phase 7~8: queue 번역
      await PTJobQueue.run(jobs, {
        onProgress: (done, total, lastJob, isSectionBoundary) => {
          const pct = 20 + Math.floor((done / total) * 75);
          progressWin.update(
            `번역 중... ${done}/${total} chunk\n(${lastJob.heading})`,
            pct
          );
        },
        onComplete: async (finishedJobs) => {
          // Phase 9: 저장
          progressWin.update("저장 중...", 96);
          try {
            await PTStorage.save(parentItem || pdfAttachment, finishedJobs, {
              title,
              sections,
              startedAt,
              modelName: "gemini-3.1-flash-lite",
            });
            progressWin.update("✅ 완료!", 100);
            progressWin.setDone(true);
            PTLogger.info("번역 파이프라인 완료");
          } catch (saveErr) {
            PTLogger.error(`저장 실패: ${saveErr.message}`);
            progressWin.update(`저장 실패: ${saveErr.message}`, 100);
            progressWin.setDone(false);
          }
        },
        onError: (err) => {
          PTLogger.error(`큐 오류: ${err.message}`);
          progressWin.update(`오류: ${err.message}`, 100);
          progressWin.setDone(false);
        },
      });

    } catch (e) {
      PTLogger.error(`파이프라인 오류: ${e.message}`);
      progressWin.update(`오류: ${e.message}`, 100);
      progressWin.setDone(false);
    }
  }


  async openTranslationPanel(win) {
    const selectedItem = PTItemResolver.getSelectedItem();
    if (!selectedItem) {
      this._alert(win, "패널을 열 논문을 선택해주세요.");
      return;
    }

    let resolved;
    try {
      resolved = PTItemResolver.resolve(selectedItem);
    } catch (e) {
      this._alert(win, e.message);
      return;
    }

    const parentItem = resolved.parentItem || resolved.pdfAttachment;
    const itemID = parentItem.id;
    win.openDialog(
      this.rootURI + "content/panel.xhtml",
      `paper-translator-panel-${itemID}`,
      "chrome,resizable,centerscreen,width=720,height=820",
      { itemID, rootURI: this.rootURI }
    );
  }

  // ── Progress 창 ───────────────────────────────────────────────────────────
  _openProgressWindow(win, title) {
    // Zotero 내장 ProgressWindow 사용
    const pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("PaperFlow");
    pw.addDescription(`"${title.slice(0, 60)}${title.length > 60 ? "..." : ""}"`);

    const item = new pw.ItemProgress(
      "chrome://zotero/skin/tick.png",
      "준비 중..."
    );
    pw.show();

    return {
      update(msg, pct) {
        item.setProgress(pct || 0);
        item.setText(msg);
        PTLogger.info(`[진행] ${pct}% — ${msg}`);
      },
      setDone(success) {
        if (success) {
          item.setIcon("chrome://zotero/skin/tick.png");
        } else {
          item.setIcon("chrome://zotero/skin/cross.png");
        }
        pw.startCloseTimer(success ? 4000 : 8000);
      },
    };
  }

  // ── 다이얼로그 헬퍼 ───────────────────────────────────────────────────────
  _alert(win, msg) {
    Services.prompt.alert(win, "PaperFlow", msg);
  }

  _confirm(win, msg) {
    return Services.prompt.confirm(win, "PaperFlow", msg);
  }
}
