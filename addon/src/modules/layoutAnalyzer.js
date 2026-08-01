"use strict";

/**
 * Build a page-aware document model before translation.
 *
 * The deterministic half mirrors the useful part of pdf2md: every native text
 * item retains a page and normalized bounding box, and every page is rendered
 * once. Gemini sees both representations and returns reading-order blocks. A
 * visual block is cropped from the complete page render, so a composite figure
 * remains one figure even when the PDF stores it as many raster/vector objects.
 */
var PTLayoutAnalyzer = {
  RUNTIME_URI: "chrome://paperflow/content/pdfRuntime.xhtml",
  RUNTIME_FRAME_ID: "paperflow-pdf-runtime-frame",
  RUNTIME_TIMEOUT_MS: 15000,
  RENDER_WIDTH: 1600,
  MAX_PAGES: 100,
  MAX_NATIVE_ITEMS: 900,
  MAX_LAYOUT_RETRIES: 2,
  RETRY_BASE_MS: 2500,
  CMAP_URL: "resource://zotero/reader/pdf/web/cmaps/",
  STANDARD_FONT_URL: "resource://zotero/reader/pdf/web/standard_fonts/",
  WASM_URL: "resource://zotero/reader/pdf/web/wasm/",
  BLOCK_TYPES: new Set([
    "title", "heading", "paragraph", "list", "caption",
    "figure", "table", "equation", "header", "footer", "reference", "other",
  ]),
  TRANSLATABLE_TYPES: new Set(["paragraph", "list", "caption", "reference", "other"]),
  VISUAL_TYPES: new Set(["figure", "table"]),

  _runtimePromise: null,
  _runtimeFrame: null,

  async analyze(pdfAttachment, apiKey, options = {}) {
    const filePath = await this._getAttachmentPath(pdfAttachment);
    if (!filePath) throw new PTExtractionError("PDF 파일 경로를 가져올 수 없습니다.");
    if (!apiKey) throw new PTError("API 키가 설정되지 않았습니다.", "NO_API_KEY");

    const pdfjs = await this._getPDFJS();
    const bytes = await IOUtils.read(filePath);
    const loadingTask = pdfjs.getDocument({
      data: bytes,
      cMapUrl: this.CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: this.STANDARD_FONT_URL,
      wasmUrl: this.WASM_URL,
      useSystemFonts: true,
    });

    let pdfDocument = null;
    try {
      pdfDocument = await loadingTask.promise;
      const pageCount = Math.min(pdfDocument.numPages, this.MAX_PAGES);
      const pages = new Array(pageCount);
      let nextPage = 1;
      let completedPages = 0;
      const concurrency = Math.max(1, Math.min(
        Number(PTPrefs.getParallelRequests?.() || 6),
        pageCount
      ));

      const worker = async () => {
        while (true) {
          const pageNumber = nextPage++;
          if (pageNumber > pageCount) return;
          this._assertNotCancelled(options);
          options.onProgress?.(completedPages + 1, pageCount, "render");

          const page = await pdfDocument.getPage(pageNumber);
          try {
            const rendered = await this._renderPage(page);
            const nativeItems = await this._extractNativeItems(page, rendered.viewport);
            const analyzed = await this._analyzePage({
              pageNumber,
              pageCount,
              imageDataURI: rendered.imageDataURI,
              nativeItems,
              apiKey,
              isCancelled: options.isCancelled,
            });

            const blocks = this._normalizeBlocks(analyzed.blocks, pageNumber, options.skipReferences !== false);
            this._associateCaptions(blocks);
            this._attachVisualCrops(blocks, rendered.canvas, pageNumber);
            const pageRecord = {
              pageNumber,
              width: rendered.canvas.width,
              height: rendered.canvas.height,
              columnCount: this._clampInteger(analyzed.columnCount, 1, 3, 1),
              blocks,
            };
            pages[pageNumber - 1] = pageRecord;
            completedPages++;
            options.onProgress?.(completedPages, pageCount, "analyzed");
          } finally {
            try { page.cleanup(); } catch (_) {}
          }
        }
      };
      PTLogger.info(`PDF 페이지 분석 병렬 실행: ${concurrency}개 worker`);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      const layout = this._buildLayout(pages, pdfDocument.numPages);
      if (layout.stats.translatableBlocks === 0) {
        throw new PTExtractionError("레이아웃 분석에서 번역 가능한 본문 블록을 찾지 못했습니다.");
      }
      PTLogger.info(
        `레이아웃 분석 완료: ${layout.pageCount}페이지, 본문 ${layout.stats.translatableBlocks}개, `
        + `시각 요소 ${layout.stats.visualBlocks}개`
      );
      return layout;
    } finally {
      try { await pdfDocument?.destroy(); } catch (_) {}
      try { await loadingTask?.destroy(); } catch (_) {}
    }
  },

  toSections(layout, fallbackTitle = "본문") {
    const sections = [];
    let current = null;
    let index = 0;

    const startSection = (heading, level = 1) => {
      current = {
        id: `layout-s${index++}`,
        heading: String(heading || fallbackTitle || "본문").trim(),
        level,
        body: "",
        blockIds: [],
        subsections: [],
      };
      sections.push(current);
      return current;
    };

    for (const page of layout?.pages || []) {
      for (const block of page.blocks || []) {
        if (block.type === "heading") {
          startSection(block.text || `Page ${page.pageNumber}`, this._headingLevel(block.text));
          block.sectionId = current.id;
          continue;
        }
        if (!this.TRANSLATABLE_TYPES.has(block.type) || !block.text || block.skipTranslation) continue;
        if (!current) startSection(fallbackTitle, 1);
        block.sectionId = current.id;
        current.blockIds.push(block.id);
      }
    }

    const blockMap = this.blockMap(layout);
    for (const section of sections) {
      section.body = section.blockIds
        .map(id => blockMap.get(id)?.text || "")
        .filter(Boolean)
        .join("\n\n");
    }
    return sections.filter(section => section.body.trim());
  },

  blockMap(layout) {
    const map = new Map();
    for (const page of layout?.pages || []) {
      for (const block of page.blocks || []) map.set(block.id, block);
    }
    return map;
  },

  serializableLayout(layout) {
    if (!layout) return null;
    return {
      version: layout.version,
      mode: layout.mode,
      pageCount: layout.pageCount,
      sourcePageCount: layout.sourcePageCount,
      stats: layout.stats,
      pages: (layout.pages || []).map(page => ({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        columnCount: page.columnCount,
        blocks: (page.blocks || []).map(block => ({
          id: block.id,
          pageNumber: block.pageNumber,
          order: block.order,
          type: block.type,
          text: block.text || "",
          box2d: block.box2d,
          sectionId: block.sectionId || null,
          skipTranslation: Boolean(block.skipTranslation),
          parentId: block.parentId || null,
          captionId: block.captionId || null,
          cropBox2d: block.cropBox2d || null,
          math: (block.math || []).map(math => ({
            token: math.token,
            latex: math.latex,
            mathml: math.mathml,
            display: Boolean(math.display),
            label: math.label || "",
          })),
          hasVisual: Boolean(block.dataURI),
        })),
      })),
    };
  },

  destroy() {
    try { this._runtimeFrame?.remove(); } catch (_) {}
    this._runtimeFrame = null;
    this._runtimePromise = null;
  },

  async _analyzePage({ pageNumber, pageCount, imageDataURI, nativeItems, apiKey, isCancelled }) {
    const imageMatch = String(imageDataURI || "").match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i);
    if (!imageMatch) throw new PTExtractionError(`페이지 ${pageNumber} 렌더 이미지 생성 실패`);

    const prompt = this._buildLayoutPrompt(pageNumber, pageCount, nativeItems);
    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: imageMatch[1], data: imageMatch[2] } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16384,
        responseMimeType: "application/json",
        responseSchema: this._layoutResponseSchema(),
      },
    };

    let lastError = null;
    for (let attempt = 0; attempt <= this.MAX_LAYOUT_RETRIES; attempt++) {
      if (isCancelled?.()) throw new PTError("번역이 취소되었습니다.", "CANCELLED");
      try {
        await PTRateLimiter.waitForSlot();
        const response = await fetch(PTConstants.geminiEndpoint(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get("Retry-After") || "5", 10) * 1000;
            throw new PTRateLimitError(retryAfter);
          }
          throw new PTApiError(
            `페이지 레이아웃 API 오류 ${response.status}: ${body.slice(0, 400)}`,
            response.status
          );
        }

        const data = await response.json();
        const candidate = data?.candidates?.[0];
        const finishReason = candidate?.finishReason || "";
        const raw = (candidate?.content?.parts || []).map(part => part.text || "").join("").trim();
        if (!raw || finishReason === "MAX_TOKENS") {
          throw new PTError(
            `페이지 ${pageNumber} 레이아웃 응답이 비어 있거나 잘렸습니다. (${finishReason || "unknown"})`,
            "LAYOUT_RESPONSE_INVALID"
          );
        }
        return JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
      } catch (error) {
        lastError = error;
        if (error?.code === "CANCELLED" || error?.nonRetryable) throw error;
        if (attempt >= this.MAX_LAYOUT_RETRIES) break;
        const waitMs = error instanceof PTRateLimitError
          ? (error.retryAfterMs || this.RETRY_BASE_MS)
          : this.RETRY_BASE_MS * Math.pow(2, attempt);
        PTLogger.warn(`페이지 ${pageNumber} 레이아웃 분석 재시도 ${attempt + 1}: ${error.message}`);
        await this._sleepCancellable(waitMs, isCancelled);
      }
    }
    throw lastError || new PTExtractionError(`페이지 ${pageNumber} 레이아웃 분석 실패`);
  },

  _buildLayoutPrompt(pageNumber, pageCount, nativeItems) {
    return `You are reconstructing the reading order of one academic PDF page.
Analyze page ${pageNumber} of ${pageCount}. Use the image for visual layout and the native PDF text items for exact wording.

Return every meaningful block exactly once in human reading order.

Block types:
- title: paper title only
- heading: section or subsection heading
- paragraph: prose paragraph
- list: one logical list block
- caption: original Figure/Table caption; keep it in the source language and point parent_order to its figure/table order
- figure: one complete figure, grouping every panel, legend, axis, and label belonging to it
- table: one complete table including rules and cell text
- equation: one display equation including its equation number
- header/footer: running header, page number, venue footer
- reference: bibliography entry
- other: meaningful translatable prose that fits none of the above

Rules:
1. box_2d is [ymin, xmin, ymax, xmax], integer coordinates normalized to 0..1000.
2. Figure/table boxes must cover the COMPLETE visual object with every panel, legend, axis, row, column, border, and label. Do not crop any edge. Exclude surrounding prose and keep captions as separate caption blocks.
3. Never split a multi-panel figure into separate image blocks.
4. Keep two-column reading order: finish the left column before continuing to the right unless an element spans both columns.
5. Text must be verbatim source text reconstructed from native items. Do not translate, summarize, explain, or invent text.
6. Remove line-wrap hyphenation inside prose where it only comes from PDF line wrapping.
7. Return header/footer blocks so the caller can omit them.
8. For every mathematical expression, replace the expression inside text with a unique token like [[PTMATH_1]] and add its mapping to the block's math array. Use an empty math array when none exists.
9. latex must be valid LaTeX body text without dollar delimiters or Markdown fences. A standalone or numbered equation uses display=true; inline prose math uses display=false. Put an equation number such as (25) only in label as "25"; do not duplicate the number in latex or mathml.
10. mathml must be complete, valid Presentation MathML beginning with <math xmlns="http://www.w3.org/1998/Math/MathML">. It must express the same formula as latex. Use literal Unicode symbols or numeric XML entities, not named HTML entities. Do not use HTML, SVG, images, or external references.
11. An equation block's text should contain only its math token. Numbered equations such as (1), (2), etc. must always be equation blocks with display=true so the caller can serialize them as $$...$$.
12. parent_order is the order of the figure/table owned by a caption; use -1 for every other block.

Native PDF text items with normalized boxes:
${JSON.stringify(nativeItems)}`;
  },

  _layoutResponseSchema() {
    return {
      type: "OBJECT",
      properties: {
        columnCount: { type: "INTEGER" },
        blocks: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              order: { type: "INTEGER" },
              type: {
                type: "STRING",
                enum: Array.from(this.BLOCK_TYPES),
              },
              text: { type: "STRING" },
              parent_order: { type: "INTEGER" },
              math: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    token: { type: "STRING" },
                    latex: { type: "STRING" },
                    mathml: { type: "STRING" },
                    display: { type: "BOOLEAN" },
                    label: { type: "STRING" },
                  },
                  required: ["token", "latex", "mathml", "display", "label"],
                },
              },
              box_2d: {
                type: "ARRAY",
                items: { type: "INTEGER" },
              },
            },
            required: ["order", "type", "text", "parent_order", "math", "box_2d"],
          },
        },
      },
      required: ["columnCount", "blocks"],
    };
  },

  _normalizeBlocks(rawBlocks, pageNumber, skipReferences) {
    const blocks = [];
    for (const raw of Array.isArray(rawBlocks) ? rawBlocks : []) {
      const type = this.BLOCK_TYPES.has(raw?.type) ? raw.type : "other";
      const box2d = this._normalizeBox(raw?.box_2d || raw?.box2d);
      if (!box2d) continue;
      const text = this._normalizeBlockText(raw?.text || "");
      if (!text && !this.VISUAL_TYPES.has(type) && type !== "equation") continue;
      blocks.push({
        id: "",
        pageNumber,
        order: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : blocks.length,
        sourceOrder: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : blocks.length,
        parentOrder: Number.isFinite(Number(raw?.parent_order)) ? Number(raw.parent_order) : -1,
        type,
        text,
        math: this._normalizeMath(raw?.math),
        box2d,
        sectionId: null,
        skipTranslation: type === "header"
          || type === "footer"
          || type === "title"
          || type === "heading"
          || type === "equation"
          || this.VISUAL_TYPES.has(type)
          || (skipReferences && type === "reference"),
        dataURI: null,
        width: null,
        height: null,
        cropBox2d: null,
        parentId: null,
        captionId: null,
      });
    }

    blocks.sort((a, b) => a.order - b.order || a.box2d[0] - b.box2d[0] || a.box2d[1] - b.box2d[1]);
    blocks.forEach((block, index) => {
      block.order = index;
      block.id = `p${String(pageNumber).padStart(4, "0")}-b${String(index + 1).padStart(4, "0")}`;
      this._finalizeMathTokens(block);
    });
    return blocks;
  },

  _normalizeMath(rawMath) {
    const result = [];
    for (const raw of Array.isArray(rawMath) ? rawMath : []) {
      const latex = String(raw?.latex || "")
        .replace(/^```(?:latex|tex)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .replace(/^\$\$?|\$\$?$/g, "")
        .replace(/^\\\(|\\\)$/g, "")
        .replace(/^\\\[|\\\]$/g, "")
        .trim();
      const mathml = String(raw?.mathml || "").trim().slice(0, 30000);
      if (!latex) continue;
      result.push({
        sourceToken: String(raw?.token || "").trim(),
        token: "",
        latex,
        mathml,
        display: Boolean(raw?.display),
        label: String(raw?.label || "").replace(/[(){}]/g, "").trim().slice(0, 40),
      });
    }
    return result;
  },

  _finalizeMathTokens(block) {
    const stablePrefix = String(block.id || "block").replace(/[^A-Za-z0-9_]/g, "_");
    for (let index = 0; index < (block.math || []).length; index++) {
      const math = block.math[index];
      const stableToken = `[[PTMATH_${stablePrefix}_${String(index + 1).padStart(2, "0")}]]`;
      if (math.sourceToken && block.text.includes(math.sourceToken)) {
        block.text = block.text.split(math.sourceToken).join(stableToken);
      }
      math.token = stableToken;
      math.display = block.type === "equation" || Boolean(math.display);
      delete math.sourceToken;
    }
    if (block.type === "equation" && block.math?.length) {
      block.text = block.math.map(math => math.token).join("\n");
    }
  },

  _associateCaptions(blocks) {
    const bySourceOrder = new Map(blocks.map(block => [block.sourceOrder, block]));
    const visuals = blocks.filter(block => ["figure", "table"].includes(block.type));
    for (const caption of blocks.filter(block => block.type === "caption")) {
      let parent = bySourceOrder.get(caption.parentOrder);
      if (!parent || !["figure", "table"].includes(parent.type)) {
        const expectedType = /^\s*(?:table|tab\.)\s*\d+/i.test(caption.text) ? "table"
          : /^\s*(?:fig(?:ure)?\.?)[\s:]?\d+/i.test(caption.text) ? "figure"
          : null;
        const candidates = expectedType ? visuals.filter(block => block.type === expectedType) : visuals;
        parent = candidates
          .map(block => ({ block, score: this._captionDistance(caption, block) }))
          .sort((a, b) => a.score - b.score)[0]?.block || null;
      }
      if (!parent || parent.captionId) continue;
      caption.parentId = parent.id;
      parent.captionId = caption.id;
    }
  },

  _captionDistance(caption, visual) {
    const [cy0, cx0, cy1, cx1] = caption.box2d;
    const [vy0, vx0, vy1, vx1] = visual.box2d;
    const verticalGap = cy0 > vy1 ? cy0 - vy1 : (vy0 > cy1 ? vy0 - cy1 : 0);
    const overlap = Math.max(0, Math.min(cx1, vx1) - Math.max(cx0, vx0));
    const minWidth = Math.max(1, Math.min(cx1 - cx0, vx1 - vx0));
    const overlapPenalty = (1 - Math.min(1, overlap / minWidth)) * 300;
    return verticalGap + overlapPenalty;
  },

  _normalizeBlockText(value) {
    return String(value || "")
      .replace(/\u0000/g, "")
      .replace(/([A-Za-z])[-‐]\s*\n\s*([a-z])/g, "$1$2")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  },

  _normalizeBox(value) {
    if (!Array.isArray(value) || value.length !== 4) return null;
    let [y0, x0, y1, x1] = value.map(number => Math.round(Number(number)));
    if (![y0, x0, y1, x1].every(Number.isFinite)) return null;
    y0 = this._clampInteger(y0, 0, 1000, 0);
    x0 = this._clampInteger(x0, 0, 1000, 0);
    y1 = this._clampInteger(y1, 0, 1000, 1000);
    x1 = this._clampInteger(x1, 0, 1000, 1000);
    if (y1 <= y0 || x1 <= x0) return null;
    return [y0, x0, y1, x1];
  },

  _attachVisualCrops(blocks, pageCanvas, pageNumber) {
    const doc = pageCanvas.ownerDocument;
    for (const block of blocks) {
      if (!this.VISUAL_TYPES.has(block.type)) continue;
      const [y0, x0, y1, x1] = block.box2d;
      const baseWidth = Math.max(1, (x1 - x0) / 1000 * pageCanvas.width);
      const baseHeight = Math.max(1, (y1 - y0) / 1000 * pageCanvas.height);
      const padX = Math.max(14, Math.round(baseWidth * 0.04));
      const padY = Math.max(12, Math.round(baseHeight * 0.055));
      let left = Math.max(0, Math.floor(x0 / 1000 * pageCanvas.width) - padX);
      let top = Math.max(0, Math.floor(y0 / 1000 * pageCanvas.height) - padY);
      let right = Math.min(pageCanvas.width, Math.ceil(x1 / 1000 * pageCanvas.width) + padX);
      let bottom = Math.min(pageCanvas.height, Math.ceil(y1 / 1000 * pageCanvas.height) + padY);

      // Figure captions are normally below and table captions are often above.
      // Expansion is generous enough to recover clipped axes/borders, but never
      // crosses into the associated caption that is rendered separately.
      const caption = block.captionId ? blocks.find(candidate => candidate.id === block.captionId) : null;
      if (caption?.box2d) {
        const [cy0, , cy1] = caption.box2d;
        const captionTop = Math.floor(cy0 / 1000 * pageCanvas.height);
        const captionBottom = Math.ceil(cy1 / 1000 * pageCanvas.height);
        if (cy0 >= y1) bottom = Math.min(bottom, Math.max(top + 16, captionTop - 3));
        if (cy1 <= y0) top = Math.max(top, Math.min(bottom - 16, captionBottom + 3));
      }
      const width = right - left;
      const height = bottom - top;
      if (width < 24 || height < 16) {
        PTLogger.warn(`페이지 ${pageNumber} ${block.type} crop이 너무 작아 제외: ${width}x${height}`);
        continue;
      }

      const crop = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      crop.width = width;
      crop.height = height;
      const context = crop.getContext("2d", { alpha: false });
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(pageCanvas, left, top, width, height, 0, 0, width, height);
      block.dataURI = crop.toDataURL("image/png");
      block.width = width;
      block.height = height;
      block.cropBox2d = [
        this._normalizedCoordinate(top, pageCanvas.height),
        this._normalizedCoordinate(left, pageCanvas.width),
        this._normalizedCoordinate(bottom, pageCanvas.height),
        this._normalizedCoordinate(right, pageCanvas.width),
      ];
      block.perceptualHash = this._canvasAverageHash(crop);
      block.visualHash = `${width}x${height}:${block.perceptualHash}`;
    }
  },

  _canvasAverageHash(canvas) {
    const doc = canvas.ownerDocument;
    const sample = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    sample.width = 8;
    sample.height = 8;
    const context = sample.getContext("2d", { alpha: false, willReadFrequently: true });
    context.drawImage(canvas, 0, 0, 8, 8);
    const pixels = context.getImageData(0, 0, 8, 8).data;
    const values = [];
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = Math.round(pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114);
      values.push(gray);
      sum += gray;
    }
    const average = sum / Math.max(values.length, 1);
    let high = 0;
    let low = 0;
    values.forEach((value, index) => {
      if (index < 32) high = ((high << 1) | Number(value >= average)) >>> 0;
      else low = ((low << 1) | Number(value >= average)) >>> 0;
    });
    return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
  },

  _buildLayout(pages, sourcePageCount) {
    const allBlocks = pages.flatMap(page => page.blocks || []);
    return {
      version: 2,
      mode: "gemini-page-layout-v2-pdfsplit-math",
      pageCount: pages.length,
      sourcePageCount,
      pages,
      stats: {
        totalBlocks: allBlocks.length,
        translatableBlocks: allBlocks.filter(block => this.TRANSLATABLE_TYPES.has(block.type) && !block.skipTranslation).length,
        visualBlocks: allBlocks.filter(block => this.VISUAL_TYPES.has(block.type) && block.dataURI).length,
        figures: allBlocks.filter(block => block.type === "figure" && block.dataURI).length,
        tables: allBlocks.filter(block => block.type === "table" && block.dataURI).length,
        equations: allBlocks.filter(block => block.type === "equation" && block.math?.length).length,
        latexExpressions: allBlocks.reduce((count, block) => count + (block.math?.length || 0), 0),
      },
    };
  },

  async _renderPage(page) {
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = this.RENDER_WIDTH / Math.max(baseViewport.width, 1);
    const viewport = page.getViewport({ scale });
    const doc = this._getRuntimeDocument();
    const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return {
      canvas,
      viewport,
      imageDataURI: canvas.toDataURL("image/jpeg", 0.9),
    };
  },

  async _extractNativeItems(page, viewport) {
    const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
    const items = [];
    const pdfjs = await this._getPDFJS();
    for (const item of content.items || []) {
      if (!item?.str?.trim() || !Array.isArray(item.transform)) continue;
      const transform = pdfjs.Util.transform(viewport.transform, item.transform);
      const x = transform[4];
      const baselineY = transform[5];
      const height = Math.max(Math.abs(transform[3]), Math.abs(transform[2]), 1);
      const width = Math.max(Number(item.width || 0) * viewport.scale, 1);
      const y = baselineY - height;
      items.push({
        text: item.str,
        box_2d: [
          this._normalizedCoordinate(y, viewport.height),
          this._normalizedCoordinate(x, viewport.width),
          this._normalizedCoordinate(y + height, viewport.height),
          this._normalizedCoordinate(x + width, viewport.width),
        ],
      });
      if (items.length >= this.MAX_NATIVE_ITEMS) break;
    }
    return items;
  },

  _normalizedCoordinate(value, total) {
    return this._clampInteger(Math.round(Number(value || 0) / Math.max(Number(total || 1), 1) * 1000), 0, 1000, 0);
  },

  _headingLevel(text) {
    const value = String(text || "").trim();
    if (/^\d+\.\d+\.\d+/.test(value)) return 3;
    if (/^(?:\d+\.\d+|[A-Z]\.)\s+/.test(value)) return 2;
    return 1;
  },

  async _getAttachmentPath(attachment) {
    if (typeof attachment?.getFilePathAsync === "function") return attachment.getFilePathAsync();
    if (typeof attachment?.getFilePath === "function") return attachment.getFilePath();
    return null;
  },

  async _getPDFJS() {
    const runtimeWindow = await this._loadPDFRuntime();
    if (!runtimeWindow?.PaperFlowPDFRuntime?.pdfjs) {
      const detail = runtimeWindow?.PaperFlowPDFRuntimeError;
      throw new Error(detail?.message || "PaperFlow PDF runtime을 불러오지 못했습니다.");
    }
    return runtimeWindow.PaperFlowPDFRuntime.pdfjs;
  },

  _getRuntimeDocument() {
    const doc = this._runtimeFrame?.contentDocument;
    if (!doc) throw new Error("PaperFlow PDF runtime document가 없습니다.");
    return doc;
  },

  _loadPDFRuntime() {
    if (this._runtimePromise) return this._runtimePromise;
    this._runtimePromise = new Promise((resolve, reject) => {
      const hostDocument = Zotero.getMainWindow()?.document;
      if (!hostDocument?.documentElement) {
        reject(new Error("Zotero 메인 창을 찾을 수 없습니다."));
        return;
      }

      const existing = hostDocument.getElementById(this.RUNTIME_FRAME_ID);
      if (existing?.contentWindow?.PaperFlowPDFRuntime?.pdfjs) {
        this._runtimeFrame = existing;
        resolve(existing.contentWindow);
        return;
      }
      try { existing?.remove(); } catch (_) {}

      const frame = hostDocument.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
      frame.id = this.RUNTIME_FRAME_ID;
      frame.setAttribute("src", this.RUNTIME_URI);
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;border:0;visibility:hidden;";
      this._runtimeFrame = frame;

      let settled = false;
      let timeout = null;
      const cleanup = () => {
        frame.removeEventListener("load", check);
        frame.contentWindow?.removeEventListener("paperflow-pdf-runtime-ready", check);
        if (timeout) clearTimeout(timeout);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        this._runtimePromise = null;
        reject(error);
      };
      const check = () => {
        if (settled) return;
        const win = frame.contentWindow;
        if (win?.PaperFlowPDFRuntime?.pdfjs) {
          settled = true;
          cleanup();
          resolve(win);
          return;
        }
        if (win?.PaperFlowPDFRuntimeError) {
          const detail = win.PaperFlowPDFRuntimeError;
          fail(new Error(detail.message || "PDF runtime load failed"));
        }
      };

      frame.addEventListener("load", check);
      hostDocument.documentElement.appendChild(frame);
      frame.contentWindow?.addEventListener("paperflow-pdf-runtime-ready", check);
      timeout = setTimeout(() => fail(new Error("PDF runtime 로딩 시간 초과")), this.RUNTIME_TIMEOUT_MS);
      check();
    });
    return this._runtimePromise;
  },

  _assertNotCancelled(options) {
    if (options?.isCancelled?.()) throw new PTError("번역이 취소되었습니다.", "CANCELLED");
  },

  async _sleepCancellable(ms, isCancelled) {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (isCancelled?.()) throw new PTError("번역이 취소되었습니다.", "CANCELLED");
      await new Promise(resolve => setTimeout(resolve, Math.min(250, ms - (Date.now() - started))));
    }
  },

  _clampInteger(value, min, max, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  },
};
