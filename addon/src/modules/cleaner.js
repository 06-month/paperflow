"use strict";

var PTCleaner = {
  // ── 메인: raw text → 정제된 text ─────────────────────────────────────────
  clean(rawText, opts = {}) {
    const skipReferences = opts.skipReferences !== false;

    let text = rawText;

    // 1. 줄 단위로 처리
    let lines = text.split("\n");

    // 2. header/footer 제거 (페이지 번호, 저널명 반복 패턴)
    lines = this._removeHeaderFooter(lines);

    // 3. 빈 줄 과다 제거 (연속 3줄 이상 → 2줄로)
    lines = this._collapseBlankLines(lines);

    // 4. References 이후 제거 (옵션)
    if (skipReferences) {
      lines = this._truncateAtReferences(lines);
    }

    // 5. URL, DOI 라인 제거
    lines = this._removeUrlLines(lines);

    text = lines.join("\n").trim();

    PTLogger.info(`정제 완료: ${rawText.length}자 → ${text.length}자`);
    return text;
  },

  // ── header/footer 감지 및 제거 ────────────────────────────────────────────
  // 전략: 짧은 줄 중 여러 페이지에 반복되는 패턴 제거
  _removeHeaderFooter(lines) {
    const results = [];
    for (const line of lines) {
      const trimmed = line.trim();

      // 페이지 번호 단독 줄 (숫자만, 또는 "- 3 -", "3 of 12")
      if (/^-?\s*\d+\s*-?$/.test(trimmed)) continue;
      if (/^\d+\s+of\s+\d+$/i.test(trimmed)) continue;

      // arXiv preprint 헤더 ("arXiv:xxxx.xxxxx [cs.CV]")
      if (/^arXiv:\d{4}\.\d{4,5}/i.test(trimmed)) continue;

      // "Preprint. Under review." 같은 패턴
      if (/^Preprint\./i.test(trimmed)) continue;
      if (/^Under review/i.test(trimmed)) continue;
      if (/^Submitted to/i.test(trimmed)) continue;
      if (/^Published in/i.test(trimmed)) continue;
      if (/^Proceedings of/i.test(trimmed)) continue;
      if (/^Conference on/i.test(trimmed)) continue;

      results.push(line);
    }
    return results;
  },

  // ── 빈 줄 정리 ────────────────────────────────────────────────────────────
  _collapseBlankLines(lines) {
    const results = [];
    let blankCount = 0;
    for (const line of lines) {
      if (line.trim() === "") {
        blankCount++;
        if (blankCount <= 2) results.push(line);
      } else {
        blankCount = 0;
        results.push(line);
      }
    }
    return results;
  },

  // ── References 이후 잘라내기 ─────────────────────────────────────────────
  _truncateAtReferences(lines) {
    const refPatterns = [
      /^References?\s*$/i,
      /^Bibliography\s*$/i,
      /^\d+\.\s*References?\s*$/i,
      /^[IVX]+\.\s*References?\s*$/i,
    ];

    let refIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (refPatterns.some(p => p.test(trimmed))) {
        // References가 너무 앞에 있으면 (전체의 70% 이전) 무시
        if (i > lines.length * 0.5) {
          refIdx = i;
          break;
        }
      }
    }

    if (refIdx > 0) {
      PTLogger.info(`References 제거: ${lines.length}줄 → ${refIdx}줄`);
      return lines.slice(0, refIdx);
    }
    return lines;
  },

  // ── URL/DOI 단독 줄 제거 ─────────────────────────────────────────────────
  _removeUrlLines(lines) {
    return lines.filter(line => {
      const t = line.trim();
      if (/^https?:\/\/\S+$/.test(t)) return false;
      if (/^doi:\s*10\.\d{4}/i.test(t)) return false;
      return true;
    });
  },
};
