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
  async runTranslation(win, itemInput = null) {
    PTLogger.info("번역 시작 요청");

    // 1. 선택된 item 확인
    const selectedItem = itemInput || PTItemResolver.getSelectedItem();
    if (!selectedItem) {
      this._alert(win, "번역할 논문을 선택해주세요.");
      return;
    }

    // 2. PDF attachment 식별
    let resolved;
    try {
      resolved = PTItemResolver.resolve(selectedItem);
    } catch (e) {
      this._alert(win, e.message);
      return;
    }

    const { parentItem, pdfAttachment } = resolved;
    const targetItem = parentItem || pdfAttachment;

    // 3. 기존 번역 결과 확인
    let existing = null;
    try {
      existing = await PTStorage.getExistingTranslationBundle(targetItem);
    } catch (e) {
      PTLogger.warn(`기존 번역 확인 실패: ${e.message}`);
    }

    if (existing?.completed) {
      PTLogger.info("[PaperFlow] Existing completed translation found; skipping translation");
      const action = this._promptExistingTranslation(win, existing, true);
      if (action === "open") {
        this._openPanelForParentItem(win, targetItem);
        return;
      }
      if (action !== "retranslate") return;
      PTLogger.info("[PaperFlow] User requested re-translation");
    } else if (existing?.exists) {
      PTLogger.info("[PaperFlow] Existing partial translation found");
      const action = this._promptExistingTranslation(win, existing, false);
      if (action !== "retranslate") return;
      PTLogger.info("[PaperFlow] User requested re-translation");
    }

    // 4. API 키 확인
    const apiKey = PTPrefs.getApiKey();
    if (!apiKey) {
      this._alert(win, "API 키가 설정되지 않았습니다.\nEdit → Preferences → PaperFlow에서 설정해주세요.");
      return;
    }

    // 5. 이미 번역 중이면 중단
    if (PTJobQueue.isRunning()) {
      const cancel = this._confirm(win, "번역이 이미 진행 중입니다. 취소하시겠습니까?");
      if (cancel) PTJobQueue.cancel();
      return;
    }

    const title = targetItem.getField("title") || "제목 없음";

    PTLogger.info(`번역 대상: "${title}"`);

    // 5. progress 창 열기
    const progressWin = this._openProgressWindow(win, title, () => {
      PTJobQueue.cancel();
    });
    const assertNotCancelled = () => {
      if (progressWin.isCancelled()) {
        throw new PTError("번역이 취소되었습니다.", "CANCELLED");
      }
    };

    const startedAt = new Date().toISOString();

    try {
      // Phase 3: 텍스트 추출
      progressWin.update("PDF 텍스트 추출 중...", 0);
      const rawText = await PTExtractor.extract(pdfAttachment);
      assertNotCancelled();

      // Phase 4: 정제
      progressWin.update("텍스트 정제 중...", 5);
      const cleanText = PTCleaner.clean(rawText, {
        skipReferences: PTPrefs.isSkipReferences(),
      });
      assertNotCancelled();

      // Phase 5: 섹션 트리
      progressWin.update("섹션 분석 중...", 10);
      const sections = PTSectionizer.sectionize(cleanText);
      assertNotCancelled();

      // Phase 6: chunking
      progressWin.update("청킹 중...", 15);
      const jobs = PTChunker.buildJobs(sections);
      PTLogger.info(`총 ${jobs.length}개 chunk 생성`);

      progressWin.update(`번역 시작 (총 ${jobs.length}개 chunk)...`, 20);

      // Phase 7~8: queue 번역
      await PTJobQueue.run(jobs, {
        onProgress: (done, total, lastJob, isSectionBoundary) => {
          if (progressWin.isCancelled()) {
            PTJobQueue.cancel();
            return;
          }
          const pct = 20 + Math.floor((done / total) * 75);
          progressWin.update(`번역 중... ${done}/${total}`, pct);
          if (lastJob?.heading) {
            PTLogger.info(`번역 진행: ${done}/${total} — ${lastJob.heading}`);
          }
        },
        onComplete: async (finishedJobs) => {
          assertNotCancelled();
          // Phase 9: 저장
          progressWin.update("저장 중...", 96);
          try {
            await PTStorage.save(targetItem, finishedJobs, {
              title,
              sections,
              startedAt,
              modelName: "gemini-3.1-flash-lite",
            });
          } catch (saveErr) {
            PTLogger.error(`저장 실패 상세: ${this._errorDetail(saveErr)}`);
            progressWin.update(`저장 실패: ${this._shortErrorMessage(saveErr)}`, 100);
            progressWin.setDone(false);
            return;
          }

          try {
            progressWin.update("저장 완료", 100);
            progressWin.setDone(true);
          } catch (progressErr) {
            PTLogger.warn(`Progress UI completion update failed: ${progressErr.message}`);
          }
          PTLogger.info("번역 파이프라인 완료");
        },
        onError: (err) => {
          if (this._isCancelError(err)) {
            PTLogger.info("번역이 사용자 요청으로 취소됨");
            progressWin.update("취소됨", 100);
            progressWin.setDone(false, { cancelled: true });
            return;
          }
          PTLogger.error(`큐 오류: ${err.message}`);
          progressWin.update(`오류: ${err.message}`, 100);
          progressWin.setDone(false);
        },
      });

    } catch (e) {
      if (this._isCancelError(e)) {
        PTLogger.info("번역이 사용자 요청으로 취소됨");
        progressWin.update("취소됨", 100);
        progressWin.setDone(false, { cancelled: true });
        return;
      }
      PTLogger.error(`파이프라인 오류: ${e.message}`);
      progressWin.update(`오류: ${e.message}`, 100);
      progressWin.setDone(false);
    }
  }


  async openTranslationPanel(win) {
    const selectedItem = PTItemResolver.getSelectedItem();
    if (!selectedItem) {
      this._alert(win, "논문 item을 선택하세요.");
      return;
    }

    let parentItem;
    try {
      parentItem = this._resolvePanelParentItem(selectedItem);
    } catch (e) {
      this._alert(win, e.message);
      return;
    }

    this._openPanelForParentItem(win, parentItem);
  }

  _resolvePanelParentItem(item) {
    if (!item) throw new PTError("논문 item을 선택하세요.", "NO_ITEM");

    if (item.isRegularItem && item.isRegularItem()) {
      return item;
    }

    const parentID = item.parentItemID || item.parentID || (item.getSource && item.getSource()) || null;
    if (parentID) {
      const parent = Zotero.Items.get(parentID);
      if (parent && parent.isRegularItem && parent.isRegularItem()) {
        return parent;
      }
    }

    throw new PTError("PaperFlow Panel을 열 parent 논문 item을 찾을 수 없습니다.", "NO_PARENT_ITEM");
  }

  _openPanelForParentItem(win, parentItem) {
    const itemID = parentItem.id;
    const title = (parentItem.getDisplayTitle && parentItem.getDisplayTitle())
      || parentItem.getField("title")
      || "PaperFlow";
    const panelURL = "chrome://paperflow/content/panel.xhtml";
    Zotero.debug("[PaperFlow] Opening panel for item " + itemID);
    Zotero.debug("[PaperFlow] Panel URL: " + panelURL);
    try {
      Services.console.logStringMessage("[PaperFlow] Opening panel for item " + itemID);
      Services.console.logStringMessage("[PaperFlow] Opening panel URL: " + panelURL);
    } catch (_) {}
    const panelWin = win.openDialog(
      panelURL,
      `paper-translator-panel-${itemID}`,
      "chrome,resizable,centerscreen,width=900,height=700",
      { parentItemID: itemID, itemID, title, rootURI: this.rootURI, Zotero }
    );
    if (panelWin) {
      panelWin.addEventListener("load", () => {
        Zotero.debug("[PaperFlow] Panel window load observed by opener");
        try {
          Services.console.logStringMessage("[PaperFlow] Panel window load observed by opener");
        } catch (_) {}
      }, { once: true });
    }
  }

  _promptExistingTranslation(win, existing, completed) {
    if (completed) {
      const msg = "이 논문은 이미 PaperFlow 번역 결과가 있습니다.\n기존 번역본을 열까요, 다시 번역할까요?";
      try {
        const p = Services.prompt;
        const flags = (p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING)
          + (p.BUTTON_POS_1 * p.BUTTON_TITLE_IS_STRING)
          + (p.BUTTON_POS_2 * p.BUTTON_TITLE_IS_STRING);
        const choice = p.confirmEx(
          win,
          "PaperFlow",
          msg,
          flags,
          "Open Panel",
          "Re-translate",
          "Cancel",
          null,
          {}
        );
        if (choice === 0) return "open";
        if (choice === 1) return "retranslate";
        return "cancel";
      } catch (e) {
        PTLogger.warn(`기존 번역 확인 대화상자 실패: ${e.message}`);
        this._alert(win, "이 논문은 이미 PaperFlow 번역 결과가 있습니다.\nTools → Open PaperFlow Panel을 사용하세요.");
        return "cancel";
      }
    }

    const msg = `이 논문에는 미완료 PaperFlow 결과가 있습니다. (status: ${existing?.status || "partial"})\n다시 번역할까요?`;
    try {
      const p = Services.prompt;
      const flags = (p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING)
        + (p.BUTTON_POS_1 * p.BUTTON_TITLE_IS_STRING);
      const choice = p.confirmEx(
        win,
        "PaperFlow",
        msg,
        flags,
        "Re-translate",
        "Cancel",
        null,
        null,
        {}
      );
      return choice === 0 ? "retranslate" : "cancel";
    } catch (e) {
      PTLogger.warn(`미완료 번역 확인 대화상자 실패: ${e.message}`);
      return this._confirm(win, `${msg}`) ? "retranslate" : "cancel";
    }
  }

  // ── Progress 창 ───────────────────────────────────────────────────────────
  _openProgressWindow(win, title, onCancel) {
    // Zotero 내장 ProgressWindow 사용
    const pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("PaperFlow");
    pw.addDescription(`"${title.slice(0, 60)}${title.length > 60 ? "..." : ""}"`);

    const item = new pw.ItemProgress(
      null,
      "준비 중..."
    );
    pw.show();

    let cancelled = false;
    let finished = false;

    const safeCall = (label, fn) => {
      try {
        return fn();
      } catch (e) {
        PTLogger.warn(`Progress UI ${label} failed: ${e.message}`);
        return undefined;
      }
    };

    const styleIndicator = (pct, state) => this._styleProgressIndicator(item, pct, state);

    const requestCancel = (reason) => {
      if (finished || cancelled) return;
      cancelled = true;
      PTLogger.info(`번역 취소 요청: ${reason || "progress-window"}`);
      safeCall("cancel callback", () => {
        if (typeof onCancel === "function") onCancel();
      });
      safeCall("cancel text", () => {
        if (typeof item.setText === "function") {
          item.setText("취소 요청됨... 현재 chunk가 끝나면 중단됩니다.");
        }
      });
      styleIndicator(100, "cancelled");
    };

    this._attachProgressCancelControls(win, requestCancel, () => finished);
    styleIndicator(0, "running");

    return {
      update(msg, pct) {
        const safePct = Number.isFinite(Number(pct)) ? Math.max(0, Math.min(100, Math.round(Number(pct)))) : 0;
        safeCall("setProgress", () => {
          // Zotero's built-in circular progress sprite is visually noisy here.
          // Keep progress as text + a custom static indicator instead.
          styleIndicator(safePct, "running");
        });
        safeCall("setText", () => {
          if (typeof item.setText === "function") {
            item.setText(`${safePct}% · ${msg}`);
          } else {
            PTLogger.warn("Progress UI setText unavailable");
          }
        });
        PTLogger.info(`[진행] ${safePct}% — ${msg}`);
      },
      setDone(success, options = {}) {
        finished = true;
        const state = success ? "success" : (options.cancelled ? "cancelled" : "error");
        safeCall("setDoneStyle", () => {
          if (!success && !options.cancelled && typeof item.setError === "function") {
            item.setError();
          }
          styleIndicator(100, state);
        });
        safeCall("startCloseTimer", () => {
          if (typeof pw.startCloseTimer === "function") {
            pw.startCloseTimer(success ? 4000 : (options.cancelled ? 3500 : 8000));
          } else {
            PTLogger.warn("Progress UI startCloseTimer unavailable");
          }
        });
      },
      isCancelled() {
        return cancelled;
      },
    };
  }

  _styleProgressIndicator(item, pct, state) {
    const image = item && item._image;
    if (!image) return;
    const safePct = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const color = state === "success"
      ? "#05b169"
      : (state === "error" ? "#cf202f" : (state === "cancelled" ? "#7c828a" : "#0052ff"));
    const bg = state === "running"
      ? `linear-gradient(to top, ${color} ${safePct}%, #d7e3ff ${safePct}%)`
      : color;
    image.className = "";
    image.style.width = "8px";
    image.style.height = "18px";
    image.style.minWidth = "8px";
    image.style.marginRight = "8px";
    image.style.borderRadius = "999px";
    image.style.background = bg;
    image.style.backgroundImage = bg;
    image.style.backgroundRepeat = "no-repeat";
    image.style.backgroundSize = "100% 100%";
    image.style.border = "1px solid rgba(0, 82, 255, 0.18)";
    image.style.boxSizing = "border-box";
  }

  _attachProgressCancelControls(win, requestCancel, isFinished) {
    const attach = (triesLeft = 20) => {
      let progressWindow = null;
      try {
        const wins = Services.wm.getEnumerator("alert:alert");
        while (wins.hasMoreElements()) {
          const candidate = wins.getNext();
          if (candidate && candidate.opener === win && candidate.document?.getElementById("zotero-progress")) {
            progressWindow = candidate;
          }
        }
      } catch (_) { /* noop */ }

      if (!progressWindow || !progressWindow.document?.getElementById("zotero-progress-text-box")) {
        if (triesLeft > 0) {
          win.setTimeout(() => attach(triesLeft - 1), 100);
        }
        return;
      }

      const doc = progressWindow.document;
      const box = doc.getElementById("zotero-progress-text-box");
      if (!box || doc.getElementById("paperflow-progress-cancel")) return;

      try {
        progressWindow.addEventListener("close", () => {
          if (!isFinished()) requestCancel("window-close");
        }, { once: true });
        progressWindow.addEventListener("unload", () => {
          if (!isFinished()) requestCancel("window-unload");
        }, { once: true });
      } catch (_) { /* noop */ }

      try {
        const row = doc.createXULElement("hbox");
        row.setAttribute("class", "zotero-progress-item-hbox");
        row.setAttribute("align", "center");
        row.style.marginTop = "6px";

        const spacer = doc.createXULElement("spacer");
        spacer.setAttribute("flex", "1");

        const cancelButton = doc.createXULElement("button");
        cancelButton.id = "paperflow-progress-cancel";
        cancelButton.setAttribute("label", "× Cancel");
        cancelButton.setAttribute("tooltiptext", "PaperFlow 번역을 취소합니다.");
        cancelButton.style.minHeight = "24px";
        cancelButton.style.padding = "2px 10px";
        cancelButton.addEventListener("command", () => requestCancel("cancel-button"));

        row.appendChild(spacer);
        row.appendChild(cancelButton);
        box.appendChild(row);
        progressWindow.sizeToContent();
      } catch (e) {
        PTLogger.warn(`Progress cancel control attach failed: ${e.message}`);
      }
    };

    try {
      win.setTimeout(() => attach(), 0);
    } catch (_) {
      attach();
    }
  }

  _shortErrorMessage(err) {
    const msg = err?.message || "알 수 없는 오류";
    return msg.length > 100 ? `${msg.slice(0, 97)}...` : msg;
  }

  _isCancelError(err) {
    return err?.code === "CANCELLED"
      || /취소/.test(err?.message || "")
      || /cancel/i.test(err?.message || "");
  }

  _errorDetail(err) {
    const parts = [];
    if (err?.stack) parts.push(err.stack);
    else if (err?.message) parts.push(err.message);
    else parts.push(String(err));
    if (err?.cause) {
      parts.push(`Cause: ${err.cause.stack || err.cause.message || String(err.cause)}`);
    }
    return parts.join("\n");
  }

  // ── 다이얼로그 헬퍼 ───────────────────────────────────────────────────────
  _alert(win, msg) {
    Services.prompt.alert(win, "PaperFlow", msg);
  }

  _confirm(win, msg) {
    return Services.prompt.confirm(win, "PaperFlow", msg);
  }
}
