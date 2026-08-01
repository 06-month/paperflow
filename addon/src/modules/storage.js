"use strict";

var PTStorage = {
  NOTE_TAG: "[PaperFlow]",
  LEGACY_NOTE_TAG: "[PaperTranslator]",
  HTML_FILENAME: "translated.ko.html",
  META_FILENAME: "pt-meta.json",

  // Zotero 태그 기반 아티팩트 식별 (파일명 변경에도 안전)
  TAG_HTML: "paperflow:html",
  TAG_META: "paperflow:meta",
  TAG_NOTE: "paperflow:note",

  // ── 메인 저장 ─────────────────────────────────────────────────────────────
  // jobs: PTChunker.buildJobs() 결과 (번역 완료된 것들)
  // meta: { title, sections, modelName, startedAt, ... }
  // pt-meta.json이 source of truth — 번역 텍스트를 포함해 저장한다.
  // HTML/Note는 표시용 파생물이다.
  async save(parentItem, jobs, meta) {
    PTLogger.info(`저장 시작: item ${parentItem.id}`);

    // 1. chunk → 섹션별로 병합
    const sections = this._mergeChunksToSections(jobs, meta.sections);

    // 2. translated.ko.html 생성 및 저장
    const htmlContent = this._buildHTML(meta.title, sections, meta.layout || null, jobs);
    let htmlAttachment;
    try {
      htmlAttachment = await this._saveHTMLAttachment(parentItem, htmlContent);
    } catch (e) {
      throw this._storageError("translated.ko.html attachment 생성 실패", e);
    }

    // 3. metadata JSON 저장 (번역 본문 포함 — 재개/채팅 컨텍스트의 원천)
    const metaData = this._buildMeta(meta, jobs, htmlAttachment?.id);
    try {
      await this._saveMetaAttachment(parentItem, metaData);
    } catch (e) {
      throw this._storageError("pt-meta.json attachment 생성 실패", e);
    }

    // 4. Zotero Note 생성/업데이트
    try {
      await this._saveNote(parentItem, meta.title, sections, metaData);
    } catch (e) {
      throw this._storageError("[PaperFlow] Note 저장 실패", e);
    }

    PTLogger.info(`저장 완료: item ${parentItem.id} (status: ${metaData.status})`);
    return { sections, metaData };
  },

  // ── 재개: 기존 meta의 완료 chunk를 새 jobs에 주입 ─────────────────────────
  // chunkId + 텍스트 해시가 일치하는 chunk만 재사용한다 (추출 결과가 바뀌면 무효)
  prefillJobsFromMeta(jobs, meta) {
    if (!meta || !Array.isArray(meta.chunks)) return 0;
    const stored = new Map(meta.chunks.map(c => [c.chunkId, c]));
    let restored = 0;
    for (const job of jobs) {
      const prev = stored.get(job.chunkId);
      if (!prev || prev.status !== "done" || !prev.translation) continue;
      if (prev.textHash && prev.textHash !== PTConstants.hashText(job.text)) continue;
      if (Array.isArray(job.blocks) && job.blocks.length) {
        const previousTranslations = prev.blockTranslations || {};
        if (!job.blocks.every(block => previousTranslations[block.id])) continue;
        job.blockTranslations = { ...previousTranslations };
      }
      job.translation = prev.translation;
      job.summary = prev.summary || "";
      job.status = "done";
      job.error = null;
      restored++;
    }
    PTLogger.info(`재개: 기존 완료 chunk ${restored}/${jobs.length}개 복원`);
    return restored;
  },

  // ── chunk 배열 → 섹션별 병합 ──────────────────────────────────────────────
  _mergeChunksToSections(jobs, originalSections) {
    // sectionId 기준으로 그룹핑
    const sectionMap = new Map();
    for (const job of jobs) {
      if (!sectionMap.has(job.sectionId)) {
        sectionMap.set(job.sectionId, {
          sectionId: job.sectionId,
          heading: job.heading,
          chunks: [],
          summary: "",
        });
      }
      const sec = sectionMap.get(job.sectionId);
      sec.chunks.push(job);
      if (job.summary) sec.summary = job.summary; // 마지막 chunk summary
    }

    // 섹션 구조를 원래 섹션 트리에서 가져와 번역 채우기
    return this._attachTranslations(originalSections, sectionMap);
  },

  _attachTranslations(sections, sectionMap) {
    return sections.map(section => {
      const secData = sectionMap.get(section.id);
      const translationChunks = secData
        ? secData.chunks
            .filter(c => c.status === "done")
            .sort((a, b) => a.chunkIndex - b.chunkIndex)
            .map(c => c.translation)
        : [];

      return {
        id: section.id,
        heading: section.heading,
        level: section.level,
        body: section.body,
        translation: translationChunks.join("\n\n"),
        summary: secData ? secData.summary : "",
        status: secData
          ? (secData.chunks.every(c => c.status === "done") ? "done" : "partial")
          : "skipped",
        subsections: section.subsections && section.subsections.length > 0
          ? this._attachTranslations(section.subsections, sectionMap)
          : [],
      };
    });
  },

  // ── translated.ko.html 생성 ────────────────────────────────────────────────
  _buildHTML(title, sections, layout = null, jobs = []) {
    if (layout?.pages?.length) {
      return this._buildLayoutHTML(title, sections, layout, jobs);
    }
    const esc = s => (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const nl2br = s => esc(s).replace(/\n/g, "<br>");
    const renderParagraphs = s => String(s || "")
      .replace(/\r\n?/g, "\n")
      .trim()
      .split(/\n\s*\n+/)
      .filter(Boolean)
      .map(paragraph => `<p>${esc(paragraph).replace(/\n/g, "<br>")}</p>`)
      .join("");
    const renderSection = (sec, depth = 0) => {
      const hTag = `h${Math.min(depth + 2, 6)}`;
      const statusBadge = sec.status === "partial"
        ? `<span class="badge partial">일부 번역</span>`
        : sec.status === "failed"
        ? `<span class="badge failed">번역 실패</span>`
        : "";

      let html = `<section class="pt-section level-${sec.level}" id="${esc(sec.id)}">`;
      html += `<${hTag}>${esc(sec.heading)} ${statusBadge}</${hTag}>`;

      if (sec.summary) {
        html += `<div class="pt-summary"><strong>요약:</strong> ${nl2br(sec.summary)}</div>`;
      }
      if (sec.translation) {
        html += `<div class="pt-translation">${renderParagraphs(sec.translation)}</div>`;
      } else if (sec.body) {
        html += `<div class="pt-original">${renderParagraphs(sec.body)}</div>`;
      }

      if (sec.subsections && sec.subsections.length > 0) {
        sec.subsections.forEach(sub => { html += renderSection(sub, depth + 1); });
      }
      html += `</section>`;
      return html;
    };

    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="generator" content="PaperFlow v${PTConstants.VERSION}">
<title>${esc(title)} — 번역본</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #222; }
  h1 { font-size: 1.6em; border-bottom: 2px solid #4a90e2; padding-bottom: 8px; }
  h2 { font-size: 1.3em; margin-top: 2em; color: #1a1a1a; }
  h3 { font-size: 1.1em; margin-top: 1.5em; color: #333; }
  h4, h5, h6 { font-size: 1em; margin-top: 1.2em; color: #444; }
  .pt-summary { background: #f0f6ff; border-left: 3px solid #4a90e2; padding: 8px 12px; margin: 8px 0; font-size: 0.92em; border-radius: 0 4px 4px 0; }
  .pt-translation { margin: 8px 0 16px; }
  .pt-translation p, .pt-original p { margin: 0 0 1em; }
  .pt-translation p:last-child, .pt-original p:last-child { margin-bottom: 0; }
  .pt-translation > br, .pt-original > br { display: block; content: ""; margin-top: 0.75em; }
  .pt-original { margin: 8px 0 16px; color: #666; font-style: italic; font-size: 0.9em; }
  .pt-section { border-bottom: 1px solid #eee; padding-bottom: 12px; margin-bottom: 12px; }
  .badge { font-size: 0.7em; padding: 2px 6px; border-radius: 3px; vertical-align: middle; }
  .badge.partial { background: #fff3cd; color: #856404; }
  .badge.failed { background: #f8d7da; color: #721c24; }
  .pt-meta { font-size: 0.8em; color: #888; margin-bottom: 24px; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="pt-meta">번역 엔진: ${esc(PTConstants.MODEL_LABEL)} | 생성: ${new Date().toLocaleString("ko-KR")}</p>
${sections.map(s => renderSection(s)).join("\n")}
</body>
</html>`;
  },

  _buildLayoutHTML(title, sections, layout, jobs) {
    const esc = value => String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const renderParagraphs = (value, block = null) => String(value || "")
      .replace(/\r\n?/g, "\n")
      .trim()
      .split(/\n\s*\n+/)
      .filter(Boolean)
      .map(paragraph => `<p>${this._renderTextWithMath(paragraph, block, esc).replace(/\n/g, "<br>")}</p>`)
      .join("");

    const translationParts = new Map();
    const summaries = new Map();
    const sectionStatuses = new Map();
    for (const job of jobs || []) {
      if (job.summary) summaries.set(job.sectionId, job.summary);
      if (!sectionStatuses.has(job.sectionId)) sectionStatuses.set(job.sectionId, []);
      sectionStatuses.get(job.sectionId).push(job.status);
      if (job.status !== "done" || !Array.isArray(job.blocks)) continue;
      for (const block of job.blocks) {
        const translation = String(job.blockTranslations?.[block.id] || "").trim();
        if (!translation) continue;
        const sourceId = block.sourceBlockId || block.id;
        if (!translationParts.has(sourceId)) translationParts.set(sourceId, []);
        translationParts.get(sourceId).push({
          partIndex: block.partIndex || 0,
          translation,
        });
      }
    }

    const translationFor = blockId => (translationParts.get(blockId) || [])
      .sort((a, b) => a.partIndex - b.partIndex)
      .map(part => part.translation)
      .join(" ")
      .trim();
    const summaryFor = sectionId => summaries.get(sectionId) || "";
    const renderedSummaries = new Set();
    const renderSectionSummary = sectionId => {
      if (!sectionId || renderedSummaries.has(sectionId)) return "";
      renderedSummaries.add(sectionId);
      const summary = summaryFor(sectionId);
      return summary
        ? `<div class="pt-summary"><strong>요약:</strong> ${esc(summary).replace(/\n/g, "<br>")}</div>`
        : "";
    };
    const statusFor = sectionId => {
      const statuses = sectionStatuses.get(sectionId) || [];
      if (!statuses.length) return "skipped";
      return statuses.every(status => status === "done") ? "done" : "partial";
    };
    const headingTag = text => {
      const value = String(text || "").trim();
      if (/^\d+\.\d+\.\d+/.test(value)) return "h4";
      if (/^(?:\d+\.\d+|[A-Z]\.)\s+/.test(value)) return "h3";
      return "h2";
    };
    const blockMap = new Map((layout.pages || []).flatMap(page => page.blocks || []).map(block => [block.id, block]));

    const renderBlock = block => {
      const id = esc(block.id);
      const page = Number(block.pageNumber || 0);
      if (block.type === "header" || block.type === "footer") return "";
      if (block.type === "reference" && block.skipTranslation) return "";
      if (block.type === "title") return "";

      if (block.type === "heading") {
        const tag = headingTag(block.text);
        const badge = statusFor(block.sectionId) === "partial"
          ? `<span class="badge partial">일부 번역</span>`
          : "";
        return `<${tag} class="pt-layout-heading" data-block-id="${id}">${esc(block.text)} ${badge}</${tag}>`
          + renderSectionSummary(block.sectionId);
      }

      if (["paragraph", "list", "other", "reference"].includes(block.type)) {
        const translated = translationFor(block.id);
        const className = translated ? "pt-translation pt-layout-text" : "pt-original pt-layout-text";
        const content = translated || block.text;
        return renderSectionSummary(block.sectionId)
          + `<div class="${className}" data-block-id="${id}" data-page="${page}">${renderParagraphs(content, block)}</div>`;
      }

      if (block.type === "caption") {
        if (block.parentId && blockMap.has(block.parentId)) return "";
        const translated = translationFor(block.id);
        return `<p class="pt-source-caption" data-block-id="${id}" data-page="${page}">${this._renderTextWithMath(translated || block.text, block, esc)}</p>`;
      }

      if (block.type === "equation") {
        const expressions = (block.math || []).filter(math => math.latex);
        if (!expressions.length) {
          return block.text
            ? `<div class="pt-equation pt-equation-fallback" data-block-id="${id}" data-page="${page}"><code>${esc(block.text)}</code></div>`
            : "";
        }
        return `<div class="pt-equation" data-block-id="${id}" data-page="${page}">
${expressions.map(math => this._renderMathExpression(math, true, esc)).join("\n")}
</div>`;
      }

      if (["figure", "table"].includes(block.type)) {
        const src = String(block.dataURI || "");
        if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(src)) return "";
        const label = block.type === "figure"
          ? "Original Figure"
          : "Original Table";
        const caption = block.captionId ? blockMap.get(block.captionId) : null;
        const captionText = caption ? (translationFor(caption.id) || caption.text) : "";
        const captionHTML = captionText
          ? `<span class="pt-caption-translation">${this._renderTextWithMath(captionText, caption, esc)}</span>`
          : `<span class="pt-caption-fallback">${label}</span>`;
        return `<figure class="pt-source-visual pt-source-${block.type}" data-block-id="${id}" data-page="${page}">
  <img class="pt-source-visual-image" src="${src}" alt="${label}, page ${page}">
  <figcaption>${captionHTML}<span class="pt-source-page">원본 p. ${page}</span></figcaption>
</figure>`;
      }
      return "";
    };

    const pagesHTML = (layout.pages || []).map(page => {
      const blocks = (page.blocks || []).slice().sort((a, b) => a.order - b.order);
      const content = blocks.map(renderBlock).filter(Boolean).join("\n");
      return content ? `<section class="pt-layout-page" data-page="${page.pageNumber}">${content}</section>` : "";
    }).filter(Boolean).join("\n");

    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="generator" content="PaperFlow v${PTConstants.VERSION}">
<title>${esc(title)} — 번역본</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 880px; margin: 40px auto; padding: 0 24px; line-height: 1.72; color: #222; }
  h1 { font-size: 1.65em; border-bottom: 2px solid #4a90e2; padding-bottom: 9px; }
  h2 { font-size: 1.3em; margin: 2.1em 0 0.8em; color: #1a1a1a; }
  h3 { font-size: 1.12em; margin: 1.65em 0 0.7em; color: #333; }
  h4 { font-size: 1.02em; margin: 1.35em 0 0.65em; color: #444; }
  .pt-meta { font-size: 0.8em; color: #888; margin-bottom: 28px; }
  .pt-layout-page { margin: 0; padding: 0; }
  .pt-layout-text { margin: 0 0 1em; }
  .pt-layout-text p { margin: 0 0 1em; }
  .pt-layout-text p:last-child { margin-bottom: 0; }
  .pt-original { color: #666; font-style: italic; font-size: 0.92em; }
  .pt-summary { background: #f0f6ff; border-left: 3px solid #4a90e2; padding: 8px 12px; margin: 8px 0 14px; font-size: 0.92em; border-radius: 0 4px 4px 0; }
  .pt-source-visual { margin: 24px auto 8px; padding: 12px; border: 1px solid #e2e5e9; border-radius: 10px; background: #fff; text-align: center; break-inside: avoid; }
  .pt-source-visual-image { display: block; max-width: 100%; height: auto; margin: 0 auto; object-fit: contain; }
  .pt-source-visual figcaption { margin-top: 11px; color: #555; font-size: 0.9em; line-height: 1.55; text-align: left; }
  .pt-caption-translation { display: block; }
  .pt-source-page { margin-left: 5px; color: #999; }
  .pt-source-caption { margin: 7px 14px 20px; color: #555; font-family: Georgia, serif; font-size: 0.9em; line-height: 1.5; }
  .pt-equation { margin: 22px auto; padding: 10px 16px; overflow-x: auto; text-align: center; break-inside: avoid; }
  .pt-equation-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 18px; min-width: max-content; }
  .pt-equation-math { justify-self: center; font-size: 1.08em; }
  .pt-equation-number { justify-self: end; color: #444; font-family: Georgia, serif; white-space: nowrap; }
  .pt-equation-latex { margin-top: 5px; color: #888; font-size: 0.72em; text-align: left; }
  .pt-equation-latex summary { cursor: pointer; user-select: none; }
  .pt-equation-latex code { display: block; margin-top: 5px; padding: 6px 8px; border-radius: 5px; background: #f6f7f8; white-space: pre-wrap; }
  .pt-math-inline { display: inline-block; vertical-align: -0.15em; margin: 0 0.08em; }
  .badge { font-size: 0.65em; padding: 2px 6px; border-radius: 3px; vertical-align: middle; }
  .badge.partial { background: #fff3cd; color: #856404; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="pt-meta">번역 엔진: ${esc(PTConstants.MODEL_LABEL)} | 구조화 모드: PDF page layout | 생성: ${new Date().toLocaleString("ko-KR")}</p>
${pagesHTML}
</body>
</html>`;
  },

  _renderTextWithMath(value, block, esc) {
    const escapeHTML = esc || (text => String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"));
    let html = escapeHTML(String(value || ""));
    for (const math of block?.math || []) {
      if (!math?.token || !math?.latex) continue;
      const token = escapeHTML(math.token);
      html = html.split(token).join(this._renderMathExpression(math, Boolean(math.display), escapeHTML));
    }
    return html;
  },

  _renderMathExpression(math, forceDisplay, esc) {
    const display = Boolean(forceDisplay || math?.display);
    const latex = String(math?.latex || "").trim();
    const label = String(math?.label || "").replace(/[(){}]/g, "").trim();
    const mathml = this._sanitizeMathML(math?.mathml, display, esc);
    const delimiter = display ? "$$" : "$";
    const taggedLatex = display && label ? `${latex} \\tag{${label}}` : latex;
    const source = `${delimiter}${taggedLatex}${delimiter}`;
    const rendered = mathml || `<code class="pt-math-fallback">${esc(source)}</code>`;

    if (!display) {
      return `<span class="pt-math-inline" title="${esc(source)}">${rendered}</span>`;
    }
    return `<div class="pt-equation-row">
  <span class="pt-equation-math">${rendered}</span>
  ${label ? `<span class="pt-equation-number">(${esc(label)})</span>` : ""}
</div>
<details class="pt-equation-latex"><summary>LaTeX</summary><code>${esc(source)}</code></details>`;
  },

  _sanitizeMathML(rawMathML, display, esc) {
    const raw = String(rawMathML || "").trim();
    if (!raw || raw.length > 30000 || typeof DOMParser === "undefined") return "";
    const allowedTags = new Set([
      "math", "mrow", "mi", "mn", "mo", "mtext", "mspace", "ms",
      "mfrac", "msqrt", "mroot", "mstyle", "merror", "mpadded", "mphantom",
      "msub", "msup", "msubsup", "munder", "mover", "munderover",
      "mmultiscripts", "mprescripts", "none", "mtable", "mlabeledtr", "mtr", "mtd",
      "menclose", "mfenced",
    ]);
    const allowedAttributes = new Set([
      "display", "mathvariant", "mathsize", "mathcolor", "mathbackground",
      "scriptlevel", "displaystyle", "stretchy", "symmetric", "maxsize", "minsize",
      "largeop", "movablelimits", "accent", "accentunder", "linethickness",
      "numalign", "denomalign", "bevelled", "notation", "open", "close", "separators",
      "columnalign", "rowalign", "columnspacing", "rowspacing", "columnlines", "rowlines",
      "frame", "framespacing", "equalrows", "equalcolumns", "rowspan", "columnspan",
      "width", "height", "depth", "lspace", "rspace", "voffset",
    ]);
    try {
      const document = new DOMParser().parseFromString(raw, "application/xml");
      const root = document.documentElement;
      if (!root || root.localName?.toLowerCase() !== "math" || document.querySelector("parsererror")) return "";
      const serialize = (node, isRoot = false) => {
        if (node.nodeType === 3) return esc(node.nodeValue || "");
        if (node.nodeType !== 1) return "";
        const tag = String(node.localName || "").toLowerCase();
        if (!allowedTags.has(tag)) return Array.from(node.childNodes || []).map(child => serialize(child)).join("");
        const attributes = [];
        for (const attribute of Array.from(node.attributes || [])) {
          const name = String(attribute.localName || attribute.name || "").toLowerCase();
          if (isRoot && name === "display") continue;
          if (!allowedAttributes.has(name)) continue;
          attributes.push(`${name}="${esc(String(attribute.value || "").slice(0, 200))}"`);
        }
        if (isRoot) {
          attributes.push('xmlns="http://www.w3.org/1998/Math/MathML"');
          attributes.push(`display="${display ? "block" : "inline"}"`);
        }
        const content = Array.from(node.childNodes || []).map(child => serialize(child)).join("");
        return `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>${content}</${tag}>`;
      };
      return serialize(root, true);
    } catch (error) {
      PTLogger.warn(`MathML 정제 실패: ${error.message}`);
      return "";
    }
  },

  // ── HTML attachment 저장 ──────────────────────────────────────────────────
  async _saveHTMLAttachment(parentItem, htmlContent) {
    // 기존 attachment 있으면 업데이트
    const existing = await this._findArtifactAttachment(parentItem, this.TAG_HTML, this.HTML_FILENAME);

    if (existing) {
      const path = existing.getFilePath && existing.getFilePath();
      if (path) {
        await Zotero.File.putContentsAsync(path, htmlContent);
        existing.setField("title", this.HTML_FILENAME);
        await this._ensureTag(existing, this.TAG_HTML);
        await existing.saveTx();
        PTLogger.info(`HTML attachment 업데이트: ${path}`);
        return existing;
      }
      await this._deleteStaleAttachment(existing, this.HTML_FILENAME);
    }

    const tempPath = await this._writeTempFile(
      parentItem,
      "translated",
      "html",
      htmlContent
    );
    try {
      const file = this._pathToFile(tempPath);
      const attachment = await Zotero.Attachments.importFromFile({
        file,
        parentItemID: parentItem.id,
        title: this.HTML_FILENAME,
        contentType: "text/html",
        charset: "utf-8",
      });
      await this._ensureTag(attachment, this.TAG_HTML, { save: true });
      PTLogger.info(`HTML attachment 생성: item ${attachment?.id}`);
      return attachment;
    } finally {
      await this._removeTempFile(tempPath);
    }
  },

  // ── metadata JSON attachment 저장 ─────────────────────────────────────────
  async _saveMetaAttachment(parentItem, metaData) {
    const json = JSON.stringify(metaData, null, 2);
    const existing = await this._findArtifactAttachment(parentItem, this.TAG_META, this.META_FILENAME);

    if (existing) {
      const path = existing.getFilePath && existing.getFilePath();
      if (path) {
        await Zotero.File.putContentsAsync(path, json);
        existing.setField("title", this.META_FILENAME);
        await this._ensureTag(existing, this.TAG_META);
        await existing.saveTx();
        PTLogger.info(`metadata attachment 업데이트: ${path}`);
        return existing;
      }
      await this._deleteStaleAttachment(existing, this.META_FILENAME);
    }

    const tempPath = await this._writeTempFile(
      parentItem,
      "meta",
      "json",
      json
    );
    try {
      const file = this._pathToFile(tempPath);
      const attachment = await Zotero.Attachments.importFromFile({
        file,
        parentItemID: parentItem.id,
        title: this.META_FILENAME,
        contentType: "application/json",
        charset: "utf-8",
      });
      await this._ensureTag(attachment, this.TAG_META, { save: true });
      PTLogger.info(`metadata attachment 생성: item ${attachment?.id}`);
      return attachment;
    } finally {
      await this._removeTempFile(tempPath);
    }
  },

  async _ensureTag(item, tag, opts = {}) {
    try {
      if (!item || typeof item.addTag !== "function") return;
      if (typeof item.hasTag === "function" && item.hasTag(tag)) return;
      item.addTag(tag);
      if (opts.save) await item.saveTx();
    } catch (e) {
      PTLogger.warn(`태그 부여 실패 (${tag}): ${e.message}`);
    }
  },

  async _writeTempFile(parentItem, kind, extension, content) {
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "");
    const filename = `paperflow-${kind}-${parentItem.id}-${timestamp}.${extension}`;
    const path = this._joinPath(this._getTempDirPath(), filename);
    await Zotero.File.putContentsAsync(path, content);
    // TODO: support an explicit user export folder in addition to Zotero attachments.
    PTLogger.info(`임시 파일 생성: ${path}`);
    return path;
  },

  async _removeTempFile(path) {
    try {
      if (typeof IOUtils !== "undefined" && typeof IOUtils.remove === "function") {
        await IOUtils.remove(path, { ignoreAbsent: true });
        return;
      }
      const file = this._pathToFile(path);
      if (file && typeof file.exists === "function" && file.exists()) {
        file.remove(false);
      }
    } catch (e) {
      PTLogger.warn(`임시 파일 삭제 실패: ${e.message}`);
    }
  },

  _getTempDirPath() {
    if (typeof Zotero.getTempDirectory === "function") {
      const tempDir = Zotero.getTempDirectory();
      if (tempDir?.path) return tempDir.path;
      if (typeof tempDir === "string") return tempDir;
    }
    throw new Error("Zotero temporary directory is unavailable");
  },

  _joinPath(dirPath, filename) {
    if (typeof PathUtils !== "undefined" && typeof PathUtils.join === "function") {
      return PathUtils.join(dirPath, filename);
    }
    return dirPath.replace(/[\\/]$/, "") + "/" + filename;
  },

  _pathToFile(path) {
    if (Zotero.File && typeof Zotero.File.pathToFile === "function") {
      return Zotero.File.pathToFile(path);
    }
    return path;
  },

  async _deleteStaleAttachment(attachment, filename) {
    if (!attachment || typeof attachment.eraseTx !== "function") {
      throw new Error(`${filename} 기존 attachment 파일 경로를 찾지 못했습니다.`);
    }
    PTLogger.warn(`${filename} 기존 attachment 파일 경로 없음 — stale attachment 삭제 후 재생성`);
    await attachment.eraseTx();
  },

  _storageError(userMessage, cause) {
    const detail = cause?.stack || cause?.message || String(cause);
    PTLogger.error(`${userMessage}: ${detail}`);
    const err = new Error(userMessage);
    err.cause = cause;
    return err;
  },

  // ── Zotero Note 저장 ──────────────────────────────────────────────────────
  // Note는 사람이 읽는 요약 파생물이다. 메타데이터는 pt-meta.json이 원천이므로
  // 노트 편집 시 sanitization으로 깨질 수 있는 base64 주석은 더 이상 넣지 않는다.
  async _saveNote(parentItem, title, sections, metaData) {
    const noteContent = this._buildNoteHTML(title, sections, metaData);

    const existing = await this._findNoteWithTag(parentItem);
    if (existing) {
      existing.setNote(noteContent);
      await this._ensureTag(existing, this.TAG_NOTE);
      await existing.saveTx();
      PTLogger.info(`Note 업데이트: ${existing.id}`);
    } else {
      const note = new Zotero.Item("note");
      note.parentID = parentItem.id;
      note.setNote(noteContent);
      try { note.addTag(this.TAG_NOTE); } catch (_) { /* noop */ }
      await note.saveTx();
      PTLogger.info(`Note 생성: ${note.id}`);
    }
  },

  _buildNoteHTML(title, sections, meta) {
    const esc = s => (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const date = new Date(meta.completedAt || meta.updatedAt || Date.now()).toLocaleString("ko-KR");
    const doneCount = (meta.chunks || []).filter(c => c.status === "done").length;
    const totalCount = (meta.chunks || []).length;
    const statusLabel = meta.status === "completed" ? "번역 완료" : "번역 진행 중 (부분 저장)";

    let html = `<h1>${this.NOTE_TAG} ${esc(title)}</h1>`;
    html += `<p style="color:gray;font-size:0.85em;">${statusLabel}: ${date} | 모델: ${esc(meta.modelName)} | chunk: ${doneCount}/${totalCount}</p>`;
    html += `<p style="font-size:0.85em;">📄 전체 번역본: <em>translated.ko.html</em> attachment 참조</p>`;
    html += `<hr/>`;
    html += `<h2>섹션별 요약</h2>`;

    const renderSummary = (sec, depth = 0) => {
      const indent = "&nbsp;".repeat(depth * 4);
      if (sec.summary) {
        html += `<p>${indent}<strong>${esc(sec.heading)}</strong><br/>${indent}${esc(sec.summary)}</p>`;
      } else {
        html += `<p>${indent}<strong>${esc(sec.heading)}</strong> — 요약 없음</p>`;
      }
      (sec.subsections || []).forEach(sub => renderSummary(sub, depth + 1));
    };
    sections.forEach(s => renderSummary(s));

    return html;
  },

  // ── 로드 ──────────────────────────────────────────────────────────────────
  async getExistingTranslationBundle(parentItem) {
    const htmlAttachment = await this._findArtifactAttachment(parentItem, this.TAG_HTML, this.HTML_FILENAME);
    const metaAttachment = await this._findArtifactAttachment(parentItem, this.TAG_META, this.META_FILENAME);
    const note = this._findNoteWithTagSync(parentItem);

    const result = {
      exists: Boolean(htmlAttachment || metaAttachment || note),
      completed: false,
      status: "missing",
      htmlAttachmentID: htmlAttachment?.id || null,
      metaAttachmentID: metaAttachment?.id || null,
      noteID: note?.id || null,
      completedAt: null,
      meta: null,
    };

    if (!result.exists) return result;

    let meta = null;
    if (metaAttachment) {
      try {
        const raw = await this.readAttachmentText(metaAttachment);
        meta = raw ? JSON.parse(raw) : null;
      } catch (e) {
        PTLogger.warn(`[PaperFlow] Failed to parse pt-meta.json: ${e.message}`);
        result.status = "meta-parse-failed";
        return result;
      }
    } else {
      // 구버전(노트 내 base64 주석) 호환 경로
      meta = this.loadMeta(parentItem);
    }

    result.meta = meta || null;
    result.completedAt = meta?.completedAt || null;

    if (!meta) {
      result.status = "partial";
      return result;
    }

    const total = Number(meta.totalChunks || meta.chunks?.length || 0);
    const done = Number(meta.doneChunks || (meta.chunks || []).filter(c => c.status === "done").length);
    const failed = Number(meta.failedChunks || (meta.chunks || []).filter(c => c.status === "failed").length);
    const metaStatus = meta.status || (total > 0 && done >= total && failed === 0 ? "completed" : "partial");

    result.status = metaStatus || "unknown";
    result.completed = Boolean(
      htmlAttachment
      && (metaStatus === "completed" || metaStatus === "done")
      && total > 0
      && done >= total
      && failed === 0
    );

    if (!result.completed && !["failed", "partial", "running", "unknown", "meta-parse-failed"].includes(result.status)) {
      result.status = "partial";
    }

    return result;
  },

  async readAttachmentText(attachmentOrID) {
    const attachment = typeof attachmentOrID === "number"
      ? Zotero.Items.get(attachmentOrID)
      : attachmentOrID;
    if (!attachment) return "";

    const path = await this._getAttachmentFilePath(attachment);
    if (!path) return "";
    return Zotero.File.getContentsAsync(path);
  },

  async _getAttachmentFilePath(attachment) {
    if (!attachment) return null;
    if (typeof attachment.getFilePathAsync === "function") {
      return attachment.getFilePathAsync();
    }
    if (typeof attachment.getFilePath === "function") {
      return attachment.getFilePath();
    }
    return null;
  },

  // 구버전 호환: 노트에 내장된 base64 메타 읽기 (신규 저장은 하지 않음)
  loadMeta(parentItem) {
    const note = this._findNoteWithTagSync(parentItem);
    if (!note) return null;
    try {
      const noteText = note.getNote();
      const match = noteText.match(/<!-- PT_META:([A-Za-z0-9+/=]+) -->/);
      if (!match) return null;
      return JSON.parse(decodeURIComponent(escape(atob(match[1]))));
    } catch (e) {
      PTLogger.warn(`meta 로드 실패: ${e.message}`);
      return null;
    }
  },


  async loadBundle(parentItem) {
    const existing = await this.getExistingTranslationBundle(parentItem);
    const htmlAttachment = existing.htmlAttachmentID ? Zotero.Items.get(existing.htmlAttachmentID) : null;
    const metaAttachment = existing.metaAttachmentID ? Zotero.Items.get(existing.metaAttachmentID) : null;
    let htmlText = "";
    let meta = existing.meta || null;

    if (htmlAttachment) {
      try { htmlText = await this.readAttachmentText(htmlAttachment); }
      catch (e) { PTLogger.warn(`HTML attachment 로드 실패: ${e.message}`); }
    }

    if (!meta) meta = this.loadMeta(parentItem) || {};

    const note = this._findNoteWithTagSync(parentItem);
    const noteHTML = note ? note.getNote() : "";

    // 섹션 데이터는 구조화된 meta JSON을 우선 사용하고,
    // 번역 텍스트가 없는 구버전 meta는 표시용 HTML 역파싱으로 fallback
    const sections = this._hasChunkTranslations(meta)
      ? this.sectionsFromMeta(meta)
      : this._extractSectionsFromHTML(htmlText);

    return {
      parentItem,
      htmlAttachment,
      metaAttachment,
      note,
      noteHTML,
      htmlText,
      meta,
      sections,
      existing,
    };
  },

  _hasChunkTranslations(meta) {
    return Boolean(meta && Array.isArray(meta.chunks) && meta.chunks.some(c => c && c.translation));
  },

  // meta JSON(chunk 단위) → 섹션 리스트 복원
  sectionsFromMeta(meta) {
    const ordered = [];
    const bySection = new Map();
    for (const chunk of meta.chunks || []) {
      if (!chunk) continue;
      if (!bySection.has(chunk.sectionId)) {
        const sec = {
          id: chunk.sectionId,
          heading: chunk.heading || "Untitled",
          level: 1,
          body: "",
          translation: "",
          summary: "",
          status: "done",
          subsections: [],
          _chunks: [],
        };
        bySection.set(chunk.sectionId, sec);
        ordered.push(sec);
      }
      bySection.get(chunk.sectionId)._chunks.push(chunk);
    }

    for (const sec of ordered) {
      const chunks = sec._chunks.sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));
      sec.translation = chunks
        .filter(c => c.status === "done" && c.translation)
        .map(c => c.translation)
        .join("\n\n");
      const withSummary = chunks.filter(c => c.summary);
      sec.summary = withSummary.length ? withSummary[withSummary.length - 1].summary : "";
      sec.status = chunks.every(c => c.status === "done") ? "done" : "partial";
      delete sec._chunks;
    }
    return ordered;
  },

  _extractSectionsFromHTML(htmlText) {
    if (!htmlText) return [];
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, "text/html");
      const walk = node => {
        const heading = node.querySelector(":scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6")?.textContent?.trim() || "Untitled";
        const summary = node.querySelector(":scope > .pt-summary")?.textContent?.replace(/^요약:\s*/, "").trim() || "";
        const translation = node.querySelector(":scope > .pt-translation")?.textContent?.trim() || "";
        const body = node.querySelector(":scope > .pt-original")?.textContent?.trim() || "";
        const subsections = Array.from(node.querySelectorAll(":scope > section.pt-section")).map(walk);
        return { heading, summary, translation, body, subsections };
      };
      return Array.from(doc.querySelectorAll("body > section.pt-section")).map(walk);
    } catch (e) {
      PTLogger.warn(`HTML section 파싱 실패: ${e.message}`);
      return [];
    }
  },

  // ── 헬퍼 ──────────────────────────────────────────────────────────────────
  async _findNoteWithTag(parentItem) {
    return this._findNoteWithTagSync(parentItem);
  },

  _findNoteWithTagSync(parentItem) {
    const noteIDs = parentItem.getNotes ? parentItem.getNotes() : [];
    let fallback = null;
    for (const id of noteIDs) {
      const note = Zotero.Items.get(id);
      if (!note) continue;
      // 1순위: Zotero 태그 (정확한 식별)
      if (typeof note.hasTag === "function" && note.hasTag(this.TAG_NOTE)) return note;
      // 2순위: 구버전 호환 — 본문 텍스트 매칭
      const noteText = note.getNote() || "";
      if (!fallback && (noteText.includes(this.NOTE_TAG) || noteText.includes(this.LEGACY_NOTE_TAG))) {
        fallback = note;
      }
    }
    return fallback;
  },

  // 태그 우선, 파일명 fallback (구버전 아티팩트 호환)
  async _findArtifactAttachment(parentItem, tag, filename) {
    const attIDs = parentItem.getAttachments ? parentItem.getAttachments() : [];
    let fallback = null;
    for (const id of attIDs) {
      const att = Zotero.Items.get(id);
      if (!att) continue;
      if (typeof att.hasTag === "function" && att.hasTag(tag)) return att;
      if (!fallback) {
        const title = att.getField("title") || "";
        if (title === filename || title.startsWith(`${filename} `) || title.startsWith(`${filename} —`)) {
          fallback = att;
        }
      }
    }
    return fallback;
  },

  // ── metadata 구조 빌드 ────────────────────────────────────────────────────
  _buildMeta(meta, jobs, htmlAttachmentId) {
    const totalChunks = jobs.length;
    const doneChunks = jobs.filter(j => j.status === "done" || j.status === "completed").length;
    const failedChunks = jobs.filter(j => j.status === "failed" || j.error).length;
    const partialChunks = jobs.filter(j =>
      j.status !== "done"
      && j.status !== "completed"
      && j.status !== "failed"
      && !j.error
    ).length;
    const status = totalChunks > 0 && doneChunks === totalChunks && failedChunks === 0
      ? "completed"
      : "partial";
    const savedAt = new Date().toISOString();

    return {
      version: PTConstants.VERSION,
      status,
      modelName: meta.modelName || PTConstants.MODEL_NAME,
      title: meta.title,
      startedAt: meta.startedAt,
      completedAt: status === "completed" ? savedAt : null,
      updatedAt: savedAt,
      htmlAttachmentId: htmlAttachmentId || null,
      htmlAttachmentID: htmlAttachmentId || null,
      totalChunks,
      doneChunks,
      failedChunks,
      partialChunks,
      layoutAnalysis: meta.layoutAnalysis || {
        status: meta.layout ? "completed" : "disabled",
        mode: meta.layout?.mode || null,
        error: null,
      },
      layout: typeof PTLayoutAnalyzer !== "undefined"
        ? PTLayoutAnalyzer.serializableLayout(meta.layout)
        : null,
      chunks: jobs.map(j => ({
        chunkId: j.chunkId,
        sectionId: j.sectionId,
        heading: j.heading,
        chunkIndex: j.chunkIndex,
        totalChunks: j.totalChunks,
        status: j.status,
        retries: j.retries,
        error: j.error || null,
        // 번역 텍스트를 meta에 보존 — 세션 간 재개와 채팅 컨텍스트의 원천
        textHash: PTConstants.hashText(j.text),
        translation: j.status === "done" ? (j.translation || "") : "",
        blocks: Array.isArray(j.blocks)
          ? j.blocks.map(block => ({
              id: block.id,
              sourceBlockId: block.sourceBlockId || block.id,
              partIndex: block.partIndex || 0,
              totalParts: block.totalParts || 1,
            }))
          : null,
        blockTranslations: j.status === "done" && j.blockTranslations
          ? j.blockTranslations
          : null,
        summary: j.summary || "",
      })),
    };
  },
};
