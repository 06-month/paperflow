"use strict";

/**
 * Persist a transparent, page-aware PDF decomposition for every translation.
 *
 * The directory layout mirrors the user's pdf2md utility while staying inside
 * Zotero's data directory so linked and stored attachments behave identically:
 *
 * PaperFlow_PdfSplit/<paper>-<attachment-key>/
 *   document.md
 *   manifest.json
 *   text/page-001.txt
 *   page-renders/page-001.png
 *   extracted-images/page-001-figure-001.png
 */
var PTPdfSplit = {
  ROOT_NAME: "PaperFlow_PdfSplit",
  REPEATED_IMAGE_THRESHOLD: 3,
  MIN_IMAGE_AREA_RATIO: 0.01,
  HEADER_FOOTER_BAND_RATIO: 0.15,
  HEADER_FOOTER_MAX_AREA_RATIO: 0.05,
  PERCEPTUAL_HASH_DISTANCE_THRESHOLD: 4,

  async begin(attachment, sourcePath, totalPages) {
    const dataDir = this._dataDirectoryPath();
    const stem = this._sanitizeFilename(this._basename(sourcePath).replace(/\.pdf$/i, ""));
    const key = this._sanitizeFilename(String(attachment?.key || attachment?.id || "attachment"));
    const rootBase = this._join(dataDir, this.ROOT_NAME);
    const rootPath = this._join(rootBase, `${stem}-${key}`);
    const paths = {
      root: rootPath,
      pageRenders: this._join(rootPath, "page-renders"),
      extractedImages: this._join(rootPath, "extracted-images"),
      text: this._join(rootPath, "text"),
    };
    for (const path of Object.values(paths)) await this._makeDirectory(path);

    return {
      sourcePath,
      sourceFile: this._basename(sourcePath),
      attachmentKey: key,
      totalPages: Number(totalPages || 0),
      rootPath,
      paths,
      pages: [],
      startedAt: new Date().toISOString(),
    };
  },

  async writePage(session, page) {
    if (!session?.paths?.root || !page?.canvas) return;
    const pageNumber = Number(page.pageNumber || 0);
    const pageName = `page-${String(pageNumber).padStart(3, "0")}.png`;
    const renderPath = this._join(session.paths.pageRenders, pageName);
    await this._writeDataURI(renderPath, page.canvas.toDataURL("image/png"));

    session.pages.push({
      pageNumber,
      width: page.canvas.width,
      height: page.canvas.height,
      pageRenderPath: `page-renders/${pageName}`,
      blocks: page.blocks || [],
    });
  },

  async finalize(session, layout) {
    if (!session?.paths?.root) return null;
    session.pages.sort((a, b) => a.pageNumber - b.pageNumber);
    const visualStats = await this._writeVisuals(session);

    for (const page of session.pages) {
      const filename = `page-${String(page.pageNumber).padStart(3, "0")}.txt`;
      const text = this._pageMarkdown(page, { includePageComment: false, includeRenderComment: false });
      await this._writeText(this._join(session.paths.text, filename), text.trimEnd() + "\n");
    }

    const markdownPath = this._join(session.paths.root, "document.md");
    await this._backupExisting(markdownPath);
    const markdown = this._buildMarkdown(session);
    await this._writeText(markdownPath, markdown);

    const manifest = this._buildManifest(session, layout, visualStats);
    const manifestPath = this._join(session.paths.root, "manifest.json");
    await this._writeText(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const result = {
      status: "completed",
      rootPath: session.rootPath,
      markdownPath,
      manifestPath,
      pageCount: session.pages.length,
      pageRenders: session.pages.length,
      extractedImages: visualStats.saved,
      ignoredImages: visualStats.ignoredTotal,
    };
    PTLogger.info(`PDF 분리 저장 완료: ${session.rootPath}`);
    return result;
  },

  async abort(session, error) {
    if (!session?.paths?.root) return;
    try {
      await this._writeText(this._join(session.paths.root, "manifest.error.json"), JSON.stringify({
        status: "failed",
        sourceFile: session.sourceFile,
        startedAt: session.startedAt,
        failedAt: new Date().toISOString(),
        error: String(error?.message || error || "unknown error"),
      }, null, 2) + "\n");
    } catch (writeError) {
      PTLogger.warn(`PDF 분리 실패 manifest 저장 실패: ${writeError.message}`);
    }
  },

  async _writeVisuals(session) {
    const visuals = session.pages.flatMap(page => (page.blocks || [])
      .filter(block => ["figure", "table"].includes(block.type) && block.dataURI)
      .map(block => ({ block, page })));
    const repeated = this._repeatedVisualIndexes(visuals);
    const stats = {
      saved: 0,
      ignoredTotal: 0,
      ignoredRepeated: 0,
      ignoredSmall: 0,
      ignoredHeaderFooter: 0,
    };
    const pageCounters = new Map();

    for (let index = 0; index < visuals.length; index++) {
      const { block, page } = visuals[index];
      const reasons = [];
      const [y0, x0, y1, x1] = block.cropBox2d || block.box2d || [0, 0, 0, 0];
      const areaRatio = Math.max(0, y1 - y0) * Math.max(0, x1 - x0) / 1000000;
      const centerY = (y0 + y1) / 2000;

      if (repeated.has(index)) reasons.push("repeated");
      if (areaRatio < this.MIN_IMAGE_AREA_RATIO) reasons.push("small");
      if (areaRatio < this.HEADER_FOOTER_MAX_AREA_RATIO
          && (centerY <= this.HEADER_FOOTER_BAND_RATIO || centerY >= 1 - this.HEADER_FOOTER_BAND_RATIO)) {
        reasons.push("header/footer");
      }

      if (reasons.length) {
        block.splitIgnoredReasons = reasons;
        stats.ignoredTotal++;
        if (reasons.includes("repeated")) stats.ignoredRepeated++;
        if (reasons.includes("small")) stats.ignoredSmall++;
        if (reasons.includes("header/footer")) stats.ignoredHeaderFooter++;
        continue;
      }

      const counterKey = `${page.pageNumber}:${block.type}`;
      const itemNumber = (pageCounters.get(counterKey) || 0) + 1;
      pageCounters.set(counterKey, itemNumber);
      const filename = `page-${String(page.pageNumber).padStart(3, "0")}-${block.type}-${String(itemNumber).padStart(3, "0")}.png`;
      await this._writeDataURI(this._join(session.paths.extractedImages, filename), block.dataURI);
      block.splitAssetPath = `extracted-images/${filename}`;
      stats.saved++;
    }
    return stats;
  },

  _repeatedVisualIndexes(visuals) {
    const repeated = new Set();
    const exactCounts = new Map();
    for (const { block } of visuals) {
      const hash = String(block.visualHash || "");
      if (hash) exactCounts.set(hash, (exactCounts.get(hash) || 0) + 1);
    }
    visuals.forEach(({ block }, index) => {
      if (block.visualHash && exactCounts.get(block.visualHash) >= this.REPEATED_IMAGE_THRESHOLD) repeated.add(index);
    });

    const groups = [];
    visuals.forEach((entry, index) => {
      const hash = String(entry.block.perceptualHash || "");
      if (!hash) return;
      let group = groups.find(candidate => {
        const representative = visuals[candidate[0]].block;
        return this._hashDistance(hash, representative.perceptualHash) <= this.PERCEPTUAL_HASH_DISTANCE_THRESHOLD
          && this._similarDimensions(entry.block, representative);
      });
      if (!group) {
        group = [];
        groups.push(group);
      }
      group.push(index);
    });
    for (const group of groups) {
      if (group.length >= this.REPEATED_IMAGE_THRESHOLD) group.forEach(index => repeated.add(index));
    }
    return repeated;
  },

  _similarDimensions(left, right) {
    const lw = Number(left.width || 0);
    const lh = Number(left.height || 0);
    const rw = Number(right.width || 0);
    const rh = Number(right.height || 0);
    if (!lw || !lh || !rw || !rh) return true;
    return Math.abs(lw - rw) / Math.max(lw, rw) <= 0.08
      && Math.abs(lh - rh) / Math.max(lh, rh) <= 0.08;
  },

  _hashDistance(left, right) {
    const a = String(left || "").toLowerCase();
    const b = String(right || "").toLowerCase();
    if (a.length !== b.length) return Infinity;
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
      let value = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (value) {
        distance += value & 1;
        value >>= 1;
      }
    }
    return distance;
  },

  _buildMarkdown(session) {
    const lines = [
      "---",
      "type: paperflow_pdf_split",
      `source_file: ${this._yamlQuote(session.sourceFile)}`,
      `created: ${this._yamlQuote(new Date().toISOString().slice(0, 10))}`,
      `asset_dir: ${this._yamlQuote(".")}`,
      `page_count: ${session.pages.length}`,
      `extraction_mode: ${this._yamlQuote("text_blocks_and_page_visuals")}`,
      "---",
      "",
    ];
    for (const page of session.pages) lines.push(this._pageMarkdown(page));
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  },

  _pageMarkdown(page, options = {}) {
    const includePageComment = options.includePageComment !== false;
    const includeRenderComment = options.includeRenderComment !== false;
    const lines = [];
    if (includePageComment) lines.push(`<!-- page: ${String(page.pageNumber).padStart(3, "0")} -->`, "");
    for (const block of (page.blocks || []).slice().sort((a, b) => a.order - b.order)) {
      if (["header", "footer"].includes(block.type)) continue;
      if (["figure", "table"].includes(block.type)) {
        if (block.splitAssetPath) lines.push(`![](${block.splitAssetPath})`, "");
        continue;
      }
      const text = this._sourceTextWithLatex(block);
      if (text) lines.push(text, "");
    }
    if (includeRenderComment) lines.push(`<!-- page-render: ${page.pageRenderPath} -->`, "");
    return lines.join("\n");
  },

  _sourceTextWithLatex(block) {
    let text = String(block.text || "");
    for (const math of block.math || []) {
      if (!math?.token || !math?.latex) continue;
      const label = math.label ? ` \\tag{${String(math.label).replace(/[{}]/g, "")}}` : "";
      const rendered = math.display
        ? `\n$$\n${math.latex}${label}\n$$\n`
        : `$${math.latex}$`;
      text = text.split(math.token).join(rendered);
    }
    return text.trim();
  },

  _buildManifest(session, layout, visualStats) {
    return {
      version: 1,
      type: "paperflow_pdf_split",
      status: "completed",
      sourceFile: session.sourceFile,
      attachmentKey: session.attachmentKey,
      createdAt: new Date().toISOString(),
      pageCount: session.pages.length,
      extractionMode: "text_blocks_and_page_visuals",
      imageFilter: visualStats,
      layoutMode: layout?.mode || null,
      pages: session.pages.map(page => ({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        pageRenderPath: page.pageRenderPath,
        textPath: `text/page-${String(page.pageNumber).padStart(3, "0")}.txt`,
        blocks: (page.blocks || []).map(block => ({
          id: block.id,
          order: block.order,
          type: block.type,
          text: block.text || "",
          box2d: block.box2d,
          cropBox2d: block.cropBox2d || null,
          parentId: block.parentId || null,
          captionId: block.captionId || null,
          math: block.math || [],
          assetPath: block.splitAssetPath || null,
          ignoredReasons: block.splitIgnoredReasons || [],
        })),
      })),
    };
  },

  async _backupExisting(path) {
    if (!(await this._exists(path))) return null;
    const backupDir = this._join(this._dirname(path), ".backup");
    await this._makeDirectory(backupDir);
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "");
    const backupPath = this._join(backupDir, `${this._basename(path)}.${stamp}.bak`);
    if (typeof IOUtils !== "undefined" && typeof IOUtils.copy === "function") {
      await IOUtils.copy(path, backupPath);
    }
    return backupPath;
  },

  async _writeDataURI(path, dataURI) {
    const match = String(dataURI || "").match(/^data:image\/(?:png|jpeg|webp);base64,(.+)$/i);
    if (!match) throw new Error(`지원하지 않는 이미지 데이터: ${this._basename(path)}`);
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (typeof IOUtils === "undefined" || typeof IOUtils.write !== "function") {
      throw new Error("IOUtils.write를 사용할 수 없습니다.");
    }
    await IOUtils.write(path, bytes, { tmpPath: `${path}.tmp` });
  },

  async _writeText(path, value) {
    if (typeof Zotero !== "undefined" && typeof Zotero.File?.putContentsAsync === "function") {
      await Zotero.File.putContentsAsync(path, String(value || ""));
      return;
    }
    if (typeof IOUtils !== "undefined" && typeof IOUtils.writeUTF8 === "function") {
      await IOUtils.writeUTF8(path, String(value || ""));
      return;
    }
    throw new Error("텍스트 파일 쓰기 API를 사용할 수 없습니다.");
  },

  async _makeDirectory(path) {
    if (typeof IOUtils === "undefined" || typeof IOUtils.makeDirectory !== "function") {
      throw new Error("IOUtils.makeDirectory를 사용할 수 없습니다.");
    }
    await IOUtils.makeDirectory(path, { createAncestors: true, ignoreExisting: true });
  },

  async _exists(path) {
    if (typeof IOUtils !== "undefined" && typeof IOUtils.exists === "function") return IOUtils.exists(path);
    return false;
  },

  _dataDirectoryPath() {
    const direct = typeof Zotero !== "undefined" ? Zotero.DataDirectory?.dir : null;
    if (typeof direct === "string" && direct) return direct;
    const directory = typeof Zotero !== "undefined" ? Zotero.getZoteroDirectory?.() : null;
    if (typeof directory === "string" && directory) return directory;
    if (directory?.path) return directory.path;
    throw new Error("Zotero 데이터 폴더 경로를 찾을 수 없습니다.");
  },

  _join(...parts) {
    if (typeof PathUtils !== "undefined" && typeof PathUtils.join === "function") return PathUtils.join(...parts);
    return parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/");
  },

  _dirname(path) {
    if (typeof PathUtils !== "undefined" && typeof PathUtils.parent === "function") return PathUtils.parent(path);
    return String(path || "").replace(/[\\/][^\\/]+$/, "");
  },

  _basename(path) {
    return String(path || "").split(/[\\/]/).pop() || "document.pdf";
  },

  _sanitizeFilename(value) {
    const safe = String(value || "document")
      .replace(/[\x00-\x1f\x7f/\\:*?"<>|\[\]]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    return (safe || "document").slice(0, 100);
  },

  _yamlQuote(value) {
    return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  },
};
