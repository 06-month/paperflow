"use strict";

var PTStorage = {
  NOTE_TAG: "[PaperFlow]",
  LEGACY_NOTE_TAG: "[PaperTranslator]",
  HTML_FILENAME: "translated.ko.html",
  META_FILENAME: "pt-meta.json",

  // ── 메인 저장 ─────────────────────────────────────────────────────────────
  // jobs: PTChunker.buildJobs() 결과 (번역 완료된 것들)
  // meta: { title, sections, modelName, startedAt, completedAt, ... }
  async save(parentItem, jobs, meta) {
    PTLogger.info(`저장 시작: item ${parentItem.id}`);

    // 1. chunk → 섹션별로 병합
    const sections = this._mergeChunksToSections(jobs, meta.sections);

    // 2. translated.ko.html 생성 및 저장
    const htmlContent = this._buildHTML(meta.title, sections);
    let htmlAttachment;
    try {
      htmlAttachment = await this._saveHTMLAttachment(parentItem, htmlContent);
    } catch (e) {
      throw this._storageError("translated.ko.html attachment 생성 실패", e);
    }

    // 3. metadata JSON 저장
    const metaData = this._buildMeta(meta, jobs, htmlAttachment?.id);
    try {
      const metaAttachment = await this._saveMetaAttachment(parentItem, metaData);
      if (metaAttachment?.id && metaData.metaAttachmentId !== metaAttachment.id) {
        metaData.metaAttachmentId = metaAttachment.id;
        metaData.metaAttachmentID = metaAttachment.id;
        await this._saveMetaAttachment(parentItem, metaData);
      }
    } catch (e) {
      throw this._storageError("pt-meta.json attachment 생성 실패", e);
    }

    // 4. Zotero Note 생성/업데이트
    try {
      await this._saveNote(parentItem, meta.title, sections, metaData);
    } catch (e) {
      throw this._storageError("[PaperFlow] Note 저장 실패", e);
    }

    PTLogger.info(`저장 완료: item ${parentItem.id}`);
    return { sections, metaData };
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
  _buildHTML(title, sections) {
    const esc = s => (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const nl2br = s => esc(s).replace(/\n/g, "<br>");

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
        html += `<div class="pt-translation">${nl2br(sec.translation)}</div>`;
      } else if (sec.body) {
        html += `<div class="pt-original">${nl2br(sec.body)}</div>`;
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
<meta name="generator" content="PaperFlow v0.2.2">
<title>${esc(title)} — 번역본</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #222; }
  h1 { font-size: 1.6em; border-bottom: 2px solid #4a90e2; padding-bottom: 8px; }
  h2 { font-size: 1.3em; margin-top: 2em; color: #1a1a1a; }
  h3 { font-size: 1.1em; margin-top: 1.5em; color: #333; }
  h4, h5, h6 { font-size: 1em; margin-top: 1.2em; color: #444; }
  .pt-summary { background: #f0f6ff; border-left: 3px solid #4a90e2; padding: 8px 12px; margin: 8px 0; font-size: 0.92em; border-radius: 0 4px 4px 0; }
  .pt-translation { margin: 8px 0 16px; }
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
<p class="pt-meta">번역 엔진: Gemini 3.1 Flash-Lite | 생성: ${new Date().toLocaleString("ko-KR")}</p>
${sections.map(s => renderSection(s)).join("\n")}
</body>
</html>`;
  },

  // ── HTML attachment 저장 ──────────────────────────────────────────────────
  async _saveHTMLAttachment(parentItem, htmlContent) {
    // 기존 attachment 있으면 업데이트
    const existing = await this._findAttachmentByFilename(parentItem, this.HTML_FILENAME);

    if (existing) {
      const path = existing.getFilePath && existing.getFilePath();
      if (path) {
        await Zotero.File.putContentsAsync(path, htmlContent);
        existing.setField("title", this.HTML_FILENAME);
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
      PTLogger.info(`HTML attachment 생성: item ${attachment?.id}`);
      return attachment;
    } finally {
      await this._removeTempFile(tempPath);
    }
  },

  // ── metadata JSON attachment 저장 ─────────────────────────────────────────
  async _saveMetaAttachment(parentItem, metaData) {
    const json = JSON.stringify(metaData, null, 2);
    const existing = await this._findAttachmentByFilename(parentItem, this.META_FILENAME);

    if (existing) {
      const path = existing.getFilePath && existing.getFilePath();
      if (path) {
        await Zotero.File.putContentsAsync(path, json);
        existing.setField("title", this.META_FILENAME);
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
      PTLogger.info(`metadata attachment 생성: item ${attachment?.id}`);
      return attachment;
    } finally {
      await this._removeTempFile(tempPath);
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
  async _saveNote(parentItem, title, sections, metaData) {
    const noteHTML = this._buildNoteHTML(title, sections, metaData);
    const metaJSON = JSON.stringify(metaData);
    const noteContent = noteHTML + `\n<!-- PT_META:${btoa(unescape(encodeURIComponent(metaJSON)))} -->`;

    const existing = await this._findNoteWithTag(parentItem);
    if (existing) {
      existing.setNote(noteContent);
      await existing.saveTx();
      PTLogger.info(`Note 업데이트: ${existing.id}`);
    } else {
      const note = new Zotero.Item("note");
      note.parentID = parentItem.id;
      note.setNote(noteContent);
      await note.saveTx();
      PTLogger.info(`Note 생성: ${note.id}`);
    }
  },

  _buildNoteHTML(title, sections, meta) {
    const esc = s => (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const date = new Date(meta.completedAt || Date.now()).toLocaleString("ko-KR");
    const doneCount = (meta.chunks || []).filter(c => c.status === "done").length;
    const totalCount = (meta.chunks || []).length;

    let html = `<h1>${this.NOTE_TAG} ${esc(title)}</h1>`;
    html += `<p style="color:gray;font-size:0.85em;">번역 완료: ${date} | 모델: ${esc(meta.modelName)} | chunk: ${doneCount}/${totalCount}</p>`;
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
    const htmlAttachment = await this._findAttachmentByFilename(parentItem, this.HTML_FILENAME);
    const metaAttachment = await this._findAttachmentByFilename(parentItem, this.META_FILENAME);
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
    const sections = this._extractSectionsFromHTML(htmlText);
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
    const noteIDs = parentItem.getNotes ? parentItem.getNotes() : [];
    for (const id of noteIDs) {
      const note = Zotero.Items.get(id);
      const noteText = note && (note.getNote() || "");
      if (noteText.includes(this.NOTE_TAG) || noteText.includes(this.LEGACY_NOTE_TAG)) return note;
    }
    return null;
  },

  _findNoteWithTagSync(parentItem) {
    const noteIDs = parentItem.getNotes ? parentItem.getNotes() : [];
    for (const id of noteIDs) {
      const note = Zotero.Items.get(id);
      const noteText = note && (note.getNote() || "");
      if (noteText.includes(this.NOTE_TAG) || noteText.includes(this.LEGACY_NOTE_TAG)) return note;
    }
    return null;
  },

  async _findAttachmentByFilename(parentItem, filename) {
    const attIDs = parentItem.getAttachments ? parentItem.getAttachments() : [];
    for (const id of attIDs) {
      const att = Zotero.Items.get(id);
      if (!att) continue;
      const title = att.getField("title") || "";
      if (title === filename || title.startsWith(`${filename} `) || title.startsWith(`${filename} —`)) {
        return att;
      }
    }
    return null;
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
      version: "0.1.0",
      status,
      modelName: "gemini-3.1-flash-lite",
      title: meta.title,
      startedAt: meta.startedAt,
      completedAt: status === "completed" ? savedAt : null,
      updatedAt: savedAt,
      htmlAttachmentId: htmlAttachmentId || null,
      htmlAttachmentID: htmlAttachmentId || null,
      metaAttachmentId: null,
      metaAttachmentID: null,
      totalChunks,
      doneChunks,
      failedChunks,
      partialChunks,
      chunks: jobs.map(j => ({
        chunkId: j.chunkId,
        sectionId: j.sectionId,
        heading: j.heading,
        chunkIndex: j.chunkIndex,
        totalChunks: j.totalChunks,
        status: j.status,
        retries: j.retries,
        error: j.error || null,
      })),
    };
  },
};
