"use strict";

// PaperFlow Reader Sidebar - clean, production-ready version.
var PaperFlowReaderSidebar = {
  PANE_ID: "paperflow-reader",
  PLUGIN_ID: "paperflow@06-month",
  HEADER_ICON: "chrome://paperflow/content/icons/paperflow-sidebar-gray-24.png",
  SIDENAV_ICON: "chrome://paperflow/content/icons/paperflow-sidebar-gray-24.png",
  SECTION_BUTTON_ICON: "chrome://paperflow/content/icons/paperflow-sidebar-gray-24.png",
  STYLESHEET_URI: "chrome://paperflow/content/readerSidebar.css",
  XHTML_NS: "http://www.w3.org/1999/xhtml",
  DEFAULT_SIDENAV_ORDER: [
    "info",
    "abstract",
    "attachments",
    "notes",
    "libraries-collections",
    "tags",
    "related",
  ],

  // custom element는 한 번 정의하면 재정의가 불가능하므로, 플러그인 업데이트 후
  // 구버전 클래스가 계속 쓰이지 않도록 태그 이름에 버전을 포함시킨다
  get ELEMENT_NAME() {
    const ver = (typeof PTConstants !== "undefined" && PTConstants.VERSION)
      ? PTConstants.VERSION
      : "0";
    return `paperflow-reader-panel-v${ver.replace(/[^0-9a-z]/gi, "-")}`;
  },

  get BODY_XHTML() {
    return `<${this.ELEMENT_NAME} xmlns="${this.XHTML_NS}" />`;
  },

  _registeredPaneID: null,
  _styleSheetRegistered: false,
  _selectionListener: null,
  _activePanels: new Set(), // 현재 연결된 panel element들 (PDF 드래그 전달용)
  _pdfPopupMarker: null,    // 리더 선택 팝업 생존 감지용 마커 (팝업이 사라지면 선택 해제로 간주)
  _pdfMarkerTimer: null,
  _loggedInitProps: false,
  _loggedDestroyProps: false,
  _loggedItemChangeProps: false,
  _loggedRenderProps: false,
  _renderBodySeq: 0,
  _panelRefreshByUID: new Map(),

  // ── 등록 ────────────────────────────────────────────────────────────────
  install() {
    this._clog("readerSidebar install called");
    if (this._registeredPaneID) {
      this._log("reader section already registered — skip");
      return;
    }
    const manager = (typeof Zotero !== "undefined") ? Zotero.ItemPaneManager : null;
    if (!manager || typeof manager.registerSection !== "function") {
      this._warn("Zotero.ItemPaneManager.registerSection unavailable — reader sidebar skipped");
      return;
    }

    this._injectFTL();
    this._registerStyleSheet();
    this._ensureReaderPanelElement();

    try {
      const sectionDefinition = {
        paneID: this.PANE_ID,
        pluginID: this.PLUGIN_ID,
        header: { l10nID: "paperflow-pane-header", icon: this.HEADER_ICON },
        sidenav: { l10nID: "paperflow-pane-sidenav", icon: this.SIDENAV_ICON, orderable: false },
        bodyXHTML: this.BODY_XHTML,
        onInit: (props) => this._onInit(props),
        onDestroy: (props) => this._onDestroy(props),
        onItemChange: (props) => this._onItemChange(props),
        onRender: (props) => this._onRender(props),
        onToggle: (props) => this._onToggle(props),
      };
      const paneID = manager.registerSection(sectionDefinition);
      this._registeredPaneID = paneID || this.PANE_ID;
      this._clog(`registerSection returned: ${this._registeredPaneID}`);
      this._ensureOpenPref(this._registeredPaneID);
      this._ensureSidenavOrder();
      this._registerReaderSelectionListener();
    } catch (e) {
      this._reportError("registerSection failed", e);
    }
  },

  // ── 해제 ────────────────────────────────────────────────────────────────
  remove() {
    this._unregisterStyleSheet();
    this._unregisterReaderSelectionListener();
    this._stopPdfMarkerWatch();
    this._activePanels.clear();
    if (!this._registeredPaneID) return;
    try {
      const manager = (typeof Zotero !== "undefined") ? Zotero.ItemPaneManager : null;
      if (manager && typeof manager.unregisterSection === "function") {
        manager.unregisterSection(this._registeredPaneID);
        this._log(`reader section unregistered: ${this._registeredPaneID}`);
      }
    } catch (e) {
      this._warn(`unregisterSection failed (auto-removal will handle it): ${e.message}`);
    } finally {
      this._registeredPaneID = null;
      this._panelRefreshByUID.clear();
    }
  },

  _ensureReaderPanelElement(docOrWin) {
    try {
      let win = null;
      if (docOrWin && docOrWin.defaultView) {
        win = docOrWin.defaultView;
      } else if (docOrWin && docOrWin.customElements) {
        win = docOrWin;
      } else if (typeof Zotero !== "undefined" && Zotero.getMainWindow) {
        win = Zotero.getMainWindow();
      }
      if (!win || !win.customElements || !win.HTMLElement) {
        this._clog(`${this.ELEMENT_NAME} define skipped: customElements unavailable`);
        return false;
      }
      if (win.customElements.get(this.ELEMENT_NAME)) {
        return true;
      }

      const xhtmlNS = this.XHTML_NS;
      const PanelElement = class extends win.HTMLElement {
        constructor() {
          super();
          this._item = null;
          this._rendered = false;
          this._loadSeq = 0;
          this._bundle = null;
          this._activeTab = "summary";
          this._chatSending = false;
          this._composing = false; // IME 조합 진행 여부
          this._hintTimer = null;  // 추천 질문 회전 타이머
          this._hintIndex = 0;
          this._chatHistory = []; // [{ role, text }] — 멀티턴 대화용
          // [{ id, kind, source, label, text?, mimeType?, data?, sizeBytes?, truncated }]
          // kind: "selection" | "file" (텍스트) | "image" | "media-pdf" (base64)
          this._pendingAttachments = [];
          this._attachmentSeq = 0;
          this._onHostResize = null;
          this._lastHostHeight = 0;
          this._lastHostMaxHeight = 0;
          this._lastChatHeight = 0;
          this._lastViewportHeight = 0;
          this._lastHostTop = null;
          this._lastSectionOpenHeight = 0;
          this._layoutMode = "split";
        }

        set item(val) {
          this._item = val;
          this._updateItemUI();
        }

        get item() {
          return this._item;
        }

        connectedCallback() {
          PaperFlowReaderSidebar._activePanels.add(this);
          this._wireSelectionWatch();
          if (this._rendered) {
            this._wireHostResize();
            this._applyLayoutSizing();
            this._updateItemUI();
            // 분리됐다 다시 붙은 경우 회전 타이머를 되살린다 (재진입 안전).
            this._startComposerHint();
            return;
          }
          this._render();
          this._wireResize();
          this._updateItemUI();
          this._rendered = true;
          this._applyLayoutSizing();
          this._wireHostResize();
          try {
            const w = this.ownerDocument && this.ownerDocument.defaultView;
            if (w && typeof w.requestAnimationFrame === "function") {
              w.requestAnimationFrame(() => this._applyLayoutSizing());
            }
          } catch (_) { /* noop */ }
        }

        disconnectedCallback() {
          PaperFlowReaderSidebar._activePanels.delete(this);
          try {
            if (this._onSelectionChange) {
              this.ownerDocument.removeEventListener("selectionchange", this._onSelectionChange);
              this._onSelectionChange = null;
            }
          } catch (_) { /* noop */ }
          try {
            const w = this.ownerDocument && this.ownerDocument.defaultView;
            if (w && this._onHostResize) {
              w.removeEventListener("resize", this._onHostResize);
              this._onHostResize = null;
            }
          } catch (_) { /* noop */ }
          this._stopComposerHint();
        }

        // 드래그가 해제되면(다른 곳 클릭 등) 해당 드래그 첨부도 자동 제거
        _wireSelectionWatch() {
          try {
            if (this._onSelectionChange) return;
            this._onSelectionChange = () => this._handleSelectionChange();
            this.ownerDocument.addEventListener("selectionchange", this._onSelectionChange);
          } catch (_) { /* noop */ }
        }

        _handleSelectionChange() {
          try {
            const hasViewSelection = this._pendingAttachments.some(
              a => a.kind === "selection" && (a.source === "summary" || a.source === "translation")
            );
            if (!hasViewSelection) return;

            const win = this.ownerDocument && this.ownerDocument.defaultView;
            const sel = win && win.getSelection ? win.getSelection() : null;
            const text = sel ? String(sel).trim() : "";

            // 콘텐츠 영역 안에 유효한 선택이 남아 있으면 유지
            if (text.length >= 2
              && sel.anchorNode
              && this._contentArea
              && this._contentArea.contains(sel.anchorNode)) {
              return;
            }

            // 질문을 입력하러 채팅 영역을 클릭한 경우는 해제로 보지 않는다
            const active = this.ownerDocument.activeElement;
            if (active && this._chatSection && this._chatSection.contains(active)) return;

            this.removeSelectionAttachment("summary");
            this.removeSelectionAttachment("translation");
          } catch (_) { /* noop */ }
        }

        removeSelectionAttachment(source) {
          const before = this._pendingAttachments.length;
          this._pendingAttachments = this._pendingAttachments.filter(
            a => !(a.kind === "selection" && a.source === source)
          );
          if (this._pendingAttachments.length !== before) this._renderAttachmentChips();
        }

        // PDF 리더 드래그를 이 panel이 받아야 하는지 판정
        matchesParentItemID(parentItemID) {
          try {
            if (!this._item || parentItemID == null) return false;
            const parent = PaperFlowReaderSidebar._resolveParentItem(this._item) || this._item;
            return Boolean(parent && parent.id === parentItemID);
          } catch (_) {
            return false;
          }
        }

        _wireHostResize() {
          try {
            const win = this.ownerDocument && this.ownerDocument.defaultView;
            if (!win) return;
            if (!this._onHostResize) {
              this._onHostResize = () => this._applyLayoutSizing({ onlyVerticalChange: true });
              win.addEventListener("resize", this._onHostResize);
            }
          } catch (_) { /* noop */ }
        }

        _applyLayoutSizing(options = {}) {
          const changed = this._applyHostHeight(options);
          if (changed) this._clampChatHeight();
        }

        _applyHostHeight(options = {}) {
          try {
            const win = this.ownerDocument && this.ownerDocument.defaultView;
            if (!win) return false;
            const rect = this.getBoundingClientRect();
            const viewportHeight = win.innerHeight || 800;
            const top = Math.round(rect.top || 0);

            if (options.onlyVerticalChange) {
              const viewportDelta = Math.abs(viewportHeight - (this._lastViewportHeight || 0));
              const topDelta = this._lastHostTop == null ? 0 : Math.abs(top - this._lastHostTop);
              if (viewportDelta < 2 && topDelta < 2) return false;
            }

            const bottomPadding = 32;
            const available = viewportHeight - rect.top - bottomPadding;

            const minHeight = 560;
            const safeAvailable = Number.isFinite(available) && available > 0 ? available : 800;
            const maxHeight = this._getMaxHostHeight(minHeight, safeAvailable);
            const savedHeight = this._getSavedHostHeight();
            const target = savedHeight || Math.floor(safeAvailable * 0.92);
            const height = Math.max(minHeight, Math.min(target, maxHeight));

            const hostChanged = height !== this._lastHostHeight || maxHeight !== this._lastHostMaxHeight;
            if (hostChanged) {
              this.style.height = `${height}px`;
              this.style.maxHeight = `${maxHeight}px`;
              this.style.minHeight = `${minHeight}px`;
              this._lastHostHeight = height;
              this._lastHostMaxHeight = maxHeight;
              this._lastViewportHeight = viewportHeight;
              this._lastHostTop = top;
              this.style.overflow = "hidden";
            }
            const sectionChanged = this._syncZoteroSectionHeight(height);
            if (hostChanged || sectionChanged) return true;
            this._lastViewportHeight = viewportHeight;
            this._lastHostTop = top;
            this.style.overflow = "hidden";
            return false;
          } catch (_) {
            return false;
          }
        }

        _getMaxHostHeight(minHeight = 560, fallbackAvailable = 900) {
          try {
            const win = this.ownerDocument && this.ownerDocument.defaultView;
            const rect = this.getBoundingClientRect();
            const available = win ? (win.innerHeight || fallbackAvailable) - rect.top - 12 : fallbackAvailable;
            return Math.max(minHeight, Math.min(Math.floor(available), 1200));
          } catch (_) {
            return Math.max(minHeight, Math.min(Math.floor(fallbackAvailable || 900), 1200));
          }
        }

        _getSavedHostHeight() {
          try {
            const saved = parseInt(localStorage.getItem("paperflow-host-height-v1"), 10);
            return Number.isInteger(saved) && saved >= 560 ? saved : null;
          } catch (_) {
            return null;
          }
        }

        _applyManualHostHeight(height) {
          try {
            const minHeight = 560;
            const maxHeight = this._getMaxHostHeight(minHeight, 900);
            const nextHeight = Math.max(minHeight, Math.min(Math.round(Number(height) || minHeight), maxHeight));
            this.style.height = `${nextHeight}px`;
            this.style.maxHeight = `${maxHeight}px`;
            this.style.minHeight = `${minHeight}px`;
            this.style.overflow = "hidden";
            this._lastHostHeight = nextHeight;
            this._lastHostMaxHeight = maxHeight;
            this._syncZoteroSectionHeight(nextHeight);
            this._clampChatHeight();
            try {
              localStorage.setItem("paperflow-host-height-v1", String(nextHeight));
            } catch (_) { /* noop */ }
          } catch (_) {
            /* noop */
          }
        }

        _syncZoteroSectionHeight(height) {
          try {
            const targetHeight = Math.max(560, Math.round(Number(height) || 0));
            if (!targetHeight) return false;

            const body = this.closest && this.closest('[data-type="body"]');
            const section = body && body.closest ? body.closest("collapsible-section") : null;
            if (!body || !section) return false;

            let changed = false;
            const heightPx = `${targetHeight}px`;

            if (body.style.height !== heightPx) {
              body.style.height = heightPx;
              body.style.minHeight = heightPx;
              body.style.overflow = "hidden";
              changed = true;
            }

            const openHeight = Math.max(targetHeight, Math.ceil(body.scrollHeight || 0));
            const openHeightPx = `${openHeight}px`;
            if (section.style.getPropertyValue("--open-height") !== openHeightPx) {
              section.style.setProperty("--open-height", openHeightPx);
              this._lastSectionOpenHeight = openHeight;
              changed = true;
            }

            return changed;
          } catch (_) {
            return false;
          }
        }

        _clampChatHeight() {
          try {
            if (this._layoutMode !== "split") return;
            const root = this.querySelector("#pt-root");
            if (!root) return;
            const hostHeight = this.getBoundingClientRect().height || 700;
            // 컴포저/첨부가 요구하는 높이를 최소값으로 삼는다. 늘어난 만큼은
            // 위쪽 본문 pane에서 가져오므로 아래쪽 박스 경계는 그대로다.
            const hardCap = Math.max(160, Math.floor(hostHeight - 40));
            const minChat = Math.min(Math.max(160, this._minChatHeight()), hardCap);
            const maxChat = Math.max(minChat, this._getMaxChatHeight(hostHeight, minChat));
            const defaultChat = Math.floor(hostHeight * 0.24);
            let saved = null;
            try {
              saved = parseInt(localStorage.getItem("paperflow-chat-height-v2"), 10);
            } catch (_) { /* noop */ }
            const raw = Number.isInteger(saved) ? saved : defaultChat;
            const chatHeight = Math.max(minChat, Math.min(raw, maxChat));
            // height와 min-height를 함께 내려 flex 재분배에 기대지 않도록 한다.
            root.style.setProperty("--paperflow-chat-min", `${minChat}px`);
            if (chatHeight !== this._lastChatHeight) {
              root.style.setProperty("--paperflow-chat-height", `${chatHeight}px`);
              this._lastChatHeight = chatHeight;
            }
          } catch (_) {
            /* noop */
          }
        }

        _render() {
          const doc = this.ownerDocument;

          // Root
          const root = doc.createElementNS(xhtmlNS, "div");
          root.setAttribute("id", "pt-root");

          // Header
          const header = doc.createElementNS(xhtmlNS, "header");
          header.setAttribute("id", "pt-header");

          const brandRow = doc.createElementNS(xhtmlNS, "div");
          brandRow.setAttribute("id", "pt-brandrow");

          const brandTitle = doc.createElementNS(xhtmlNS, "span");
          brandTitle.setAttribute("id", "pt-brand");
          brandTitle.textContent = "PaperFlow";

          const statusChip = doc.createElementNS(xhtmlNS, "span");
          statusChip.setAttribute("id", "pt-status-chip");
          statusChip.setAttribute("class", "pt-chip pt-chip-missing");
          statusChip.textContent = "missing";
          this._statusChip = statusChip;

          const chunkProgress = doc.createElementNS(xhtmlNS, "span");
          chunkProgress.setAttribute("id", "pt-chunk-progress");
          chunkProgress.setAttribute("class", "pt-chunk");
          this._chunkProgress = chunkProgress;

          brandRow.appendChild(brandTitle);
          brandRow.appendChild(statusChip);
          brandRow.appendChild(chunkProgress);

          const paperTitle = doc.createElementNS(xhtmlNS, "h1");
          paperTitle.setAttribute("id", "pt-paper-title");
          paperTitle.textContent = "PaperFlow";
          this._paperTitle = paperTitle;

          const statusLine = doc.createElementNS(xhtmlNS, "p");
          statusLine.setAttribute("id", "pt-status");
          statusLine.setAttribute("class", "pt-status-line");
          statusLine.textContent = "Panel loaded. Initializing...";
          this._statusLine = statusLine;

          header.appendChild(brandRow);
          header.appendChild(paperTitle);
          header.appendChild(statusLine);
          root.appendChild(header);

          // Tabs Navigation
          const tabsNav = doc.createElementNS(xhtmlNS, "nav");
          tabsNav.setAttribute("id", "pt-tabs");
          tabsNav.setAttribute("aria-label", "PaperFlow views");

          const tabSummary = doc.createElementNS(xhtmlNS, "button");
          tabSummary.setAttribute("id", "pt-tab-summary");
          tabSummary.setAttribute("type", "button");
          tabSummary.setAttribute("class", "pt-tab pt-tab-active");
          tabSummary.textContent = "Summary";
          this._tabSummary = tabSummary;

          const tabTranslation = doc.createElementNS(xhtmlNS, "button");
          tabTranslation.setAttribute("id", "pt-tab-translation");
          tabTranslation.setAttribute("type", "button");
          tabTranslation.setAttribute("class", "pt-tab");
          tabTranslation.textContent = "Translation";
          this._tabTranslation = tabTranslation;

          const tabMeta = doc.createElementNS(xhtmlNS, "button");
          tabMeta.setAttribute("id", "pt-tab-meta");
          tabMeta.setAttribute("type", "button");
          tabMeta.setAttribute("class", "pt-tab");
          tabMeta.textContent = "Meta";
          this._tabMeta = tabMeta;

          tabsNav.appendChild(tabSummary);
          tabsNav.appendChild(tabTranslation);
          tabsNav.appendChild(tabMeta);
          root.appendChild(tabsNav);

          // Main Workspace Area
          const mainArea = doc.createElementNS(xhtmlNS, "div");
          mainArea.setAttribute("id", "pt-main");

          // Main Content Area
          const contentArea = doc.createElementNS(xhtmlNS, "main");
          contentArea.setAttribute("id", "pt-content");
          contentArea.setAttribute("class", "pt-text-view");
          contentArea.textContent = "Loading...";
          this._contentArea = contentArea;
          mainArea.appendChild(contentArea);

          // Resizable Divider
          const divider = doc.createElementNS(xhtmlNS, "div");
          divider.setAttribute("id", "pt-divider");
          divider.setAttribute("class", "pt-divider");
          mainArea.appendChild(divider);

          // Chat Section
          const chatSection = doc.createElementNS(xhtmlNS, "section");
          chatSection.setAttribute("id", "pt-chat");
          chatSection.setAttribute("aria-label", "Gemini Chat");

          const chatLog = doc.createElementNS(xhtmlNS, "div");
          chatLog.setAttribute("id", "pt-chat-log");
          this._chatLog = chatLog;

          // 드래그/파일 첨부 칩 영역 (입력창 바로 위)
          const chatAttachments = doc.createElementNS(xhtmlNS, "div");
          chatAttachments.setAttribute("id", "pt-chat-attachments");
          this._chatAttachmentsEl = chatAttachments;

          const chatComposer = doc.createElementNS(xhtmlNS, "div");
          chatComposer.setAttribute("id", "pt-chat-composer");
          chatComposer.setAttribute("class", "pt-chat-composer");

          const chatInput = doc.createElementNS(xhtmlNS, "textarea");
          chatInput.setAttribute("id", "pt-chat-input");
          chatInput.setAttribute("rows", "1");
          chatInput.setAttribute("placeholder", "무엇이든 질문하세요.");
          chatInput.setAttribute("aria-label", "무엇이든 질문하세요.");
          this._chatInput = chatInput;

          // 추천 질문이 천천히 교차되는 오버레이 (textarea 첫 줄 위에 겹침)
          const composerHint = doc.createElementNS(xhtmlNS, "div");
          composerHint.setAttribute("id", "pt-composer-hint");
          composerHint.setAttribute("class", "pt-composer-hint");
          composerHint.setAttribute("aria-hidden", "true");
          this._composerHint = composerHint;

          const composerActions = doc.createElementNS(xhtmlNS, "div");
          composerActions.setAttribute("class", "pt-composer-actions");

          const composerTools = doc.createElementNS(xhtmlNS, "div");
          composerTools.setAttribute("class", "pt-composer-tools");

          const chatAttach = doc.createElementNS(xhtmlNS, "button");
          chatAttach.setAttribute("id", "pt-chat-attach");
          chatAttach.setAttribute("type", "button");
          chatAttach.setAttribute("class", "pt-icon-btn");
          chatAttach.setAttribute("title", "내 컴퓨터에서 파일을 선택해 대화에 첨부합니다.");
          chatAttach.setAttribute("aria-label", "내 컴퓨터에서 파일을 선택해 대화에 첨부합니다.");
          chatAttach.textContent = "+";
          this._chatAttach = chatAttach;
          composerTools.appendChild(chatAttach);

          const chatSend = doc.createElementNS(xhtmlNS, "button");
          chatSend.setAttribute("id", "pt-chat-send");
          chatSend.setAttribute("type", "button");
          chatSend.setAttribute("class", "pt-send-btn");
          chatSend.setAttribute("title", "Send");
          chatSend.setAttribute("aria-label", "Send");
          chatSend.textContent = "↑";
          this._chatSend = chatSend;

          composerActions.appendChild(composerTools);
          composerActions.appendChild(chatSend);

          chatComposer.appendChild(chatInput);
          chatComposer.appendChild(composerHint);
          chatComposer.appendChild(composerActions);

          chatSection.appendChild(chatLog);
          chatSection.appendChild(chatAttachments);
          chatSection.appendChild(chatComposer);
          this._chatSection = chatSection;
          this._chatComposer = chatComposer;
          mainArea.appendChild(chatSection);

          root.appendChild(mainArea);
          this.appendChild(root);

          // Wire Tabs Event Listeners
          tabSummary.addEventListener("click", () => {
            this._activeTab = "summary";
            this._setActiveTabUI("summary");
            this._renderActiveTabContent();
          });
          tabTranslation.addEventListener("click", () => {
            this._activeTab = "translation";
            this._setActiveTabUI("translation");
            this._renderActiveTabContent();
          });
          tabMeta.addEventListener("click", () => {
            this._activeTab = "meta";
            this._setActiveTabUI("meta");
            this._renderActiveTabContent();
          });

          // Summary/Translation 뷰에서 드래그한 텍스트를 자동 첨부
          contentArea.addEventListener("mouseup", () => {
            const w = this.ownerDocument && this.ownerDocument.defaultView;
            // 선택이 확정된 다음 tick에 읽는다
            if (w) w.setTimeout(() => this._captureContentSelection(), 0);
          });

          // Wire Chat Event Listeners
          chatAttach.addEventListener("click", () => this._openFilePicker());
          chatSend.addEventListener("click", () => this._ask());
          // 클립보드 이미지 붙여넣기 (⌘V / Ctrl+V) → 이미지 첨부
          chatInput.addEventListener("paste", (e) => this._handlePaste(e));
          chatInput.addEventListener("keydown", (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              this._ask();
            }
          });
          // 조합 상태를 직접 추적한다. 전송 버튼 클릭처럼 keydown을 거치지 않는
          // 경로에서도 조합을 확정한 뒤 값을 읽어야 잔여 글자가 남지 않는다.
          chatInput.addEventListener("compositionstart", () => { this._composing = true; });
          chatInput.addEventListener("compositionend", () => { this._composing = false; });
          chatInput.addEventListener("input", () => {
            this._autoGrowInput();
            this._syncComposerHint();
          });
          this._autoGrowInput();
          this._startComposerHint();
        }

        // 입력 줄 수에 맞춰 textarea를 키운다. 컴포저는 chat pane 아래쪽에
        // 고정돼 있으므로 높이가 늘면 윗변이 위로 올라간다.
        _autoGrowInput() {
          const input = this._chatInput;
          const win = this.ownerDocument && this.ownerDocument.defaultView;
          if (!input || !win) return;
          const limit = parseFloat(win.getComputedStyle(input).maxHeight);
          const max = Number.isFinite(limit) ? limit : 132;
          input.style.height = "auto";
          const next = Math.min(input.scrollHeight, max);
          input.style.height = `${next}px`;
          input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
          this._clampChatHeight();
        }

        // 첨부 칩과 컴포저가 실제로 요구하는 chat pane 높이. divider를 아무리
        // 내려도 이 값 밑으로는 내려가지 않아야 입력창 아래쪽이 잘리지 않는다.
        _minChatHeight() {
          const win = this.ownerDocument && this.ownerDocument.defaultView;
          const chat = this.querySelector("#pt-chat");
          const composer = this._chatComposer;
          // pane이 숨겨져 있으면(content-only) 실측이 0이라 의미가 없다.
          if (!win || !chat || !composer || !composer.offsetHeight) return 0;
          const px = value => {
            const n = parseFloat(value);
            return Number.isFinite(n) ? n : 0;
          };
          const styles = win.getComputedStyle(chat);
          const frame = px(styles.paddingTop) + px(styles.paddingBottom)
            + px(styles.borderTopWidth) + px(styles.borderBottomWidth);
          const gap = px(styles.rowGap);
          const attachments = this._chatAttachmentsEl;
          const attachHeight = attachments && attachments.offsetHeight
            ? attachments.offsetHeight + gap
            : 0;
          const LOG_FLOOR = 28; // 답변 한 줄은 항상 남겨 둔다
          return Math.ceil(frame + gap + LOG_FLOOR + attachHeight + composer.offsetHeight);
        }

        // 열려 있는 IME 조합을 확정한다. blur가 조합을 즉시 커밋하므로 이후에
        // 읽는 value에는 마지막 음절까지 포함되고, 되돌아오는 잔여 글자도 없다.
        _commitComposition() {
          if (!this._composing || !this._chatInput) return;
          const refocus = this.ownerDocument.activeElement === this._chatInput;
          this._chatInput.blur();
          this._composing = false;
          if (refocus) this._chatInput.focus();
        }

        // 전송 후 입력창 초기화. IME 조합이 열린 채로 비우면 조합 중이던 음절이
        // 뒤늦게 커밋되어 한 글자가 남으므로 조합 종료 시 한 번 더 비운다.
        _clearComposer() {
          const input = this._chatInput;
          if (!input) return;
          const clear = () => {
            input.value = "";
            this._autoGrowInput();
            this._syncComposerHint();
          };
          clear();
          if (this._composing) {
            input.addEventListener("compositionend", () => clear(), { once: true });
          }
        }

        _composerSuggestions() {
          const list = typeof PTConstants !== "undefined" ? PTConstants.CHAT_SUGGESTIONS : null;
          return Array.isArray(list) && list.length ? list : [];
        }

        // 입력 중이거나 채팅이 비활성화된 동안에는 추천 문구를 감춘다.
        // 타이핑이 시작되면 페이드 없이 즉시 사라져야 하므로 별도 클래스를 쓴다.
        _syncComposerHint() {
          const hint = this._composerHint;
          const input = this._chatInput;
          if (!hint || !input) return;
          hint.classList.toggle("pt-hint-off", !!input.value);
          const show = this._hintTimer !== null && !input.disabled && !input.value;
          hint.classList.toggle("pt-hint-visible", show && !!hint.textContent);
        }

        _startComposerHint() {
          const hint = this._composerHint;
          const input = this._chatInput;
          const win = this.ownerDocument && this.ownerDocument.defaultView;
          const suggestions = this._composerSuggestions();
          if (!hint || !input || !win || !suggestions.length || this._hintTimer !== null) return;

          // 회전 문구가 실제로 동작할 때만 기본 placeholder를 넘겨받는다.
          input.placeholder = "";
          this._hintIndex = Math.floor(Math.random() * suggestions.length);
          hint.textContent = suggestions[this._hintIndex];

          const VISIBLE_MS = 4500;
          const FADE_MS = 500;
          this._hintTimer = win.setInterval(() => {
            const list = this._composerSuggestions();
            if (!list.length) return;
            hint.classList.remove("pt-hint-visible");
            win.setTimeout(() => {
              this._hintIndex = (this._hintIndex + 1) % list.length;
              hint.textContent = list[this._hintIndex];
              this._syncComposerHint();
            }, FADE_MS);
          }, VISIBLE_MS + FADE_MS);
          this._syncComposerHint();
        }

        _stopComposerHint() {
          if (this._hintTimer === null) return;
          try {
            const win = this.ownerDocument && this.ownerDocument.defaultView;
            if (win) win.clearInterval(this._hintTimer);
          } catch (_) { /* noop */ }
          this._hintTimer = null;
          if (this._composerHint) this._composerHint.classList.remove("pt-hint-visible");
        }

        _wireResize() {
          const divider = this.querySelector("#pt-divider");
          const chat = this.querySelector("#pt-chat");
          const rootEl = this.querySelector("#pt-root");
          const workspace = this.querySelector("#pt-main");
          if (!divider || !chat || !rootEl || !workspace) return;

          let isDragging = false;
          let isHostDragging = false;
          let startY = 0;
          let startHeight = 0;
          let startHostY = 0;
          let startHostHeight = 0;
          // 드래그 한 번 동안 고정되는 바닥값. content-only로 스냅되면 chat pane이
          // display:none이 되어 실측값이 0으로 떨어지는데, 그 값으로 임계점을 다시
          // 계산하면 같은 마우스 위치가 split 조건을 만족해 무한 토글(깜빡임)이 된다.
          let dragFloor = 0;
          const snapOvershoot = 56;
          const chatFloor = () => Math.max(160, this._minChatHeight());

          const isNearChatBottom = (e) => {
            const rect = chat.getBoundingClientRect();
            return rect && rect.bottom - e.clientY <= 12;
          };

          const onMouseDown = (e) => {
            isDragging = true;
            startY = e.clientY;
            startHeight = chat.offsetHeight;
            dragFloor = chatFloor();
            this.ownerDocument.body.style.userSelect = "none";
            divider.classList.add("pt-dragging");
            e.preventDefault();
          };

          const onMouseMove = (e) => {
            if (isHostDragging) {
              const dy = e.clientY - startHostY;
              this._applyManualHostHeight(startHostHeight + dy);
              return;
            }
            if (!isDragging) return;
            const dy = startY - e.clientY;
            let newHeight = startHeight + dy;

            const parentHeight = workspace.offsetHeight || rootEl.offsetHeight || 520;
            const minHeight = dragFloor || chatFloor();
            const maxHeight = Math.max(minHeight, this._getMaxChatHeight(parentHeight, minHeight));

            // 최소/최대 크기를 56px 이상 넘겨 끌면 한쪽 pane으로 스냅한다.
            if (newHeight <= minHeight - snapOvershoot) {
              this._setLayoutMode("content-only");
              return;
            }
            if (newHeight >= maxHeight + snapOvershoot) {
              this._setLayoutMode("chat-only");
              return;
            }

            this._setLayoutMode("split");

            newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));
            rootEl.style.setProperty('--paperflow-chat-height', newHeight + "px");
            this._lastChatHeight = newHeight;

            try {
              localStorage.setItem("paperflow-chat-height-v2", String(newHeight));
            } catch (_) { }
          };

          const onMouseUp = () => {
            if (isHostDragging) {
              isHostDragging = false;
              this.ownerDocument.body.style.userSelect = "";
              chat.classList.remove("pt-host-resizing");
            }
            if (!isDragging) return;
            isDragging = false;
            dragFloor = 0;
            this.ownerDocument.body.style.userSelect = "";
            divider.classList.remove("pt-dragging");
          };

          divider.addEventListener("mousedown", onMouseDown);
          divider.setAttribute("title", "끝까지 드래그하면 본문 또는 채팅만 표시합니다.");
          chat.addEventListener("mousemove", (e) => {
            if (isDragging || isHostDragging) return;
            chat.classList.toggle("pt-host-resize-hover", isNearChatBottom(e));
          });
          chat.addEventListener("mouseleave", () => {
            if (!isHostDragging) chat.classList.remove("pt-host-resize-hover");
          });
          chat.addEventListener("mousedown", (e) => {
            if (!isNearChatBottom(e)) return;
            isHostDragging = true;
            startHostY = e.clientY;
            startHostHeight = this.getBoundingClientRect().height || rootEl.offsetHeight || 560;
            this.ownerDocument.body.style.userSelect = "none";
            chat.classList.add("pt-host-resizing");
            e.preventDefault();
            e.stopPropagation();
          });
          this.ownerDocument.defaultView.addEventListener("mousemove", onMouseMove);
          this.ownerDocument.defaultView.addEventListener("mouseup", onMouseUp);

          // Restore saved height
          try {
            const savedHeight = localStorage.getItem("paperflow-chat-height-v2");
            const h = savedHeight ? parseInt(savedHeight, 10) : NaN;
            if (Number.isInteger(h) && h >= 160) {
              const parentHeight = workspace.offsetHeight || rootEl.offsetHeight || 520;
              const floor = chatFloor();
              const max = Math.max(floor, this._getMaxChatHeight(parentHeight, floor));
              const clamped = Math.max(floor, Math.min(h, max));
              rootEl.style.setProperty('--paperflow-chat-height', clamped + "px");
              this._lastChatHeight = clamped;
            } else {
              this._clampChatHeight();
            }
          } catch (_) {
            this._clampChatHeight();
          }

          this._restoreLayoutMode();
        }

        _getMaxChatHeight(containerHeight, minHeight = 160) {
          const height = Math.max(minHeight, Math.floor(Number(containerHeight) || 0));
          const reservedContentHeight = 110;
          const ratioLimit = Math.floor(height * 0.72);
          const reserveLimit = Math.floor(height - reservedContentHeight);
          return Math.max(minHeight, Math.min(ratioLimit, reserveLimit));
        }

        _setLayoutMode(mode, persist = true) {
          const normalized = ["split", "content-only", "chat-only"].includes(mode)
            ? mode
            : "split";
          const root = this.querySelector("#pt-root");
          if (!root) return;

          const changed = this._layoutMode !== normalized;
          this._layoutMode = normalized;
          root.classList.toggle("pt-layout-content-only", normalized === "content-only");
          root.classList.toggle("pt-layout-chat-only", normalized === "chat-only");

          if (persist && changed) {
            try { localStorage.setItem("paperflow-reader-layout-mode-v1", normalized); }
            catch (_) { /* noop */ }
          }
        }

        _restoreLayoutMode() {
          let mode = "split";
          try { mode = localStorage.getItem("paperflow-reader-layout-mode-v1") || "split"; }
          catch (_) { /* noop */ }
          this._setLayoutMode(mode, false);
        }

        _setActiveTabUI(tabId) {
          const activeClass = "pt-tab pt-tab-active";
          const inactiveClass = "pt-tab";
          this._tabSummary.className = tabId === "summary" ? activeClass : inactiveClass;
          this._tabTranslation.className = tabId === "translation" ? activeClass : inactiveClass;
          this._tabMeta.className = tabId === "meta" ? activeClass : inactiveClass;
        }

        _renderPlaceholderWithButton(container, text, buttonLabel, onClick) {
          container.textContent = "";
          container.className = "pt-placeholder-view";

          const wrapper = this.ownerDocument.createElementNS(xhtmlNS, "div");
          wrapper.className = "pt-placeholder-container";

          const p = this.ownerDocument.createElementNS(xhtmlNS, "p");
          p.className = "pt-placeholder-text";
          p.textContent = text;

          const btn = this.ownerDocument.createElementNS(xhtmlNS, "button");
          btn.setAttribute("type", "button");
          btn.className = "pt-action-btn";
          btn.textContent = buttonLabel;
          btn.addEventListener("click", onClick);

          wrapper.appendChild(p);
          wrapper.appendChild(btn);
          container.appendChild(wrapper);
        }

        // ── 채팅 첨부 (드래그/파일) ─────────────────────────────────────────
        _selectionSourceLabel(source) {
          return ({
            pdf: "PDF 원문",
            summary: "Summary",
            translation: "Translation",
          })[source] || source;
        }

        // Summary/Translation 뷰에서 드래그된 텍스트 캡처
        _captureContentSelection() {
          try {
            const source = this._activeTab === "summary"
              ? "summary"
              : (this._activeTab === "translation" ? "translation" : null);
            if (!source) return; // Meta 탭 등은 대상 아님

            const win = this.ownerDocument && this.ownerDocument.defaultView;
            const sel = win && win.getSelection ? win.getSelection() : null;
            const text = sel ? String(sel).trim() : "";
            if (text.length < 2) return; // 빈 선택/단일 문자 클릭만 무시

            // 선택 영역이 콘텐츠 카드 안에 있는 경우만
            const anchor = sel.anchorNode;
            if (!anchor || !this._contentArea || !this._contentArea.contains(anchor)) return;

            this.addSelectionAttachment(source, text);
          } catch (e) {
            PaperFlowReaderSidebar._warn(`content selection capture failed: ${e.message}`);
          }
        }

        // 드래그 첨부 추가 — 같은 출처의 이전 드래그는 최신 선택으로 교체
        addSelectionAttachment(source, text) {
          try {
            if (!this._rendered) return;
            // 채팅을 쓸 수 없는 상태(번역 결과 없음)면 첨부도 받지 않는다
            if (this._chatInput && this._chatInput.disabled) return;
            const MAX = 6000;
            const truncated = text.length > MAX;
            const clipped = truncated ? text.slice(0, MAX) : text;

            const existing = this._pendingAttachments.find(
              a => a.kind === "selection" && a.source === source
            );
            if (existing) {
              existing.text = clipped;
              existing.truncated = truncated;
            } else {
              this._pendingAttachments.push({
                id: ++this._attachmentSeq,
                kind: "selection",
                source,
                label: this._selectionSourceLabel(source),
                text: clipped,
                truncated,
              });
            }
            this._renderAttachmentChips();
          } catch (e) {
            PaperFlowReaderSidebar._warn(`selection attach failed: ${e.message}`);
          }
        }

        // 칩 미리보기: 내용을 그대로 보여주다가 길면 …으로 생략
        _attachmentPreview(att) {
          const PREVIEW_MAX = 140;
          if (att.kind === "media-pdf") {
            return `PDF 문서 · ${this._formatBytes(att.sizeBytes)}`;
          }
          const text = (att.text || "").replace(/\s+/g, " ").trim();
          return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
        }

        _formatBytes(bytes) {
          const n = Number(bytes) || 0;
          if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
          if (n >= 1024) return `${Math.round(n / 1024)}KB`;
          return `${n}B`;
        }

        _renderAttachmentChips() {
          const box = this._chatAttachmentsEl;
          if (!box) return;
          box.textContent = "";
          if (!this._pendingAttachments.length) {
            box.classList.remove("pt-has-attachments");
            this._clampChatHeight();
            return;
          }
          box.classList.add("pt-has-attachments");
          const doc = this.ownerDocument;
          for (const att of this._pendingAttachments) {
            const chip = doc.createElementNS(xhtmlNS, "div");

            const remove = doc.createElementNS(xhtmlNS, "button");
            remove.setAttribute("type", "button");
            remove.setAttribute("title", "첨부 제거");
            remove.setAttribute("aria-label", "첨부 제거");
            remove.textContent = "×";
            remove.addEventListener("click", () => {
              this._pendingAttachments = this._pendingAttachments.filter(a => a.id !== att.id);
              this._renderAttachmentChips();
            });

            if (att.kind === "image" && att.bytes && att.mimeType) {
              // 라벨 텍스트 없이 이미지 썸네일만 표시 (×는 모서리 오버레이)
              chip.className = "pt-attach-chip pt-attach-chip-image";
              remove.className = "pt-attach-chip-remove pt-attach-img-remove";
              chip.appendChild(remove);
              // canvas 디코딩은 비동기 — × 버튼 앞에 삽입된다
              this._renderImageInto(chip, att, "pt-attach-chip-img", remove);
            } else {
              chip.className = "pt-attach-chip";
              if (att.text) chip.setAttribute("title", att.text.slice(0, 400));

              const head = doc.createElementNS(xhtmlNS, "div");
              head.className = "pt-attach-chip-head";

              const sourceEl = doc.createElementNS(xhtmlNS, "strong");
              sourceEl.className = "pt-attach-chip-source";
              sourceEl.textContent = att.label;

              remove.className = "pt-attach-chip-remove";

              head.appendChild(sourceEl);
              head.appendChild(remove);
              chip.appendChild(head);

              const preview = doc.createElementNS(xhtmlNS, "div");
              preview.className = "pt-attach-chip-preview";
              preview.textContent = this._attachmentPreview(att);
              chip.appendChild(preview);
            }

            box.appendChild(chip);
          }
          // 칩이 차지한 만큼 chat pane을 위로 넓혀 컴포저가 잘리지 않게 한다.
          this._clampChatHeight();
        }

        // ── + 버튼: OS 파일 선택창(Finder)으로 파일 첨부 ─────────────────────
        _openFilePicker() {
          try {
            const win = this.ownerDocument && this.ownerDocument.defaultView;
            if (!win) return;
            const Ci = Components.interfaces;
            const fp = Components.classes["@mozilla.org/filepicker;1"]
              .createInstance(Ci.nsIFilePicker);
            const title = "대화에 첨부할 파일 선택";
            // Gecko 버전에 따라 init 시그니처가 다름 (browsingContext vs window)
            try {
              fp.init(win.browsingContext, title, Ci.nsIFilePicker.modeOpen);
            } catch (_) {
              fp.init(win, title, Ci.nsIFilePicker.modeOpen);
            }
            try {
              fp.appendFilter("텍스트/이미지/PDF", "*.txt; *.md; *.json; *.csv; *.html; *.xml; *.tex; *.png; *.jpg; *.jpeg; *.webp; *.pdf");
              fp.appendFilters(Ci.nsIFilePicker.filterAll);
            } catch (_) { /* 필터 실패해도 picker는 동작 */ }
            fp.open(rv => {
              try {
                if (rv !== Ci.nsIFilePicker.returnOK || !fp.file) return;
                this._attachLocalFile(fp.file.path, fp.file.leafName).catch(e => {
                  PaperFlowReaderSidebar._reportError("attach local file failed", e);
                  this._setStatus(`첨부 실패: ${e.message}`);
                });
              } catch (e) {
                PaperFlowReaderSidebar._reportError("file picker callback failed", e);
              }
            });
          } catch (e) {
            PaperFlowReaderSidebar._reportError("file picker open failed", e);
            this._setStatus("파일 선택창을 열지 못했습니다.");
          }
        }

        async _attachLocalFile(path, name) {
          const ext = (String(name || "").split(".").pop() || "").toLowerCase();
          const IMAGE_MIME = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            webp: "image/webp",
            heic: "image/heic",
            heif: "image/heif",
          };
          const TEXT_EXTS = [
            "txt", "md", "markdown", "json", "csv", "tsv", "html", "htm",
            "xml", "tex", "log", "yaml", "yml", "js", "py", "java", "c", "cpp", "h",
          ];
          const MAX_TEXT = 12000;
          const MAX_IMAGE_BYTES = 6 * 1024 * 1024;  // Gemini inline 한도 고려
          const MAX_PDF_BYTES = 10 * 1024 * 1024;

          this._setStatus(`"${name}" 첨부 중...`);

          if (IMAGE_MIME[ext]) {
            const bytes = await this._readFileBytes(path);
            if (bytes.length > MAX_IMAGE_BYTES) {
              this._setStatus(`이미지가 너무 큽니다. (${this._formatBytes(bytes.length)} > 6MB)`);
              return;
            }
            this._addMediaAttachment({
              kind: "image",
              label: name,
              mimeType: IMAGE_MIME[ext],
              data: this._bytesToBase64(bytes),
              sizeBytes: bytes.length,
              bytes,
            });
            return;
          }

          if (ext === "pdf") {
            const bytes = await this._readFileBytes(path);
            if (bytes.length > MAX_PDF_BYTES) {
              this._setStatus(`PDF가 너무 큽니다. (${this._formatBytes(bytes.length)} > 10MB)`);
              return;
            }
            this._addMediaAttachment({
              kind: "media-pdf",
              label: name,
              mimeType: "application/pdf",
              data: this._bytesToBase64(bytes),
              sizeBytes: bytes.length,
            });
            return;
          }

          if (TEXT_EXTS.includes(ext)) {
            let text = await Zotero.File.getContentsAsync(path);
            if (ext === "html" || ext === "htm") text = this._plainTextWithBreaks(text);
            text = (text || "").trim();
            if (!text) {
              this._setStatus(`"${name}"에서 텍스트를 읽지 못했습니다.`);
              return;
            }
            const truncated = text.length > MAX_TEXT;
            if (truncated) text = text.slice(0, MAX_TEXT);
            this._pendingAttachments.push({
              id: ++this._attachmentSeq,
              kind: "file",
              source: "file",
              label: name,
              text,
              truncated,
            });
            this._renderAttachmentChips();
            this._setStatus(`"${name}" 첨부됨 (${text.length}자${truncated ? ", 잘림" : ""})`);
            return;
          }

          this._setStatus("지원하지 않는 파일 형식입니다. (텍스트/이미지/PDF)");
        }

        async _readFileBytes(path) {
          if (typeof IOUtils !== "undefined" && typeof IOUtils.read === "function") {
            return IOUtils.read(path);
          }
          throw new Error("IOUtils를 사용할 수 없습니다.");
        }

        _bytesToBase64(bytes) {
          let binary = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          }
          const win = this.ownerDocument && this.ownerDocument.defaultView;
          return (win && win.btoa) ? win.btoa(binary) : btoa(binary);
        }

        // 이미지 바이트를 URL 로딩 경로 없이 직접 디코딩해 canvas에 그린다.
        // chrome 문서에서는 data:/blob: URL 이미지 로딩이 막힐 수 있으므로
        // createImageBitmap(보안 정책 미적용)이 가장 확실한 표시 방법이다.
        _renderImageInto(container, att, className, beforeNode) {
          try {
            const doc = this.ownerDocument;
            const win = doc && doc.defaultView;
            if (!win || !att.bytes || typeof win.createImageBitmap !== "function") {
              this._renderImageFallback(container, att, beforeNode);
              return;
            }
            const BlobCtor = win.Blob || Blob;
            const blob = new BlobCtor([att.bytes], { type: att.mimeType || "image/png" });
            win.createImageBitmap(blob)
              .then(bitmap => {
                const canvas = doc.createElementNS(xhtmlNS, "canvas");
                canvas.className = className;
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                canvas.setAttribute("title", `${att.label} (${this._formatBytes(att.sizeBytes)})`);
                const ctx = canvas.getContext("2d");
                ctx.drawImage(bitmap, 0, 0);
                if (typeof bitmap.close === "function") bitmap.close();
                if (beforeNode && beforeNode.parentNode === container) {
                  container.insertBefore(canvas, beforeNode);
                } else {
                  container.appendChild(canvas);
                }
                PaperFlowReaderSidebar._clog(`thumbnail decoded: ${canvas.width}x${canvas.height} (${att.mimeType})`);
              })
              .catch(err => {
                PaperFlowReaderSidebar._warn(`thumbnail decode failed: ${att.label}: ${err.message}`);
                this._renderImageFallback(container, att, beforeNode);
              });
          } catch (e) {
            PaperFlowReaderSidebar._warn(`thumbnail render failed: ${att.label}: ${e.message}`);
            this._renderImageFallback(container, att, beforeNode);
          }
        }

        _renderImageFallback(container, att, beforeNode) {
          try {
            const fallback = this.ownerDocument.createElementNS(xhtmlNS, "div");
            fallback.className = "pt-attach-chip-preview";
            fallback.textContent = `${att.label} (${this._formatBytes(att.sizeBytes)})`;
            if (beforeNode && beforeNode.parentNode === container) {
              container.insertBefore(fallback, beforeNode);
            } else {
              container.appendChild(fallback);
            }
          } catch (_) { /* noop */ }
        }

        _addMediaAttachment({ kind, label, mimeType, data, sizeBytes, bytes }) {
          this._pendingAttachments.push({
            id: ++this._attachmentSeq,
            kind,
            source: "file",
            label,
            mimeType,
            data,
            sizeBytes,
            bytes: bytes || null, // 썸네일 디코딩용 원본 바이트
            truncated: false,
          });
          this._renderAttachmentChips();
          this._setStatus(`"${label}" 첨부됨 (${this._formatBytes(sizeBytes)})`);
          PaperFlowReaderSidebar._clog(
            `media attached: kind=${kind} mime=${mimeType} size=${sizeBytes}B chips=${this._pendingAttachments.length}`
          );
        }

        // ── 클립보드 이미지 붙여넣기 (⌘V) ───────────────────────────────────
        _handlePaste(e) {
          try {
            const cd = e.clipboardData;
            let file = null;
            let type = "";

            // 진단: ⌘V가 핸들러에 도달했는지, 클립보드에 뭐가 보이는지 항상 기록
            try {
              const itemTypes = cd && cd.items
                ? Array.from(cd.items).map(i => `${i.kind}:${i.type || "?"}`).join(", ")
                : "(none)";
              PaperFlowReaderSidebar._clog(
                `paste event: items=[${itemTypes}] files=${cd && cd.files ? cd.files.length : 0}`
              );
            } catch (_) { /* noop */ }

            // 경로 1: 표준 DataTransfer items
            if (cd && cd.items) {
              for (const item of cd.items) {
                if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
                  const f = item.getAsFile();
                  if (f) { file = f; type = item.type; break; }
                }
              }
            }
            // 경로 2: DataTransfer files
            if (!file && cd && cd.files && cd.files.length) {
              for (const f of cd.files) {
                if (f.type && f.type.startsWith("image/")) { file = f; type = f.type; break; }
              }
            }

            if (file) {
              e.preventDefault(); // 이미지일 때만 기본 붙여넣기 차단
              PaperFlowReaderSidebar._clog(`paste: image via DataTransfer (${type}, ${file.size}B)`);
              this._attachImageFile(file, type);
              return;
            }

            // 경로 3: chrome 환경에서 clipboardData가 이미지를 노출하지 않는 경우 —
            // nsIClipboard에서 직접 읽는다
            const img = this._readClipboardImage();
            PaperFlowReaderSidebar._clog(
              `paste: nsIClipboard=${img ? `${img.mimeType}/${img.bytes.length}B` : "none"}`
            );
            if (img) {
              e.preventDefault();
              const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
              if (img.bytes.length > MAX_IMAGE_BYTES) {
                this._setStatus(`이미지가 너무 큽니다. (${this._formatBytes(img.bytes.length)} > 6MB)`);
                return;
              }
              this._addMediaAttachment({
                kind: "image",
                label: `클립보드 이미지 ${new Date().toLocaleTimeString("ko-KR", { hour12: false })}`,
                mimeType: img.mimeType,
                data: this._bytesToBase64(img.bytes),
                sizeBytes: img.bytes.length,
                bytes: img.bytes,
              });
            }
          } catch (err) {
            PaperFlowReaderSidebar._reportError("paste handling failed", err);
          }
        }

        _attachImageFile(file, type) {
          const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
          if (file.size > MAX_IMAGE_BYTES) {
            this._setStatus(`이미지가 너무 큽니다. (${this._formatBytes(file.size)} > 6MB)`);
            return;
          }
          const genericName = !file.name || /^image\.(png|jpe?g|webp)$/i.test(file.name);
          const label = genericName
            ? `클립보드 이미지 ${new Date().toLocaleTimeString("ko-KR", { hour12: false })}`
            : file.name;
          file.arrayBuffer()
            .then(buf => {
              const bytes = new Uint8Array(buf);
              this._addMediaAttachment({
                kind: "image",
                label,
                mimeType: type || file.type || "image/png",
                data: this._bytesToBase64(bytes),
                sizeBytes: file.size,
                bytes,
              });
            })
            .catch(err => {
              PaperFlowReaderSidebar._reportError("clipboard image read failed", err);
              this._setStatus(`이미지 첨부 실패: ${err.message}`);
            });
        }

        // nsIClipboard에서 이미지 플레이버를 직접 읽기 (스크린샷 ⌘⇧⌃4 등)
        _readClipboardImage() {
          try {
            const Ci = Components.interfaces;
            const Cc = Components.classes;
            const clip = Cc["@mozilla.org/widget/clipboard;1"].getService(Ci.nsIClipboard);

            for (const flavor of ["image/png", "image/jpeg", "image/jpg"]) {
              try {
                const trans = Cc["@mozilla.org/widget/transferable;1"]
                  .createInstance(Ci.nsITransferable);
                trans.init(null);
                trans.addDataFlavor(flavor);
                clip.getData(trans, clip.kGlobalClipboard);

                const dataObj = {};
                // Gecko 버전에 따라 getTransferData 시그니처가 다름 (2-arg vs 3-arg)
                try {
                  trans.getTransferData(flavor, dataObj);
                } catch (_) {
                  trans.getTransferData(flavor, dataObj, {});
                }
                if (!dataObj.value) continue;

                let istream = null;
                try {
                  istream = dataObj.value.QueryInterface(Ci.nsIInputStream);
                } catch (_) {
                  continue;
                }
                const bstream = Cc["@mozilla.org/binaryinputstream;1"]
                  .createInstance(Ci.nsIBinaryInputStream);
                bstream.setInputStream(istream);
                const avail = bstream.available();
                if (!avail) continue;
                const bytes = new Uint8Array(bstream.readByteArray(avail));
                const mimeType = flavor === "image/jpg" ? "image/jpeg" : flavor;
                return { mimeType, bytes };
              } catch (_) {
                continue; // 이 플레이버는 없음 — 다음 시도
              }
            }
          } catch (e) {
            PaperFlowReaderSidebar._warn(`nsIClipboard image read failed: ${e.message}`);
          }
          return null;
        }

        _startTranslation() {
          if (typeof PTJobQueue !== "undefined" && PTJobQueue.isRunning()) {
            this._setStatus("다른 번역이 이미 진행 중입니다.");
            return;
          }
          if (typeof Zotero !== "undefined" && Zotero.PaperTranslator) {
            const win = Zotero.getMainWindow();
            Zotero.PaperTranslator.runTranslation(win, this._item)
              .then(() => {
                this._loadData();
              })
              .catch(err => {
                PaperFlowReaderSidebar._reportError("translation run failed", err);
              });
          } else {
            PaperFlowReaderSidebar._warn("Zotero.PaperTranslator is not available");
          }
        }

        _renderActiveTabContent() {
          if (!this._bundle) {
            this._setContent("Loading...");
            return;
          }

          const hasBundleData = this._bundle && this._bundle.existing && this._bundle.existing.exists;

          if (this._activeTab === "summary") {
            if (hasBundleData && this._bundle.noteHTML) {
              this._renderHTMLContent(this._bundle.noteHTML, "pt-summary-view", "요약 노트가 없습니다.");
            } else {
              this._renderPlaceholderWithButton(this._contentArea, "요약 결과가 없습니다.", "Generate Summary", () => this._startTranslation());
            }
          } else if (this._activeTab === "translation") {
            if (hasBundleData && this._bundle.htmlText) {
              this._renderHTMLContent(this._bundle.htmlText, "pt-translation-view", "전체 번역본이 없습니다.");
            } else {
              this._renderPlaceholderWithButton(this._contentArea, "번역 결과가 없습니다.", "Translate Selection", () => this._startTranslation());
            }
          } else if (this._activeTab === "meta") {
            this._renderMetaContent(this._bundle.meta || {});
          }
        }

        _setContent(text) {
          this._contentArea.textContent = text || "";
          this._contentArea.className = "pt-text-view";
        }

        _updateItemUI() {
          if (!this._rendered) return;

          if (!this._item) {
            this._paperTitle.textContent = "No item selected";
            this._showStatusBadge("missing", "missing");
            this._setContent("No item selected");
            this._disableChat("논문 item을 선택해 주세요.");
            return;
          }

          const parent = PaperFlowReaderSidebar._resolveParentItem(this._item);
          const displayItem = parent || this._item;
          const title = (displayItem.getDisplayTitle && displayItem.getDisplayTitle())
            || displayItem.getField?.("title")
            || `Item #${displayItem.id}`;
          this._paperTitle.textContent = title;

          this._loadData();
        }

        _loadData() {
          const loadSeq = ++this._loadSeq;
          this._bundle = null;
          this._chatHistory = []; // item이 바뀌면 대화 맥락도 초기화
          this._pendingAttachments = []; // 다른 논문의 첨부가 남지 않도록
          this._renderAttachmentChips();

          this._setStatus("Loading paper data...");
          this._showStatusBadge("missing", "loading");
          this._setContent("Loading...");

          this._chatLog.textContent = "";
          this._disableChat("Loading data...");

          const parentItem = PaperFlowReaderSidebar._resolveParentItem(this._item) || this._item;

          if (typeof PTStorage === "undefined" || !PTStorage.loadBundle) {
            PaperFlowReaderSidebar._warn("PTStorage.loadBundle is unavailable");
            if (this._loadSeq === loadSeq) {
              this._setFailure("PTStorage unavailable");
            }
            return;
          }

          PTStorage.loadBundle(parentItem)
            .then(bundle => {
              if (this._loadSeq !== loadSeq) return;
              this._bundle = bundle;

              if (bundle && bundle.existing && bundle.existing.exists) {
                const status = bundle.existing.status || "partial";
                const isCompleted = bundle.existing.completed || status === "completed" || status === "done";
                this._showStatusBadge(isCompleted ? "completed" : "partial", isCompleted ? "completed" : "partial");

                const meta = bundle.meta || {};
                const total = meta.totalChunks ?? (Array.isArray(meta.chunks) ? meta.chunks.length : null);
                const done = meta.doneChunks ?? this._countChunks(meta, "done");
                this._chunkProgress.textContent = (total && Number.isFinite(Number(total)) && Number(total) > 0)
                  ? `${done || 0}/${total} chunks`
                  : "";

                this._setStatus("PaperFlow panel ready.");

                this._chatInput.disabled = false;
                this._chatSend.disabled = false;
                if (this._chatAttach) this._chatAttach.disabled = false;
                this._syncComposerHint();
                this._chatLog.textContent = "";

                this._renderActiveTabContent();
              } else {
                this._showStatusBadge("missing", "missing");
                this._chunkProgress.textContent = "";
                this._setStatus("번역 결과가 없습니다.");
                this._disableChat("번역 결과가 없어 채팅 context를 만들 수 없습니다.");
                this._renderActiveTabContent();
              }
            })
            .catch(err => {
              if (this._loadSeq !== loadSeq) return;
              PaperFlowReaderSidebar._warn("loadBundle failed: " + (err && err.message));
              this._showStatusBadge("missing", "error");
              this._chunkProgress.textContent = "";
              this._setFailure("저장된 결과를 불러오지 못했습니다.", err);
              this._disableChat("번역 결과를 읽지 못해 채팅을 할 수 없습니다.");
              this._renderActiveTabContent();
            });
        }

        _setStatus(text) {
          this._statusLine.textContent = text || "";
        }

        _showStatusBadge(state, label) {
          this._statusChip.textContent = label;
          this._statusChip.className = `pt-chip pt-chip-${state}`;
        }

        _disableChat(message) {
          this._chatInput.disabled = true;
          this._chatSend.disabled = true;
          if (this._chatAttach) this._chatAttach.disabled = true;
          this._syncComposerHint();
          this._chatLog.textContent = "";
          this._appendBubble("assistant", message || "채팅을 사용할 수 없습니다.");
        }

        _setFailure(phase, error) {
          const detail = error ? `${error.name || "Error"}: ${error.message || String(error)}` : "";
          this._setStatus(`PaperFlow panel failed to load. ${phase}`);
          this._setContent(`PaperFlow 결과를 읽지 못했습니다.\n${detail}`);
        }

        _renderHTMLContent(html, className, emptyMessage) {
          this._contentArea.textContent = "";
          this._contentArea.className = className || "";

          try {
            const cleanHTML = String(html || "").replace(/<!-- PT_META:[\s\S]*?-->/g, "");
            const doc = new DOMParser().parseFromString(cleanHTML, "text/html");

            doc.querySelectorAll("script, style, iframe, object, embed").forEach(node => node.remove());

            const wrapper = this.ownerDocument.createElementNS(xhtmlNS, "div");
            wrapper.className = `pt-doc ${className}`;

            this._appendSanitizedChildren(doc.body || doc, wrapper);

            if (!wrapper.textContent.trim()) {
              wrapper.textContent = emptyMessage || "표시할 내용이 없습니다.";
            } else if (!this._hasBlockChildren(wrapper)) {
              wrapper.textContent = this._plainTextWithBreaks(cleanHTML);
            }

            this._contentArea.appendChild(wrapper);
          } catch (e) {
            PaperFlowReaderSidebar._reportError("renderHTMLContent failed", e);
            this._contentArea.textContent = "HTML 렌더링에 실패했습니다.";
          }
        }

        _renderMetaContent(meta) {
          this._contentArea.textContent = "";
          this._contentArea.className = "pt-meta-view";

          try {
            const wrapper = this.ownerDocument.createElementNS(xhtmlNS, "div");
            wrapper.className = "pt-doc pt-meta-view";

            const table = this.ownerDocument.createElementNS(xhtmlNS, "table");
            table.className = "pt-meta-summary";
            const tbody = this.ownerDocument.createElementNS(xhtmlNS, "tbody");
            table.appendChild(tbody);

            const rows = [
              ["status", meta.status || this._bundle?.existing?.status || "unknown"],
              ["completedAt", meta.completedAt || meta.updatedAt || meta.savedAt || ""],
              ["total chunks", meta.totalChunks ?? meta.chunks?.length ?? ""],
              ["done chunks", meta.doneChunks ?? this._countChunks(meta, "done")],
              ["failed chunks", meta.failedChunks ?? this._countChunks(meta, "failed")],
              ["layout analysis", meta.layoutAnalysis?.status || "text-only"],
              ["layout mode", meta.layout?.mode || meta.layoutAnalysis?.mode || "-"],
              ["source visuals", meta.layout?.stats?.visualBlocks ?? 0],
              ["LaTeX expressions", meta.layout?.stats?.latexExpressions ?? 0],
              ["htmlAttachmentID", meta.htmlAttachmentID || meta.htmlAttachmentId || this._bundle?.existing?.htmlAttachmentID || ""],
              ["metaAttachmentID", meta.metaAttachmentID || meta.metaAttachmentId || this._bundle?.existing?.metaAttachmentID || ""],
            ];

            for (const [key, value] of rows) {
              const tr = this.ownerDocument.createElementNS(xhtmlNS, "tr");
              const th = this.ownerDocument.createElementNS(xhtmlNS, "th");
              th.textContent = key;
              const td = this.ownerDocument.createElementNS(xhtmlNS, "td");
              td.textContent = (value === "" || value === null || value === undefined) ? "-" : String(value);
              tr.appendChild(th);
              tr.appendChild(td);
              tbody.appendChild(tr);
            }

            const rawTitle = this.ownerDocument.createElementNS(xhtmlNS, "h2");
            rawTitle.textContent = "Raw JSON";
            const pre = this.ownerDocument.createElementNS(xhtmlNS, "pre");
            pre.className = "pt-raw-json";
            // meta에는 번역 본문이 포함되므로 디버그 뷰에서는 길이만 표시
            const displayMeta = Object.assign({}, meta || {});
            if (Array.isArray(displayMeta.chunks)) {
              displayMeta.chunks = displayMeta.chunks.map(c => Object.assign({}, c, {
                translation: c && c.translation ? `[${c.translation.length} chars]` : "",
                summary: c && c.summary ? `[${c.summary.length} chars]` : "",
              }));
            }
            pre.textContent = JSON.stringify(displayMeta, null, 2) || "{}";

            wrapper.appendChild(table);
            wrapper.appendChild(rawTitle);
            wrapper.appendChild(pre);

            this._contentArea.appendChild(wrapper);
          } catch (e) {
            PaperFlowReaderSidebar._reportError("renderMetaContent failed", e);
            this._contentArea.textContent = "Meta 렌더링에 실패했습니다.";
          }
        }

        _countChunks(meta, status) {
          return Array.isArray(meta?.chunks)
            ? meta.chunks.filter(chunk => chunk && chunk.status === status).length
            : "";
        }

        async _ask() {
          if (this._chatSending) return;
          // 조합 중인 마지막 음절까지 확정한 뒤에 읽는다.
          this._commitComposition();
          const question = (this._chatInput.value || "").trim();
          if (!question) return;

          this._chatSending = true;
          this._chatSend.disabled = true;
          // 전송이 확정되면 Gemini 응답을 기다리지 않고 입력창부터 비운다.
          this._clearComposer();

          // 보내는 시점의 첨부 스냅샷 (전송 중 칩 조작과 분리)
          const promptLabelFor = (a) => {
            if (a.kind === "selection") return `${a.label}에서 드래그한 텍스트`;
            if (a.kind === "image") return `첨부 이미지 "${a.label}"`;
            if (a.kind === "media-pdf") return `첨부 PDF "${a.label}"`;
            return `첨부 파일 "${a.label}"`;
          };
          const attachments = this._pendingAttachments.map(a => ({
            kind: a.kind,
            label: a.label,
            text: a.text || "",
            mimeType: a.mimeType || "",
            data: a.data || "",
            bytes: a.bytes || null,
            sizeBytes: a.sizeBytes || 0,
            promptLabel: promptLabelFor(a),
          }));

          const userBubble = this._appendBubble("user", question);
          if (attachments.length && userBubble) {
            const doc = this.ownerDocument;
            // 이미지는 말풍선에 썸네일로 그대로 표시 (GPT/Claude 스타일)
            for (const a of attachments) {
              if (a.kind !== "image" || !a.bytes || !a.mimeType) continue;
              this._renderImageInto(userBubble, a, "pt-msg-img");
            }
            // 텍스트 첨부는 무엇이 어디서 왔는지 명시
            const textAtts = attachments.filter(a => a.kind !== "image");
            if (textAtts.length) {
              const note = doc.createElementNS(xhtmlNS, "div");
              note.className = "pt-msg-attach-note";
              note.textContent = "첨부: " + textAtts
                .map(a => `${a.label}${a.kind === "selection" ? " 드래그" : ""}`)
                .join(", ");
              userBubble.appendChild(note);
            }
          }
          const pending = this._appendBubble("assistant", "답변 생성 중...");

          try {
            if (typeof PTChat === "undefined") throw new Error("PTChat is not loaded.");
            if (!this._bundle) throw new Error("번역 결과가 없어 채팅 context를 만들 수 없습니다.");

            const parent = PaperFlowReaderSidebar._resolveParentItem(this._item);
            const title = (parent || this._item)?.getField?.("title") || "제목 없음";

            const answer = await PTChat.ask(question, this._bundle, {
              title,
              history: this._chatHistory,
              attachments: attachments
                .filter(a => a.text)
                .map(a => ({ label: a.promptLabel, text: a.text })),
              media: attachments
                .filter(a => a.data && a.mimeType)
                .map(a => ({ label: a.promptLabel, mimeType: a.mimeType, data: a.data })),
            });
            if (pending) {
              if (typeof PTResponseRenderer !== "undefined") PTResponseRenderer.render(pending, answer);
              else pending.textContent = answer;
              this._chatLog.scrollTop = this._chatLog.scrollHeight;
            }
            // 후속 질문("그 발췌에서...")이 이어지도록 첨부 사실을 이력에 남긴다
            const historyUserText = attachments.length
              ? `${question}\n(첨부: ${attachments.map(a => a.promptLabel).join(", ")})`
              : question;
            this._chatHistory.push(
              { role: "user", text: historyUserText },
              { role: "assistant", text: answer }
            );
            // 사용된 첨부는 비운다 (대화 이력에 맥락이 남음)
            this._pendingAttachments = [];
            this._renderAttachmentChips();
            // 메모리 무한 증가 방지 — PTChat이 어차피 최근 턴만 사용한다
            if (this._chatHistory.length > 24) {
              this._chatHistory = this._chatHistory.slice(-24);
            }
          } catch (e) {
            if (pending) {
              pending.className = "pt-msg pt-msg-error";
              pending.textContent = `오류: ${e.message}`;
            }
          } finally {
            this._chatSending = false;
            this._chatSend.disabled = false;
          }
        }

        _appendBubble(role, text) {
          const div = this.ownerDocument.createElementNS(xhtmlNS, "div");
          div.className = `pt-msg pt-msg-${role}`;
          div.textContent = String(text || "");
          this._chatLog.appendChild(div);
          this._chatLog.scrollTop = this._chatLog.scrollHeight;
          return div;
        }

        _appendSanitizedChildren(source, target) {
          for (const child of Array.from(source.childNodes || [])) {
            const sanitized = this._sanitizeNode(child);
            if (sanitized) target.appendChild(sanitized);
          }
        }

        _sanitizeNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            return this.ownerDocument.createTextNode(node.nodeValue || "");
          }
          if (node.nodeType !== Node.ELEMENT_NODE) {
            return null;
          }

          const tag = node.localName ? node.localName.toLowerCase() : "";
          const allowed = new Set([
            "article", "section", "figure", "figcaption", "div", "p", "br", "span", "img",
            "h1", "h2", "h3", "h4", "h5", "h6",
            "ul", "ol", "li", "strong", "b", "em", "i",
            "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td",
            "details", "summary",
          ]);
          const mathTags = new Set([
            "math", "mrow", "mi", "mn", "mo", "mtext", "mspace", "ms",
            "mfrac", "msqrt", "mroot", "mstyle", "merror", "mpadded", "mphantom",
            "msub", "msup", "msubsup", "munder", "mover", "munderover",
            "mmultiscripts", "mprescripts", "none", "mtable", "mlabeledtr", "mtr", "mtd",
            "menclose", "mfenced",
          ]);
          const safeClasses = Array.from(node.classList || [])
            .filter(c => /^(pt-|badge$|partial$|failed$|level-)/.test(c))
            .join(" ");

          if (tag === "img") {
            const src = node.getAttribute("src") || "";
            if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(src)) return null;
            const out = this.ownerDocument.createElementNS(xhtmlNS, "canvas");
            if (safeClasses) out.setAttribute("class", safeClasses);
            const alt = String(node.getAttribute("alt") || "").slice(0, 500);
            if (alt) {
              out.setAttribute("aria-label", alt);
              out.setAttribute("title", alt);
            }
            this._drawDataImageCanvas(out, src);
            return out;
          }

          if (mathTags.has(tag)) {
            const out = this.ownerDocument.createElementNS("http://www.w3.org/1998/Math/MathML", tag);
            const safeMathAttributes = new Set([
              "display", "mathvariant", "mathsize", "mathcolor", "mathbackground",
              "scriptlevel", "displaystyle", "stretchy", "symmetric", "maxsize", "minsize",
              "largeop", "movablelimits", "accent", "accentunder", "linethickness",
              "numalign", "denomalign", "bevelled", "notation", "open", "close", "separators",
              "columnalign", "rowalign", "columnspacing", "rowspacing", "columnlines", "rowlines",
              "frame", "framespacing", "equalrows", "equalcolumns", "rowspan", "columnspan",
              "width", "height", "depth", "lspace", "rspace", "voffset",
            ]);
            for (const attribute of Array.from(node.attributes || [])) {
              const name = String(attribute.localName || attribute.name || "").toLowerCase();
              if (safeMathAttributes.has(name)) out.setAttribute(name, String(attribute.value || "").slice(0, 200));
            }
            this._appendSanitizedChildren(node, out);
            return out;
          }

          const outTag = allowed.has(tag) ? tag : "div";
          const out = this.ownerDocument.createElementNS(xhtmlNS, outTag);
          if (safeClasses) out.setAttribute("class", safeClasses);

          if (node.hasAttribute("id")) {
            out.setAttribute("id", node.getAttribute("id"));
          }

          this._appendSanitizedChildren(node, out);
          return out;
        }

        _drawDataImageCanvas(canvas, dataURI) {
          try {
            const match = String(dataURI || "").match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i);
            const win = this.ownerDocument?.defaultView;
            if (!match || !win || typeof win.createImageBitmap !== "function") return;
            const binary = win.atob(match[2]);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const BlobCtor = win.Blob || Blob;
            const blob = new BlobCtor([bytes], { type: match[1] });
            win.createImageBitmap(blob)
              .then(bitmap => {
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                canvas.getContext("2d").drawImage(bitmap, 0, 0);
                if (typeof bitmap.close === "function") bitmap.close();
              })
              .catch(error => PaperFlowReaderSidebar._warn(`source visual decode failed: ${error.message}`));
          } catch (error) {
            PaperFlowReaderSidebar._warn(`source visual render failed: ${error.message}`);
          }
        }

        _plainTextWithBreaks(html) {
          return String(html || "")
            .replace(/<!-- PT_META:[\s\S]*?-->/g, "")
            .replace(/<\/(h[1-6]|p|div|section|article|li|tr)>/gi, "\n")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/\n\s+/g, "\n")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim() || "표시할 내용이 없습니다.";
        }

        _hasBlockChildren(node) {
          return Array.from(node.querySelectorAll("h1,h2,h3,h4,h5,h6,p,section,article,ul,ol,table")).length > 0;
        }
      };

      win.customElements.define(this.ELEMENT_NAME, PanelElement);
      this._clog(`${this.ELEMENT_NAME} custom element defined`);
      return true;
    } catch (e) {
      this._warn(`${this.ELEMENT_NAME} define failed: ${e.message}`);
      return false;
    }
  },

  // ── lifecycle hooks ──────────────────────────────────────────────────────
  _onInit(props) {
    this._logPropsKeysOnce("onInit", props);
    const { body, refresh } = props || {};
    try {
      const paneUID = `${Date.now()}-${++this._renderBodySeq}`;
      if (body && body.dataset) body.dataset.paneUid = paneUID;
      if (typeof refresh === "function") this._panelRefreshByUID.set(paneUID, refresh);
      this._ensureReaderPanelElement(body ? body.ownerDocument : null);
      this._clog(`onInit paneUID=${paneUID} hasBody=${!!body} refreshFn=${typeof refresh === "function"}`);
    } catch (e) {
      this._warn(`onInit failed: ${e.message}`);
    }
  },

  _onDestroy(props) {
    this._logPropsKeysOnce("onDestroy", props);
    const { body } = props || {};
    try {
      const paneUID = body && body.dataset ? body.dataset.paneUid : "";
      if (paneUID) this._panelRefreshByUID.delete(paneUID);
      this._clog(`onDestroy paneUID=${paneUID || "(none)"} hasBody=${!!body}`);
    } catch (e) {
      this._warn(`onDestroy failed: ${e.message}`);
    }
  },

  _onItemChange(props) {
    this._logPropsKeysOnce("onItemChange", props);
    const { item, tabType, body, setEnabled, setSectionSummary } = props || {};
    this._clog(`onItemChange tabType=${tabType} itemID=${item && item.id != null ? item.id : "none"}`);
    if (typeof setEnabled === "function") setEnabled(tabType === "reader");
    if (body && body.dataset && item && item.id != null) {
      body.dataset.itemID = String(item.id);
    }
    if (typeof setSectionSummary === "function") {
      try { setSectionSummary("PaperFlow ready"); } catch (_) { /* noop */ }
    }
    return true;
  },

  _onRender(props) {
    this._logPropsKeysOnce("onRender", props);
    const { doc, body, item, tabType } = props || {};
    if (!body) {
      this._clog("onRender: no body — skip");
      return;
    }
    if (!body.isConnected) {
      this._clog("onRender: body disconnected — skip");
      return;
    }
    this._clog(`onRender tabType=${tabType} itemID=${item && item.id != null ? item.id : "none"} bodyConnected=${body.isConnected}`);

    try {
      const document_ = doc || body.ownerDocument || null;
      this._ensureReaderPanelElement(document_);
      const panel = body.querySelector ? body.querySelector(this.ELEMENT_NAME) : null;
      if (panel) {
        panel.item = item || null;
      }
    } catch (e) {
      this._reportError("onRender assignment failed", e);
    }
  },

  _onToggle(props) {
    const eventTarget = props && props.event ? props.event.target : null;
    const open = eventTarget ? eventTarget.open : undefined;
    const section = this._getSectionFromProps(props);
    this._clog(`onToggle open=${open} hasBody=${!!(props && props.body)} hasSection=${!!section}`);
    if (open && (section || (props && props.body))) this._scrollIntoView(section || props.body);
  },

  _onSectionButtonClick(type, props) {
    try {
      const item = props && props.item;
      this._clog(`section button clicked type=${type} itemID=${item && item.id != null ? item.id : "none"}`);
    } catch (e) {
      this._warn(`section button click log failed type=${type}: ${e.message}`);
    }
  },

  _scrollIntoView(targetNode) {
    try {
      const section = this._findSectionNode(targetNode);
      const target = section || targetNode;
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
        this._clog("scrolled section into view (block:nearest)");
      }
    } catch (e) {
      this._warn(`scrollIntoView failed: ${e.message}`);
    }
  },

  _getSectionFromProps(props) {
    try {
      if (!props) return null;
      if (props.section && props.section.nodeType === 1) return props.section;
      if (props.body && props.body.closest) {
        const bodySection = this._findSectionNode(props.body);
        if (bodySection) return bodySection;
      }
      const eventTarget = props.event && props.event.target ? props.event.target : null;
      const eventSection = this._findSectionNode(eventTarget);
      if (eventSection) return eventSection;
    } catch (_) { /* noop */ }
    return null;
  },

  _findSectionNode(node) {
    if (!node || typeof node.closest !== "function") return null;
    try {
      const collapsibleSection = node.closest("collapsible-section");
      if (collapsibleSection && this._matchesPaperFlowPane(collapsibleSection.dataset && collapsibleSection.dataset.pane)) {
        return collapsibleSection;
      }
      const customSection = node.closest("item-pane-custom-section");
      if (customSection && this._matchesPaperFlowPane(customSection.dataset && customSection.dataset.pane)) {
        return customSection;
      }
      const paneNode = node.closest("[data-pane]");
      if (paneNode && this._matchesPaperFlowPane(paneNode.dataset && paneNode.dataset.pane)) {
        return paneNode;
      }
    } catch (_) {
      return null;
    }
    return null;
  },

  _matchesPaperFlowPane(paneID) {
    if (!paneID) return false;
    return paneID === this.PANE_ID
      || paneID === this._registeredPaneID
      || paneID.endsWith(`-${this.PANE_ID}`);
  },

  _ensureOpenPref(paneID) {
    try {
      const id = paneID || this._registeredPaneID;
      if (!id || typeof Zotero === "undefined" || !Zotero.Prefs) return;
      const key = `panes.${id}.open`;
      if (Zotero.Prefs.get(key) === true) {
        this._clog(`open pref already true: ${key}`);
        return;
      }
      Zotero.Prefs.set(key, true);
      this._clog(`open pref set true: ${key}`);
    } catch (e) {
      this._warn(`open pref update skipped: ${e.message}`);
    }
  },

  _ensureSidenavOrder() {
    try {
      if (!this._registeredPaneID || typeof Zotero === "undefined" || !Zotero.Prefs) return;

      // 최초 설치 시 한 번만 적용 — 매 시작마다 덮어쓰면 사용자가 바꾼
      // 패널 순서가 계속 초기화된다
      if (typeof PTPrefs !== "undefined" && PTPrefs.get("sidenavOrderApplied") === true) {
        this._clog("sidenav.order already applied once — skip");
        return;
      }

      const current = Zotero.Prefs.get("sidenav.order") || "";
      let order = current
        ? current.split(",").map((id) => id.trim()).filter(Boolean)
        : this.DEFAULT_SIDENAV_ORDER.slice();

      order = order.filter((id) => id !== this.PANE_ID && id !== this._registeredPaneID);
      order.push(this._registeredPaneID);

      Zotero.Prefs.set("sidenav.order", order.join(","));
      if (typeof PTPrefs !== "undefined") PTPrefs.set("sidenavOrderApplied", true);
      this._clog(`sidenav.order updated (moved to bottom): ${this._registeredPaneID}`);
    } catch (e) {
      this._warn(`sidenav.order update skipped: ${e.message}`);
    }
  },

  // ── PDF 리더 텍스트 드래그 → 채팅 첨부 ───────────────────────────────────
  // Zotero 7+ 플러그인 API: 선택 팝업이 뜰 때 선택 텍스트를 받아온다
  _registerReaderSelectionListener() {
    if (this._selectionListener) return;
    try {
      if (typeof Zotero === "undefined"
        || !Zotero.Reader
        || typeof Zotero.Reader.registerEventListener !== "function") {
        this._warn("Zotero.Reader.registerEventListener unavailable — PDF 드래그 첨부 비활성");
        return;
      }
      this._selectionListener = (event) => {
        try {
          const text = (event?.params?.annotation?.text || "").trim();
          if (text.length < 2) return; // 빈 선택만 무시 (짧은 용어도 첨부 가능)
          this._broadcastPdfSelection(event?.reader?.itemID, text);
          this._watchPdfSelectionPopup(event);
        } catch (e) {
          this._warn(`reader selection capture failed: ${e.message}`);
        }
      };
      Zotero.Reader.registerEventListener(
        "renderTextSelectionPopup",
        this._selectionListener,
        this.PLUGIN_ID
      );
      this._clog("reader text selection listener registered");
    } catch (e) {
      this._warn(`reader selection listener register failed: ${e.message}`);
      this._selectionListener = null;
    }
  },

  _unregisterReaderSelectionListener() {
    if (!this._selectionListener) return;
    try {
      if (typeof Zotero !== "undefined"
        && Zotero.Reader
        && typeof Zotero.Reader.unregisterEventListener === "function") {
        Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._selectionListener);
      }
    } catch (e) {
      this._warn(`reader selection listener unregister failed: ${e.message}`);
    } finally {
      this._selectionListener = null;
    }
  },

  // 리더 선택 팝업에 숨김 마커를 심고, 팝업이 DOM에서 사라지면(=선택 해제)
  // PDF 드래그 첨부를 제거한다. 새 선택이 생기면 마커가 교체되므로 안전.
  _watchPdfSelectionPopup(event) {
    try {
      if (typeof event?.append !== "function") return;
      const doc = event.doc
        || (typeof Zotero !== "undefined" && Zotero.getMainWindow && Zotero.getMainWindow()?.document);
      if (!doc) return;
      const marker = doc.createElement("span");
      marker.style.display = "none";
      marker.dataset.paperflowSelectionMarker = "1";
      event.append(marker);
      this._pdfPopupMarker = marker;
      this._startPdfMarkerWatch();
    } catch (e) {
      this._warn(`pdf popup marker attach failed: ${e.message}`);
    }
  },

  _startPdfMarkerWatch() {
    this._stopPdfMarkerWatch();
    try {
      const win = (typeof Zotero !== "undefined" && Zotero.getMainWindow) ? Zotero.getMainWindow() : null;
      if (!win) return;
      this._pdfMarkerTimer = win.setInterval(() => {
        const marker = this._pdfPopupMarker;
        if (marker && marker.isConnected) return;
        this._stopPdfMarkerWatch();
        this._pdfPopupMarker = null;
        for (const panel of this._activePanels) {
          try { panel.removeSelectionAttachment("pdf"); } catch (_) { /* noop */ }
        }
      }, 400);
    } catch (e) {
      this._warn(`pdf marker watch start failed: ${e.message}`);
    }
  },

  _stopPdfMarkerWatch() {
    if (!this._pdfMarkerTimer) return;
    try {
      const win = (typeof Zotero !== "undefined" && Zotero.getMainWindow) ? Zotero.getMainWindow() : null;
      if (win) win.clearInterval(this._pdfMarkerTimer);
    } catch (_) { /* noop */ }
    this._pdfMarkerTimer = null;
  },

  // 리더에서 드래그된 텍스트를, 같은 논문을 보고 있는 panel에만 전달
  _broadcastPdfSelection(readerAttachmentID, text) {
    try {
      if (readerAttachmentID == null) return;
      let parentID = readerAttachmentID;
      if (typeof Zotero !== "undefined" && Zotero.Items) {
        const att = Zotero.Items.get(readerAttachmentID);
        if (att && att.parentItemID) parentID = att.parentItemID;
      }
      for (const panel of this._activePanels) {
        try {
          if (panel.isConnected && panel.matchesParentItemID(parentID)) {
            panel.addSelectionAttachment("pdf", text);
          }
        } catch (_) { /* noop */ }
      }
    } catch (e) {
      this._warn(`pdf selection broadcast failed: ${e.message}`);
    }
  },

  _logPropsKeysOnce(phase, props) {
    const flag = phase === "onRender"
      ? "_loggedRenderProps"
      : (phase === "onInit"
        ? "_loggedInitProps"
        : (phase === "onDestroy" ? "_loggedDestroyProps" : "_loggedItemChangeProps"));
    if (this[flag]) return;
    this[flag] = true;
    try {
      const keys = Object.keys(props || {}).join(",");
      this._clog(`${phase} props keys=${keys || "(none)"}`);
    } catch (e) {
      this._warn(`${phase} props key logging failed: ${e.message}`);
    }
  },

  // ── active=blue 스타일시트 (data-pane 기반, DOM append 아님) ──────────────
  _registerStyleSheet() {
    if (this._styleSheetRegistered) return;
    try {
      const sss = Components.classes["@mozilla.org/content/style-sheet-service;1"]
        .getService(Components.interfaces.nsIStyleSheetService);
      const uri = Services.io.newURI(this.STYLESHEET_URI);
      if (!sss.sheetRegistered(uri, sss.USER_SHEET)) {
        sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
      }
      this._styleSheetRegistered = true;
      this._log("active-state stylesheet registered");
    } catch (e) {
      this._warn(`stylesheet register failed (icon stays gray): ${e.message}`);
    }
  },

  _unregisterStyleSheet() {
    if (!this._styleSheetRegistered) return;
    try {
      const sss = Components.classes["@mozilla.org/content/style-sheet-service;1"]
        .getService(Components.interfaces.nsIStyleSheetService);
      const uri = Services.io.newURI(this.STYLESHEET_URI);
      if (sss.sheetRegistered(uri, sss.USER_SHEET)) {
        sss.unregisterSheet(uri, sss.USER_SHEET);
      }
    } catch (e) {
      this._warn(`stylesheet unregister failed: ${e.message}`);
    } finally {
      this._styleSheetRegistered = false;
    }
  },

  // ── parent item resolve (fatal throw 금지) ───────────────────────────────
  _resolveParentItem(item) {
    try {
      if (!item) return null;
      if (item.isRegularItem && item.isRegularItem()) return item;
      const parentID = item.parentItemID
        || item.parentID
        || (item.getSource && item.getSource())
        || null;
      if (parentID && typeof Zotero !== "undefined" && Zotero.Items) {
        const parent = Zotero.Items.get(parentID);
        if (parent) return parent;
      }
      if (item.isAttachment && item.isAttachment()) return null;
      return item;
    } catch (e) {
      this._warn(`parent resolve failed: ${e.message}`);
      return null;
    }
  },

  // ── FTL 주입 (best-effort; Zotero가 locale/*.ftl 자동 등록함) ─────────────
  _injectFTL() {
    try {
      const win = (typeof Zotero !== "undefined" && Zotero.getMainWindow)
        ? Zotero.getMainWindow()
        : null;
      if (win && win.MozXULElement && typeof win.MozXULElement.insertFTLIfNeeded === "function") {
        win.MozXULElement.insertFTLIfNeeded("paperflow.ftl");
        this._log("paperflow.ftl injected via insertFTLIfNeeded");
      }
    } catch (e) {
      this._warn(`FTL inject best-effort failed (relying on Zotero auto plugin FTL): ${e.message}`);
    }
  },

  // ── 로깅 (Error Console에서도 보이게) ─────────────────────────────────────
  _clog(msg) {
    const text = `[PaperFlow] ${msg}`;
    try { Zotero.debug(text); } catch (_) { }
    try { Services.console.logStringMessage(text); }
    catch (_) { try { Components.utils.reportError(text); } catch (__) { } }
  },

  _log(msg) {
    try {
      if (typeof PTLogger !== "undefined") PTLogger.info(msg);
      else Zotero.debug(`[PaperFlow] ${msg}`);
    } catch (_) { /* noop */ }
  },

  _warn(msg) {
    try {
      if (typeof PTLogger !== "undefined") PTLogger.warn(msg);
      else Zotero.debug(`[PaperFlow] WARN: ${msg}`);
    } catch (_) { /* noop */ }
  },

  _reportError(label, error) {
    const detail = `[PaperFlow] readerSidebar ${label}: ${error && error.stack ? error.stack : (error && error.message) || String(error)}`;
    try { Zotero.debug(detail); } catch (_) { }
    try { Components.utils.reportError(detail); } catch (_) { }
  },
};
