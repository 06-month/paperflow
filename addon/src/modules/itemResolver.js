"use strict";

var PTItemResolver = {
  // ── 선택된 item에서 번역 대상 PDF attachment 반환 ──────────────────────────
  // 반환: { parentItem, pdfAttachment } 또는 null
  resolve(item) {
    if (!item) return null;

    let parentItem = null;
    let pdfAttachment = null;

    if (item.isAttachment()) {
      // attachment 직접 선택된 경우
      if (item.attachmentContentType !== "application/pdf") {
        throw new PTError("선택한 항목이 PDF가 아닙니다.", "NOT_PDF");
      }
      pdfAttachment = item;
      parentItem = item.parentID ? Zotero.Items.get(item.parentID) : null;
    } else if (item.isRegularItem()) {
      // 논문 item 선택 → 첫 번째 PDF attachment 찾기
      const attachmentIDs = item.getAttachments();
      for (const attID of attachmentIDs) {
        const att = Zotero.Items.get(attID);
        if (att && att.attachmentContentType === "application/pdf") {
          pdfAttachment = att;
          break;
        }
      }
      if (!pdfAttachment) {
        throw new PTError("PDF attachment를 찾을 수 없습니다.", "NO_PDF");
      }
      parentItem = item;
    } else {
      throw new PTError("번역할 수 없는 항목 유형입니다.", "INVALID_ITEM");
    }

    // PDF 파일 경로 확인
    const filePath = pdfAttachment.getFilePath();
    if (!filePath) {
      throw new PTError("PDF 파일 경로를 가져올 수 없습니다. 파일이 로컬에 존재하는지 확인하세요.", "NO_FILE");
    }

    PTLogger.info(`PDF 식별 완료: ${filePath}`);
    return { parentItem, pdfAttachment, filePath };
  },

  // ── Zotero 메인 창에서 현재 선택된 item 가져오기 ──────────────────────────
  getSelectedItem() {
    try {
      const win = Zotero.getMainWindow();
      if (!win) return null;
      const ZoteroPane = win.ZoteroPane;
      if (!ZoteroPane) return null;
      const items = ZoteroPane.getSelectedItems();
      return items && items.length > 0 ? items[0] : null;
    } catch (e) {
      PTLogger.warn(`선택된 item 가져오기 실패: ${e.message}`);
      return null;
    }
  },
};
