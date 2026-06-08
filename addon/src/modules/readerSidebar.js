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

  BODY_XHTML: '<paperflow-reader-panel xmlns="http://www.w3.org/1999/xhtml" />',

  _registeredPaneID: null,
  _styleSheetRegistered: false,
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
    } catch (e) {
      this._reportError("registerSection failed", e);
    }
  },

  // ── 해제 ────────────────────────────────────────────────────────────────
  remove() {
    this._unregisterStyleSheet();
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
        this._clog("paperflow-reader-panel define skipped: customElements unavailable");
        return false;
      }
      if (win.customElements.get("paperflow-reader-panel")) {
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
          this._onHostResize = null;
          this._lastHostHeight = 0;
          this._lastHostMaxHeight = 0;
          this._lastChatHeight = 0;
          this._lastViewportHeight = 0;
          this._lastHostTop = null;
          this._lastSectionOpenHeight = 0;
        }

        set item(val) {
          this._item = val;
          this._updateItemUI();
        }

        get item() {
          return this._item;
        }

        connectedCallback() {
          if (this._rendered) {
            this._wireHostResize();
            this._applyLayoutSizing();
            this._updateItemUI();
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
          try {
            const w = this.ownerDocument && this.ownerDocument.defaultView;
            if (w && this._onHostResize) {
              w.removeEventListener("resize", this._onHostResize);
              this._onHostResize = null;
            }
          } catch (_) { /* noop */ }
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
            const root = this.querySelector("#pt-root");
            if (!root) return;
            const hostHeight = this.getBoundingClientRect().height || 700;
            const minChat = 160;
            const maxChat = this._getMaxChatHeight(hostHeight, minChat);
            const defaultChat = Math.floor(hostHeight * 0.24);
            let saved = null;
            try {
              saved = parseInt(localStorage.getItem("paperflow-chat-height-v2"), 10);
            } catch (_) { /* noop */ }
            const raw = Number.isInteger(saved) ? saved : defaultChat;
            const chatHeight = Math.max(minChat, Math.min(raw, maxChat));
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

          const chatComposer = doc.createElementNS(xhtmlNS, "div");
          chatComposer.setAttribute("id", "pt-chat-composer");
          chatComposer.setAttribute("class", "pt-chat-composer");

          const chatInput = doc.createElementNS(xhtmlNS, "textarea");
          chatInput.setAttribute("id", "pt-chat-input");
          chatInput.setAttribute("placeholder", "무엇이든 질문하세요.");
          this._chatInput = chatInput;

          const composerActions = doc.createElementNS(xhtmlNS, "div");
          composerActions.setAttribute("class", "pt-composer-actions");

          const composerTools = doc.createElementNS(xhtmlNS, "div");
          composerTools.setAttribute("class", "pt-composer-tools");

          const chatAttach = doc.createElementNS(xhtmlNS, "button");
          chatAttach.setAttribute("id", "pt-chat-attach");
          chatAttach.setAttribute("type", "button");
          chatAttach.setAttribute("class", "pt-icon-btn");
          chatAttach.setAttribute("title", "첨부파일은 이후 버전에서 지원 예정입니다.");
          chatAttach.setAttribute("aria-label", "첨부파일은 이후 버전에서 지원 예정입니다.");
          chatAttach.setAttribute("disabled", "true");
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
          chatComposer.appendChild(composerActions);

          chatSection.appendChild(chatLog);
          chatSection.appendChild(chatComposer);
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

          // Wire Chat Event Listeners
          chatSend.addEventListener("click", () => this._ask());
          chatInput.addEventListener("keydown", (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              this._ask();
            }
          });
        }

        _wireResize() {
          const divider = this.querySelector("#pt-divider");
          const chat = this.querySelector("#pt-chat");
          const rootEl = this.querySelector("#pt-root");
          if (!divider || !chat || !rootEl) return;

          let isDragging = false;
          let isHostDragging = false;
          let startY = 0;
          let startHeight = 0;
          let startHostY = 0;
          let startHostHeight = 0;

          const isNearChatBottom = (e) => {
            const rect = chat.getBoundingClientRect();
            return rect && rect.bottom - e.clientY <= 12;
          };

          const onMouseDown = (e) => {
            isDragging = true;
            startY = e.clientY;
            startHeight = chat.offsetHeight;
            this.ownerDocument.body.style.userSelect = "none";
            divider.classList.add("pt-dragging");
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

            const parentHeight = rootEl.offsetHeight || 520;
            const minHeight = 160;
            const maxHeight = this._getMaxChatHeight(parentHeight, minHeight);

            newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));
            rootEl.style.setProperty('--paperflow-chat-height', newHeight + "px");

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
            this.ownerDocument.body.style.userSelect = "";
            divider.classList.remove("pt-dragging");
          };

          divider.addEventListener("mousedown", onMouseDown);
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
            if (savedHeight) {
              const h = parseInt(savedHeight, 10);
              if (Number.isInteger(h) && h >= 160) {
                const parentHeight = rootEl.offsetHeight || 520;
                const clamped = Math.max(160, Math.min(h, this._getMaxChatHeight(parentHeight, 160)));
                rootEl.style.setProperty('--paperflow-chat-height', clamped + "px");
              } else {
                this._clampChatHeight();
              }
            } else {
              this._clampChatHeight();
            }
          } catch (_) {
            this._clampChatHeight();
          }
        }

        _getMaxChatHeight(containerHeight, minHeight = 160) {
          const height = Math.max(minHeight, Math.floor(Number(containerHeight) || 0));
          const reservedContentHeight = 110;
          const ratioLimit = Math.floor(height * 0.72);
          const reserveLimit = Math.floor(height - reservedContentHeight);
          return Math.max(minHeight, Math.min(ratioLimit, reserveLimit));
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

        _startTranslation() {
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

          this._setStatus("Loading paper data...");
          this._showStatusBadge("missing", "loading");
          this._setContent("Loading...");

          this._chatLog.textContent = "";
          this._appendBubble("assistant", "안녕하세요. 이 논문의 요약과 번역 내용을 바탕으로 답변할 수 있습니다.");
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
                this._chatLog.textContent = "";
                this._appendBubble("assistant", "안녕하세요. 이 논문의 요약과 번역 내용을 바탕으로 답변할 수 있습니다.");

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
            pre.textContent = JSON.stringify(meta || {}, null, 2) || "{}";

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
          const question = (this._chatInput.value || "").trim();
          if (!question) return;

          this._chatSending = true;
          this._chatSend.disabled = true;

          this._appendBubble("user", question);
          const pending = this._appendBubble("assistant", "답변 생성 중...");

          try {
            if (typeof PTChat === "undefined") throw new Error("PTChat is not loaded.");
            if (!this._bundle) throw new Error("번역 결과가 없어 채팅 context를 만들 수 없습니다.");

            const parent = PaperFlowReaderSidebar._resolveParentItem(this._item);
            const title = (parent || this._item)?.getField?.("title") || "제목 없음";

            const answer = await PTChat.ask(question, this._bundle, { title });
            if (pending) pending.textContent = answer;
            this._chatInput.value = "";
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
            "article", "section", "div", "p", "br", "span",
            "h1", "h2", "h3", "h4", "h5", "h6",
            "ul", "ol", "li", "strong", "b", "em", "i",
            "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td",
          ]);
          const outTag = allowed.has(tag) ? tag : "div";
          const out = this.ownerDocument.createElementNS(xhtmlNS, outTag);

          const safeClasses = Array.from(node.classList || [])
            .filter(c => /^(pt-|badge$|partial$|failed$|level-)/.test(c))
            .join(" ");
          if (safeClasses) out.setAttribute("class", safeClasses);

          if (node.hasAttribute("id")) {
            out.setAttribute("id", node.getAttribute("id"));
          }

          this._appendSanitizedChildren(node, out);
          return out;
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

      win.customElements.define("paperflow-reader-panel", PanelElement);
      this._clog("paperflow-reader-panel custom element defined");
      return true;
    } catch (e) {
      this._warn(`paperflow-reader-panel define failed: ${e.message}`);
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
      const panel = body.querySelector ? body.querySelector("paperflow-reader-panel") : null;
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
      const current = Zotero.Prefs.get("sidenav.order") || "";
      let order = current
        ? current.split(",").map((id) => id.trim()).filter(Boolean)
        : this.DEFAULT_SIDENAV_ORDER.slice();

      order = order.filter((id) => id !== this.PANE_ID && id !== this._registeredPaneID);
      order.push(this._registeredPaneID);

      Zotero.Prefs.set("sidenav.order", order.join(","));
      this._clog(`sidenav.order updated (moved to bottom): ${this._registeredPaneID}`);
    } catch (e) {
      this._warn(`sidenav.order update skipped: ${e.message}`);
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
