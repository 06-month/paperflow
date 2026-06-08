"use strict";

// PaperFlow Reader Sidebar PoC — minimal, lifecycle-correct version.
//
// Zotero item pane virtualizes custom sections: an IntersectionObserver in
// itemDetails.js calls section.render() when the pane scrolls into view and
// section.discard() (empties the body) when it scrolls out of view
// (itemDetails.js `_handleIntersection`). So an off-screen PaperFlow section
// legitimately has no `data-type="body"` content — that is NOT a bug.
//
// Therefore we do not try to keep an off-screen body alive. We provide a static
// `bodyXHTML` skeleton (re-injected by Zotero on each render) and fill its rows
// in onRender. When the section is visible, the body exists and shows; when
// off-screen it is discarded and rebuilt on next view.
//
// TODO: replace icons with dedicated 16/20px assets; replace the debug blue
//       border once the real Summary/Translation/Chat UI is ported.
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

  // zoteropdftranslate와 같은 패턴: Zotero가 만든 body 안에 custom element
  // 하나만 제공한다. 실제 내용은 custom element connectedCallback에서 구성.
  BODY_XHTML: '<paperflow-reader-panel xmlns="http://www.w3.org/1999/xhtml" />',

  _registeredPaneID: null,
  _styleSheetRegistered: false,
  _postRenderTimers: [],
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

    this._injectFTL();          // best-effort; Zotero also auto-loads locale/*.ftl
    this._registerStyleSheet(); // gray→blue active state (best-effort)
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
        sectionButtons: [
          {
            type: "openStandalone",
            icon: this.SECTION_BUTTON_ICON,
            onClick: (props) => this._onSectionButtonClick("openStandalone", props),
          },
          {
            type: "fullHeight",
            icon: this.SECTION_BUTTON_ICON,
            onClick: (props) => this._onSectionButtonClick("fullHeight", props),
          },
        ],
      };
      this._logSectionDefinition(sectionDefinition);
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
    this._clearPostRenderChecks();
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
        this._clog("paperflow-reader-panel already defined");
        return true;
      }

      const xhtmlNS = this.XHTML_NS;
      const PanelElement = class extends win.HTMLElement {
        connectedCallback() {
          if (this.firstChild) return;
          const doc = this.ownerDocument;
          const root = doc.createElementNS(xhtmlNS, "div");
          root.setAttribute("class", "paperflow-reader-poc-root");
          root.setAttribute("data-paperflow-poc", "true");
          const title = doc.createElementNS(xhtmlNS, "div");
          title.setAttribute("class", "paperflow-reader-poc-title");
          title.textContent = "PaperFlow Static Body";
          root.appendChild(title);
          this.appendChild(root);
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

  _logSectionDefinition(definition) {
    try {
      const keys = Object.keys(definition || {});
      const header = definition && definition.header;
      const sidenav = definition && definition.sidenav;
      const bodyXHTML = definition && definition.bodyXHTML;
      const sectionButtons = definition && definition.sectionButtons;
      this._clog(`section definition: keys=${keys.join(",")} paneID=${definition && definition.paneID} pluginID=${definition && definition.pluginID} headerType=${typeof header} headerValueTypes=${this._objectValueTypes(header)} sidenavType=${typeof sidenav} sidenavValueTypes=${this._objectValueTypes(sidenav)} bodyXHTMLExists=${typeof bodyXHTML === "string"} bodyXHTMLLength=${typeof bodyXHTML === "string" ? bodyXHTML.length : 0} sectionButtons=${this._sectionButtonsSummary(sectionButtons)} onInit=${typeof (definition && definition.onInit) === "function"} onDestroy=${typeof (definition && definition.onDestroy) === "function"} onRender=${typeof (definition && definition.onRender) === "function"} onAsyncRender=${typeof (definition && definition.onAsyncRender) === "function"} onItemChange=${typeof (definition && definition.onItemChange) === "function"}`);
      if (typeof bodyXHTML === "string") {
        this._clog(`section definition bodyXHTML preview=${bodyXHTML.slice(0, 1000)}`);
      }
    } catch (e) {
      this._warn(`section definition log failed: ${e.message}`);
    }
  },

  _objectValueTypes(object) {
    try {
      if (!object || typeof object !== "object") return "";
      return Object.keys(object).map((key) => `${key}:${typeof object[key]}`).join(",");
    } catch (_) {
      return "";
    }
  },

  _sectionButtonsSummary(buttons) {
    try {
      if (!Array.isArray(buttons)) return "";
      return buttons.map((button) => {
        const type = button && button.type;
        const icon = button && button.icon;
        const clickType = typeof (button && button.onClick);
        return `${type || "?"}{icon:${typeof icon},onClick:${clickType}}`;
      }).join(",");
    } catch (_) {
      return "";
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
    const renderBodyId = this._markRenderBody(body);
    const document_ = doc || body.ownerDocument || null;
    try {
      this._ensureReaderPanelElement(document_);
      const panel = body.querySelector ? body.querySelector("paperflow-reader-panel") : null;
      if (panel) panel.item = item || null;
      this._clog(`onRender custom-element: panelExists=${!!panel}`);
      this._logBodyTimelineState("onRender-custom-element", body, renderBodyId, document_);
      this._logSectionStructureComparison(document_, "onRender-custom-element", body);
    } catch (e) {
      this._reportError("onRender diagnostic failed", e);
    }
    // onRender 진단은 유지하되, 삽입/채우기는 하지 않는다.
    this._scheduleBodyTimelineChecks(body, renderBodyId, document_, "onRender");
    this._schedulePostRenderChecks(body, renderBodyId, "onRender");
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

  // 단순 scrollIntoView. 섹션 전체 우선.
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

  _ensureOpen(body) {
    const section = this._getSectionFromProps({ body });
    if (!section) {
      this._clog("ensureOpen: section not found");
      return;
    }

    try {
      this._ensureOpenPref(section.dataset ? section.dataset.pane : null);
      if (section.hasAttribute && section.hasAttribute("empty")) {
        section.removeAttribute("empty");
      }
      if ("open" in section) {
        section.open = true;
      } else if (section.setAttribute) {
        section.setAttribute("open", "");
      }
      const paneID = section.dataset ? section.dataset.pane : "?";
      this._clog(`ensureOpen: paneID=${paneID} open=${this._isSectionOpen(section)} empty=${section.hasAttribute ? section.hasAttribute("empty") : "?"}`);
    } catch (e) {
      this._warn(`ensureOpen failed: ${e.message}`);
    }
  },

  // ── post-render 진단 (로그 전용) ──────────────────────────────────────────
  _schedulePostRenderChecks(body, renderBodyId, phase) {
    const doc = body.ownerDocument || null;
    const win = doc && doc.defaultView;
    if (!win) return;
    for (const ms of [250, 1000, 2500]) {
      try {
        const id = win.setTimeout(() => {
          try {
            const section = this._findPaperFlowSection(doc, body);
            const cur = this._findPaperFlowBody(doc, section, body, renderBodyId);
            const root = doc && doc.querySelector ? doc.querySelector('[data-paperflow-poc="true"]') : null;
            const panel = doc && doc.querySelector ? doc.querySelector("paperflow-reader-panel") : null;
            const rowsEl = doc && doc.querySelector ? doc.querySelector('[data-paperflow-poc-body="true"]') : null;
            const rowsTextLen = rowsEl ? (rowsEl.textContent || "").length : 0;
            const rect = section && section.getBoundingClientRect ? section.getBoundingClientRect() : null;
            const viewportHeight = win && win.innerHeight ? Math.round(win.innerHeight) : "?";
            const paneID = section && section.dataset ? section.dataset.pane : "?";
            const sectionOpen = section ? this._isSectionOpen(section) : "?";
            const markedBody = this._findRenderBodyById(doc, renderBodyId);
            this._logBodyTimelineState(`${phase || "unknown"}-post-render-${ms}`, body, renderBodyId, doc);
            this._clog(`post-render check phase=${phase || "unknown"} t=${ms} renderBodyId=${renderBodyId} paneID=${paneID} bodyExists=${!!cur} renderBodyFound=${!!markedBody} panelExists=${!!panel} rootExists=${!!root} rowsTextLen=${rowsTextLen} sectionConnected=${section ? section.isConnected : "?"} sectionLocalName=${section ? section.localName : "?"} sectionCtor=${section && section.constructor ? section.constructor.name : "?"} sectionChildNodes=${section ? section.childNodes.length : "?"} sectionChildren=${section ? section.children.length : "?"} sectionTextLen=${this._textLength(section)} sectionMarkupLen=${this._markupLength(section)} sectionOpen=${sectionOpen} empty=${section ? section.hasAttribute("empty") : "?"} sectionTop=${rect ? Math.round(rect.top) : "?"} sectionHeight=${rect ? Math.round(rect.height) : "?"} viewportHeight=${viewportHeight}`);
            this._logRootLocation(doc, root, rowsEl);
            this._logRenderBodyLocation(markedBody);
            this._logSectionDetails(section, "post-render section");
            this._logCustomSectionDetails(doc, body);
            this._logViewportDiagnostics(doc, section, cur);
            if (ms === 250) {
              this._logPaperFlowDOMScan(doc, renderBodyId);
            }
            if (section && !sectionOpen) {
              this._warn("PaperFlow section is collapsed; body may be discarded");
            }
            // 주의: 여기서는 상태만 관찰한다. off-screen discard는 정상 동작.
          } catch (e) {
            this._warn(`post-render check t=${ms} failed: ${e.message}`);
          }
        }, ms);
        this._postRenderTimers.push({ win, id });
      } catch (_) { /* noop */ }
    }
  },

  _scheduleBodyTimelineChecks(body, renderBodyId, doc, phase) {
    try {
      const win = (doc && doc.defaultView) || (body && body.ownerDocument && body.ownerDocument.defaultView);
      if (!win) {
        this._clog("body timeline schedule skipped: no window");
        return;
      }

      const run = (label) => {
        try {
          this._logBodyTimelineState(`${phase || "unknown"}-${label}`, body, renderBodyId, doc || body.ownerDocument || null);
        } catch (e) {
          this._warn(`body timeline ${label} failed: ${e.message}`);
        }
      };

      if (typeof win.queueMicrotask === "function") {
        win.queueMicrotask(() => run("queueMicrotask"));
      } else {
        Promise.resolve().then(() => run("promise-microtask")).catch((e) => {
          this._warn(`body timeline promise-microtask failed: ${e.message}`);
        });
      }

      if (typeof win.requestAnimationFrame === "function") {
        win.requestAnimationFrame(() => run("requestAnimationFrame"));
      } else {
        this._clog("body timeline requestAnimationFrame unavailable");
      }

      this._logComparisonOuterHTML(doc || body.ownerDocument || null, `${phase || "unknown"}-before-setTimeout-0`, body);
      win.setTimeout(() => {
        this._logComparisonOuterHTML(doc || body.ownerDocument || null, `${phase || "unknown"}-setTimeout-0-before-timeline`, body);
        run("setTimeout-0");
        this._logComparisonOuterHTML(doc || body.ownerDocument || null, `${phase || "unknown"}-after-setTimeout-0`, body);
        this._logSectionStructureComparison(doc || body.ownerDocument || null, `${phase || "unknown"}-after-setTimeout-0`, body);
      }, 0);
      win.setTimeout(() => run("setTimeout-50"), 50);
    } catch (e) {
      this._warn(`body timeline schedule failed: ${e.message}`);
    }
  },

  _logBodyTimelineState(label, body, renderBodyId, doc) {
    try {
      const document_ = doc || (body && body.ownerDocument) || null;
      const foundById = this._findRenderBodyById(document_, renderBodyId);
      const parent = body && body.parentElement ? body.parentElement : null;
      const rootNode = body && body.getRootNode ? body.getRootNode() : null;
      const sameObject = !!(foundById && body && foundById === body);
      this._clog(`body timeline ${label}: renderBodyId=${renderBodyId} bodyObjectExists=${!!body} bodyObjectConnected=${body ? !!body.isConnected : "?"} foundById=${!!foundById} foundByIdSameObject=${sameObject} parentLocalName=${parent ? parent.localName : "null"} parentCtor=${parent && parent.constructor ? parent.constructor.name : "null"} parentDataPane=${this._dataPane(parent)} rootNodeCtor=${rootNode && rootNode.constructor ? rootNode.constructor.name : "null"} childNodes=${body && body.childNodes ? body.childNodes.length : "?"} children=${body && body.children ? body.children.length : "?"} textLen=${this._textLength(body)} innerHTMLLen=${this._innerHTMLLength(body)} outerHTMLPreview=${this._outerHTMLPreview(body)}`);
      this._logBodyParentChain(label, body);
    } catch (e) {
      this._warn(`body timeline ${label} log failed: ${e.message}`);
    }
  },

  _logBodyParentChain(label, body) {
    try {
      if (!body || !body.parentElement) {
        this._clog(`body parent chain ${label}: parent=false`);
        return;
      }
      let node = body.parentElement;
      let depth = 0;
      while (node && depth < 12) {
        this._clog(`body parent chain ${label} depth=${depth} localName=${node.localName || "?"} ctor=${node.constructor ? node.constructor.name : "?"} dataPane=${this._dataPane(node)} class=${this._className(node)} childNodes=${node.childNodes ? node.childNodes.length : "?"} children=${node.children ? node.children.length : "?"} textLen=${this._textLength(node)} innerHTMLLen=${this._innerHTMLLength(node)}`);
        if (node.localName === "collapsible-section") break;
        node = node.parentElement;
        depth++;
      }
      if (!node) {
        this._clog(`body parent chain ${label}: reached document root before collapsible-section`);
      }
    } catch (e) {
      this._warn(`body parent chain ${label} failed: ${e.message}`);
    }
  },

  _markRenderBody(body) {
    const renderBodyId = `${Date.now()}-${++this._renderBodySeq}`;
    this._clog(`renderBodyId local-only=${renderBodyId} bodyConnected=${body ? !!body.isConnected : "?"}`);
    return renderBodyId;
  },

  _patchCustomSectionLifecycle(body) {
    try {
      const custom = body && body.closest ? body.closest("item-pane-custom-section") : null;
      if (!custom || custom._paperflowPatched) return;

      const paneID = custom.dataset ? custom.dataset.pane : "";
      const originalRender = typeof custom.render === "function" ? custom.render : null;
      if (originalRender) {
        custom.render = function(...args) {
          try {
            PaperFlowReaderSidebar._clog(`custom section render called paneID=${paneID} connected=${!!this.isConnected} hidden=${!!this.hidden}`);
          } catch (_) { /* noop */ }
          return originalRender.apply(this, args);
        };
      }

      const originalDiscard = typeof custom.discard === "function" ? custom.discard : null;
      if (originalDiscard) {
        custom.discard = function(...args) {
          try {
            PaperFlowReaderSidebar._clog(`custom section discard called paneID=${paneID} connected=${!!this.isConnected} hidden=${!!this.hidden}`);
          } catch (_) { /* noop */ }
          return originalDiscard.apply(this, args);
        };
      } else {
        this._clog(`custom section discard method unavailable paneID=${paneID}`);
      }

      custom._paperflowPatched = true;
      this._clog(`custom section lifecycle patched paneID=${paneID} hasRender=${!!originalRender} hasDiscard=${!!originalDiscard}`);
    } catch (e) {
      this._warn(`custom section lifecycle patch failed: ${e.message}`);
    }
  },

  _findPaperFlowSection(doc, body) {
    try {
      if (doc && doc.querySelectorAll) {
        const sections = Array.from(doc.querySelectorAll("collapsible-section[data-pane]"));
        const exact = sections.find((node) => this._paneIDEquals(node.dataset && node.dataset.pane));
        if (exact) return exact;
        const matched = sections.find((node) => this._matchesPaperFlowPane(node.dataset && node.dataset.pane));
        if (matched) return matched;

        const customSections = Array.from(doc.querySelectorAll("item-pane-custom-section[data-pane]"));
        const customExact = customSections.find((node) => this._paneIDEquals(node.dataset && node.dataset.pane));
        const customMatch = customExact || customSections.find((node) => this._matchesPaperFlowPane(node.dataset && node.dataset.pane));
        const nested = customMatch && customMatch.querySelector ? customMatch.querySelector("collapsible-section") : null;
        if (nested) return nested;
      }

      const closest = this._getSectionFromProps({ body });
      if (closest && closest.localName === "collapsible-section") return closest;
      if (closest && closest.querySelector) {
        const nested = closest.querySelector("collapsible-section");
        if (nested) return nested;
      }

      const root = doc && doc.querySelector ? doc.querySelector('[data-paperflow-poc="true"]') : null;
      if (root) {
        const rootSection = root.closest("collapsible-section");
        if (rootSection) return rootSection;
        const rootCustom = root.closest("item-pane-custom-section");
        if (rootCustom && rootCustom.querySelector) return rootCustom.querySelector("collapsible-section") || rootCustom;
      }
    } catch (e) {
      this._warn(`findPaperFlowSection failed: ${e.message}`);
    }
    return null;
  },

  _findPaperFlowBody(doc, section, body, renderBodyId) {
    try {
      const marked = this._findRenderBodyById(doc, renderBodyId);
      if (marked) return marked;
      if (body && body.isConnected) return body;

      const root = doc && doc.querySelector ? doc.querySelector('[data-paperflow-poc="true"]') : null;
      if (root) {
        const rootBody = root.closest('[data-type="body"]');
        if (rootBody) return rootBody;
      }

      if (section && section.querySelector) {
        const sectionBody = section.querySelector('[data-type="body"]');
        if (sectionBody) return sectionBody;
      }

      if (doc && doc.querySelectorAll) {
        const customSections = Array.from(doc.querySelectorAll("item-pane-custom-section[data-pane]"));
        const custom = customSections.find((node) => this._matchesPaperFlowPane(node.dataset && node.dataset.pane));
        if (custom && custom.querySelector) {
          return custom.querySelector('[data-type="body"]');
        }
      }
    } catch (e) {
      this._warn(`findPaperFlowBody failed: ${e.message}`);
    }
    return null;
  },

  _findRenderBodyById(doc, renderBodyId) {
    return null;
  },

  _logRootLocation(doc, root, rowsEl) {
    try {
      const directRoot = doc && doc.querySelector ? doc.querySelector('[data-paperflow-poc="true"]') : null;
      const directRows = doc && doc.querySelector ? doc.querySelector('[data-paperflow-poc-body="true"]') : null;
      const actualRoot = root || directRoot;
      const actualRows = rowsEl || directRows;
      if (!actualRoot) {
        this._clog("paperflow root location: found=false");
        return;
      }
      const rootSection = actualRoot.closest("collapsible-section");
      const rootCustom = actualRoot.closest("item-pane-custom-section");
      this._clog(`paperflow root location: found=true root=${this._describeNode(actualRoot)} rowsTextLen=${this._textLength(actualRows)} closestSectionPane=${this._dataPane(rootSection)} closestCustomPane=${this._dataPane(rootCustom)}`);
    } catch (e) {
      this._warn(`paperflow root location log failed: ${e.message}`);
    }
  },

  _logRenderBodyLocation(markedBody) {
    try {
      if (!markedBody) {
        this._clog("renderBodyId location: found=false");
        return;
      }
      this._clog(`renderBodyId location: found=true body=${this._describeNode(markedBody)}`);
    } catch (e) {
      this._warn(`renderBodyId location log failed: ${e.message}`);
    }
  },

  _logSectionDetails(section, label) {
    try {
      if (!section) {
        this._clog(`${label}: found=false`);
        return;
      }
      const rootNode = section.getRootNode ? section.getRootNode() : null;
      const parent = section.parentElement || null;
      const previous = section.previousElementSibling || null;
      const next = section.nextElementSibling || null;
      this._clog(`${label}: found=true ${this._describeNode(section)} rootNodeCtor=${rootNode && rootNode.constructor ? rootNode.constructor.name : "?"} shadowRoot=${!!section.shadowRoot} parent=${this._nodeShort(parent)} previous=${this._nodeShort(previous)} next=${this._nodeShort(next)}`);
    } catch (e) {
      this._warn(`${label} detail log failed: ${e.message}`);
    }
  },

  _logCustomSectionDetails(doc, body) {
    try {
      const custom = this._findCustomSection(doc, body);
      if (!custom) {
        this._clog("custom section details: found=false");
        return;
      }
      this._clog(`custom section details: found=true ${this._describeNode(custom)} hiddenProp=${!!custom.hidden} renderFn=${typeof custom.render === "function"} asyncRenderFn=${typeof custom.asyncRender === "function"} discardFn=${typeof custom.discard === "function"}`);
    } catch (e) {
      this._warn(`custom section detail log failed: ${e.message}`);
    }
  },

  _logViewportDiagnostics(doc, section, bodyNode) {
    try {
      if (!doc || !doc.defaultView || !section || !section.getBoundingClientRect) {
        this._clog("intersection diagnostics: unavailable");
        return;
      }
      const win = doc.defaultView;
      const sectionRect = section.getBoundingClientRect();
      const custom = this._findCustomSection(doc, bodyNode || section);
      const customRect = custom && custom.getBoundingClientRect ? custom.getBoundingClientRect() : null;
      const scroller = this._findPaneScroller(section);
      const scrollerRect = scroller && scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : null;
      const viewportRect = { top: 0, bottom: win.innerHeight || 0, height: win.innerHeight || 0 };
      const rootRect = scrollerRect || viewportRect;
      const sectionVisible = sectionRect.bottom > rootRect.top && sectionRect.top < rootRect.bottom;
      const customVisible = customRect ? (customRect.bottom > rootRect.top && customRect.top < rootRect.bottom) : "?";
      const centerX = Math.max(0, Math.round(sectionRect.left + Math.max(1, sectionRect.width || 1) / 2));
      const centerY = Math.max(0, Math.round(sectionRect.top + Math.max(1, sectionRect.height || 1) / 2));
      const pointNode = doc.elementFromPoint ? doc.elementFromPoint(centerX, centerY) : null;
      this._clog(`intersection diagnostics: sectionRect=${this._rectObject(sectionRect)} customRect=${customRect ? this._rectObject(customRect) : "?"} scroller=${this._nodeShort(scroller)} scrollerRect=${scrollerRect ? this._rectObject(scrollerRect) : "?"} viewportHeight=${Math.round(viewportRect.height)} sectionVisible=${sectionVisible} customVisible=${customVisible} elementFromCenter=${this._nodeShort(pointNode)}`);
    } catch (e) {
      this._warn(`intersection diagnostics failed: ${e.message}`);
    }
  },

  _findCustomSection(doc, node) {
    try {
      if (node && node.closest) {
        const closest = node.closest("item-pane-custom-section");
        if (closest && this._matchesPaperFlowPane(closest.dataset && closest.dataset.pane)) return closest;
      }
      if (doc && doc.querySelectorAll) {
        const customSections = Array.from(doc.querySelectorAll("item-pane-custom-section[data-pane]"));
        return customSections.find((candidate) => this._paneIDEquals(candidate.dataset && candidate.dataset.pane))
          || customSections.find((candidate) => this._matchesPaperFlowPane(candidate.dataset && candidate.dataset.pane))
          || null;
      }
    } catch (_) { /* noop */ }
    return null;
  },

  _findPaneScroller(node) {
    try {
      if (!node || !node.closest) return null;
      return node.closest("#zotero-view-item")
        || node.closest(".zotero-view-item")
        || node.closest("item-details")
        || node.closest("context-pane");
    } catch (_) {
      return null;
    }
  },

  _logPaperFlowDOMScan(doc, renderBodyId) {
    try {
      if (!doc || !doc.querySelectorAll) {
        this._clog("PaperFlow DOM scan: document unavailable");
        return;
      }
      const nodes = this._collectPaperFlowNodes(doc);
      this._clog(`PaperFlow DOM scan: renderBodyId=${renderBodyId} nodes=${nodes.length}`);
      nodes.forEach((node, index) => {
        this._clog(`PaperFlow DOM scan node[${index}]: ${this._describeNode(node)} parent=${this._nodeShort(node.parentElement)}`);
      });
    } catch (e) {
      this._warn(`PaperFlow DOM scan failed: ${e.message}`);
    }
  },

  _logSectionStructureComparison(doc, label, body) {
    try {
      if (!doc || !doc.querySelectorAll) {
        this._clog(`section structure comparison ${label}: document unavailable`);
        return;
      }
      const paperflow = this._findComparisonNodes(doc, "paperflow", body);
      const zpt = this._findComparisonNodes(doc, "zoteropdftranslate", body);
      const paperflowPanel = doc.querySelector ? doc.querySelector("paperflow-reader-panel") : null;
      this._clog(`section structure comparison ${label}: paperflowCustom=${!!paperflow.custom} paperflowCollapsible=${!!paperflow.collapsible} paperflowPanel=${!!paperflowPanel} zoteropdftranslateCustom=${!!zpt.custom} zoteropdftranslateCollapsible=${!!zpt.collapsible}`);
      this._logOneSectionStructure(label, "PaperFlow", paperflow.custom, paperflow.collapsible);
      this._logOneSectionStructure(label, "zoteropdftranslate", zpt.custom, zpt.collapsible);
    } catch (e) {
      this._warn(`section structure comparison ${label} failed: ${e.message}`);
    }
  },

  _logComparisonOuterHTML(doc, label, body) {
    try {
      if (!doc || !doc.querySelectorAll) {
        this._clog(`comparison outerHTML ${label}: document unavailable`);
        return;
      }
      const paperflow = this._findComparisonNodes(doc, "paperflow", body);
      const zpt = this._findComparisonNodes(doc, "zoteropdftranslate", body);
      this._clog(`comparison outerHTML ${label} PaperFlow collapsible found=${!!paperflow.collapsible} preview=${this._outerHTMLPreviewLimit(paperflow.collapsible, 2000)}`);
      this._clog(`comparison outerHTML ${label} zoteropdftranslate collapsible found=${!!zpt.collapsible} preview=${this._outerHTMLPreviewLimit(zpt.collapsible, 2000)}`);
    } catch (e) {
      this._warn(`comparison outerHTML ${label} failed: ${e.message}`);
    }
  },

  _findComparisonNodes(doc, kind, body) {
    const result = { custom: null, collapsible: null };
    try {
      if (kind === "paperflow") {
        result.custom = this._findCustomSection(doc, body);
        result.collapsible = this._findPaperFlowSection(doc, body);
      } else {
        result.custom = this._findZoteroPDFTranslateCustomSection(doc);
        result.collapsible = this._findZoteroPDFTranslateCollapsibleSection(doc, result.custom);
      }
      if (!result.collapsible && result.custom && result.custom.querySelector) {
        result.collapsible = result.custom.querySelector("collapsible-section");
      }
      if (!result.custom && result.collapsible && result.collapsible.closest) {
        result.custom = result.collapsible.closest("item-pane-custom-section");
      }
    } catch (e) {
      this._warn(`find comparison nodes failed kind=${kind}: ${e.message}`);
    }
    return result;
  },

  _findZoteroPDFTranslateCustomSection(doc) {
    try {
      const customSections = Array.from(doc.querySelectorAll("item-pane-custom-section"));
      return customSections.find((node) => this._matchesZoteroPDFTranslateNode(node)) || null;
    } catch (_) {
      return null;
    }
  },

  _findZoteroPDFTranslateCollapsibleSection(doc, custom) {
    try {
      if (custom && custom.querySelector) {
        const nested = custom.querySelector("collapsible-section");
        if (nested) return nested;
      }
      const sections = Array.from(doc.querySelectorAll("collapsible-section"));
      return sections.find((node) => this._matchesZoteroPDFTranslateNode(node)) || null;
    } catch (_) {
      return null;
    }
  },

  _matchesZoteroPDFTranslateNode(node) {
    try {
      if (!node) return false;
      const terms = ["zoteropdftranslate", "zotero-pdf-translate", "pdftranslate", "pdf-translate"];
      const dataPane = (this._dataPane(node) || "").toLowerCase();
      const l10n = (this._l10nID(node) || "").toLowerCase();
      const cls = (this._className(node) || "").toLowerCase();
      const text = (node.textContent || "").toLowerCase();
      return terms.some((term) => dataPane.includes(term) || l10n.includes(term) || cls.includes(term) || text.includes(term));
    } catch (_) {
      return false;
    }
  },

  _logOneSectionStructure(label, name, custom, collapsible) {
    try {
      this._clog(`section structure ${label} ${name} custom found=${!!custom} childNodes=${custom && custom.childNodes ? custom.childNodes.length : "?"} children=${custom && custom.children ? custom.children.length : "?"} outerHTML1500=${this._outerHTMLPreviewLimit(custom, 1500)}`);
      this._logDirectChildren(label, `${name} custom`, custom);
      this._clog(`section structure ${label} ${name} collapsible found=${!!collapsible} childNodes=${collapsible && collapsible.childNodes ? collapsible.childNodes.length : "?"} children=${collapsible && collapsible.children ? collapsible.children.length : "?"} outerHTML1500=${this._outerHTMLPreviewLimit(collapsible, 1500)}`);
      this._logDirectChildren(label, `${name} collapsible`, collapsible);
      this._logSelectorComparison(label, name, custom, collapsible);
    } catch (e) {
      this._warn(`section structure ${label} ${name} failed: ${e.message}`);
    }
  },

  _logDirectChildren(label, name, node) {
    try {
      if (!node || !node.childNodes) {
        this._clog(`section children ${label} ${name}: node=false`);
        return;
      }
      Array.from(node.childNodes).forEach((child, index) => {
        this._clog(`section children ${label} ${name} index=${index} ${this._childNodeSummary(child)}`);
      });
    } catch (e) {
      this._warn(`section children ${label} ${name} failed: ${e.message}`);
    }
  },

  _logSelectorComparison(label, name, custom, collapsible) {
    const selectors = [
      '[data-type="body"]',
      ".body",
      ".content",
      ".section-body",
      "[slot]",
      "[hidden]",
      "[data-pane]",
      "paperflow-reader-panel",
    ];
    for (const selector of selectors) {
      try {
        const customMatches = this._queryWithinIncludingSelf(custom, selector);
        const collapsibleMatches = this._queryWithinIncludingSelf(collapsible, selector);
        this._clog(`section selector ${label} ${name} selector=${selector} customCount=${customMatches.length} customFirst=${this._nodeShort(customMatches[0])} collapsibleCount=${collapsibleMatches.length} collapsibleFirst=${this._nodeShort(collapsibleMatches[0])}`);
      } catch (e) {
        this._warn(`section selector ${label} ${name} selector=${selector} failed: ${e.message}`);
      }
    }
  },

  _queryWithinIncludingSelf(node, selector) {
    const matches = [];
    try {
      if (!node) return matches;
      if (node.matches && node.matches(selector)) matches.push(node);
      if (node.querySelectorAll) {
        for (const child of node.querySelectorAll(selector)) matches.push(child);
      }
    } catch (_) { /* noop */ }
    return matches;
  },

  _childNodeSummary(node) {
    if (!node) return "node=null";
    return [
      `localName=${node.localName || "?"}`,
      `ctor=${node.constructor ? node.constructor.name : "?"}`,
      `namespaceURI=${node.namespaceURI || ""}`,
      `dataType=${node.getAttribute ? (node.getAttribute("data-type") || "") : ""}`,
      `dataPane=${this._dataPane(node)}`,
      `class=${this._className(node)}`,
      `extraButtons=${node.getAttribute ? (node.getAttribute("extra-buttons") || "") : ""}`,
      `styleAttr=${node.getAttribute ? (node.getAttribute("style") || "") : ""}`,
      `textLen=${this._textLength(node)}`,
      `innerHTMLLen=${this._innerHTMLLength(node)}`,
    ].join(" ");
  },

  _collectPaperFlowNodes(doc) {
    const nodes = new Set();
    const addAll = (selector, filter) => {
      try {
        for (const node of doc.querySelectorAll(selector)) {
          if (!filter || filter(node)) nodes.add(node);
        }
      } catch (_) { /* noop */ }
    };
    addAll('[data-pane*="paperflow"]');
    addAll('[data-l10n-id*="paperflow"]');
    addAll("[data-paperflow-poc]");
    addAll("[data-paperflow-poc-body]");
    addAll("paperflow-reader-panel");
    addAll("item-pane-custom-section");
    addAll("collapsible-section[data-pane]", (node) => this._matchesPaperFlowPane(node.dataset && node.dataset.pane));
    return Array.from(nodes);
  },

  _describeNode(node) {
    if (!node) return "null";
    const rect = this._rectSummary(node);
    const style = this._styleSummary(node);
    return [
      `localName=${node.localName || "?"}`,
      `ctor=${node.constructor ? node.constructor.name : "?"}`,
      `dataPane=${this._dataPane(node)}`,
      `l10n=${this._l10nID(node)}`,
      `class=${node.getAttribute ? (node.getAttribute("class") || "") : ""}`,
      `extraButtons=${node.getAttribute ? (node.getAttribute("extra-buttons") || "") : ""}`,
      `connected=${!!node.isConnected}`,
      `hiddenAttr=${node.hasAttribute ? node.hasAttribute("hidden") : "?"}`,
      `hiddenProp=${"hidden" in node ? !!node.hidden : "?"}`,
      `childNodes=${node.childNodes ? node.childNodes.length : "?"}`,
      `children=${node.children ? node.children.length : "?"}`,
      `textLen=${this._textLength(node)}`,
      `markupLen=${this._markupLength(node)}`,
      `rect=${rect}`,
      `style=${style}`,
      `renderFn=${typeof node.render === "function"}`,
      `asyncRenderFn=${typeof node.asyncRender === "function"}`,
      `discardFn=${typeof node.discard === "function"}`,
      `shadowRoot=${!!node.shadowRoot}`,
    ].join(" ");
  },

  _nodeShort(node) {
    if (!node) return "null";
    return `${node.localName || "?"}[dataPane=${this._dataPane(node)} class=${node.getAttribute ? (node.getAttribute("class") || "") : ""} extraButtons=${node.getAttribute ? (node.getAttribute("extra-buttons") || "") : ""}]`;
  },

  _rectSummary(node) {
    try {
      if (!node || !node.getBoundingClientRect) return "n/a";
      const rect = node.getBoundingClientRect();
      return `top:${Math.round(rect.top)},height:${Math.round(rect.height)}`;
    } catch (_) {
      return "n/a";
    }
  },

  _rectObject(rect) {
    if (!rect) return "?";
    return `top:${Math.round(rect.top)},bottom:${Math.round(rect.bottom)},height:${Math.round(rect.height)}`;
  },

  _styleSummary(node) {
    try {
      if (!node || !node.ownerDocument || !node.ownerDocument.defaultView) return "n/a";
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      return `display:${style.display},visibility:${style.visibility}`;
    } catch (_) {
      return "n/a";
    }
  },

  _textLength(node) {
    try {
      return node ? (node.textContent || "").length : 0;
    } catch (_) {
      return 0;
    }
  },

  _markupLength(node) {
    try {
      if (!node) return 0;
      const prop = "inner" + "HTML";
      return (node[prop] || "").length;
    } catch (_) {
      return 0;
    }
  },

  _innerHTMLLength(node) {
    try {
      return node && typeof node.innerHTML === "string" ? node.innerHTML.length : 0;
    } catch (_) {
      return 0;
    }
  },

  _outerHTMLPreview(node) {
    try {
      if (!node || typeof node.outerHTML !== "string") return "";
      return node.outerHTML.slice(0, 500).replace(/\s+/g, " ");
    } catch (_) {
      return "";
    }
  },

  _outerHTMLPreviewLimit(node, limit) {
    try {
      if (!node || typeof node.outerHTML !== "string") return "";
      return node.outerHTML.slice(0, limit || 500).replace(/\s+/g, " ");
    } catch (_) {
      return "";
    }
  },

  _className(node) {
    try {
      if (!node) return "";
      if (node.getAttribute) return node.getAttribute("class") || "";
      return String(node.className || "");
    } catch (_) {
      return "";
    }
  },

  _dataPane(node) {
    try {
      return node && node.dataset ? (node.dataset.pane || "") : "";
    } catch (_) {
      return "";
    }
  },

  _l10nID(node) {
    try {
      return node && node.dataset ? (node.dataset.l10nId || "") : "";
    } catch (_) {
      return "";
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

  _paneIDEquals(paneID) {
    return !!paneID && !!this._registeredPaneID && paneID === this._registeredPaneID;
  },

  _isSectionOpen(section) {
    if (!section) return false;
    try {
      if ("open" in section) return !!section.open;
      return section.hasAttribute && section.hasAttribute("open");
    } catch (_) {
      return false;
    }
  },

  _clearPostRenderChecks() {
    if (!this._postRenderTimers || !this._postRenderTimers.length) return;
    for (const t of this._postRenderTimers) {
      try { t.win.clearTimeout(t.id); } catch (_) { /* noop */ }
    }
    this._postRenderTimers = [];
  },

  _ensureOpenPref(paneID) {
    try {
      const id = paneID || this._registeredPaneID;
      if (!id || typeof Zotero === "undefined" || !Zotero.Prefs) return;
      // Source-confirmed Zotero key:
      // collapsibleSection.js saves/restores `panes.${dataset.pane}.open`.
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
      
      // 기존에 맨 앞(unshift)에 위치했던 값을 필터링하고 맨 뒤로 새로 밀어넣기 위해
      // PANE_ID와 registeredPaneID를 모두 제거한 뒤 push합니다.
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
    try { Zotero.debug(text); } catch (_) {}
    try { Services.console.logStringMessage(text); }
    catch (_) { try { Components.utils.reportError(text); } catch (__) {} }
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
    try { Zotero.debug(detail); } catch (_) {}
    try { Components.utils.reportError(detail); } catch (_) {}
  },
};
