"use strict";

var PTExtractor = {
  // ── PDF attachment → raw text 추출 ────────────────────────────────────────
  async extract(pdfAttachment) {
    PTLogger.info(`텍스트 추출 시작: item ${pdfAttachment.id}`);

    let text = "";

    // 방법 1: Zotero 내장 fullText 인덱스 (가장 빠름, 이미 인덱싱된 경우)
    try {
      text = await this._extractViaIndex(pdfAttachment);
      if (text && text.trim().length > 100) {
        PTLogger.info(`인덱스에서 추출 완료: ${text.length}자`);
        return text;
      }
    } catch (e) {
      PTLogger.warn(`인덱스 추출 실패: ${e.message}`);
    }

    // 방법 2: Zotero PDFWorker (pdf.js 기반 직접 추출)
    try {
      text = await this._extractViaPDFWorker(pdfAttachment);
      if (text && text.trim().length > 100) {
        PTLogger.info(`PDFWorker에서 추출 완료: ${text.length}자`);
        return text;
      }
    } catch (e) {
      PTLogger.warn(`PDFWorker 추출 실패: ${e.message}`);
    }

    if (!text || text.trim().length === 0) {
      throw new PTExtractionError(
        "텍스트를 추출할 수 없습니다. 스캔본이거나 텍스트 레이어가 없는 PDF일 수 있습니다."
      );
    }

    return text;
  },

  // ── 방법 1: Zotero fullText 인덱스 ────────────────────────────────────────
  async _extractViaIndex(attachment) {
    // Zotero.Fulltext API
    if (Zotero.Fulltext && Zotero.Fulltext.getIndexedState) {
      const state = await Zotero.Fulltext.getIndexedState(attachment);
      PTLogger.info(`fullText 인덱스 상태: ${state}`);
    }

    // getFullText()는 Zotero item attachment 메서드
    if (typeof attachment.getFullText === "function") {
      const result = await attachment.getFullText();
      return result || "";
    }

    // 대안: Zotero.Fulltext.getFullText
    if (Zotero.Fulltext && typeof Zotero.Fulltext.getFullText === "function") {
      const result = await Zotero.Fulltext.getFullText(attachment.id);
      return (result && result.content) ? result.content : "";
    }

    throw new Error("fullText API를 찾을 수 없습니다.");
  },

  // ── 방법 2: PDFWorker ─────────────────────────────────────────────────────
  async _extractViaPDFWorker(attachment) {
    const filePath = attachment.getFilePath();
    if (!filePath) throw new Error("파일 경로 없음");

    // Zotero.PDFWorker API (Zotero 7+)
    if (Zotero.PDFWorker && typeof Zotero.PDFWorker.getFullText === "function") {
      const result = await Zotero.PDFWorker.getFullText(attachment.id, true);
      return (result && result.text) ? result.text : "";
    }

    throw new Error("PDFWorker API를 찾을 수 없습니다.");
  },
};
