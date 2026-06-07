"use strict";

var PTChunker = {
  // 청크당 최대 토큰 (Gemini 출력 안정성 고려, 입력 2000토큰 ≈ 8000자)
  MAX_CHUNK_TOKENS: 2000,

  // ── 섹션 트리 전체를 chunk 작업 배열로 변환 ──────────────────────────────
  // 반환: [{ chunkId, sectionId, heading, text, chunkIndex, totalChunks }]
  buildJobs(sections) {
    const jobs = [];
    this._processSection(sections, jobs);
    PTLogger.info(`청킹 완료: ${jobs.length}개 chunk`);
    return jobs;
  },

  _processSection(sections, jobs) {
    for (const section of sections) {
      const body = section.body || "";
      if (body.trim().length > 0) {
        const chunks = this._splitBody(body);
        chunks.forEach((text, idx) => {
          jobs.push({
            chunkId: `${section.id}_c${idx}`,
            sectionId: section.id,
            heading: section.heading,
            text,
            chunkIndex: idx,
            totalChunks: chunks.length,
            // 번역 결과 초기값
            translation: "",
            summary: "",       // 섹션의 마지막 chunk에만 생성
            status: "pending", // pending | running | done | failed
            retries: 0,
            error: null,
          });
        });
      }

      // 하위 섹션 재귀 처리
      if (section.subsections && section.subsections.length > 0) {
        this._processSection(section.subsections, jobs);
      }
    }
  },

  // ── body 텍스트를 MAX_CHUNK_TOKENS 이하로 분할 ───────────────────────────
  _splitBody(body) {
    const maxChars = this.MAX_CHUNK_TOKENS * PTTokenEstimate.CHARS_PER_TOKEN;

    if (body.length <= maxChars) return [body];

    const chunks = [];
    // 문단 단위로 먼저 분리
    const paragraphs = body.split(/\n\n+/);
    let current = "";

    for (const para of paragraphs) {
      const candidate = current ? `${current}\n\n${para}` : para;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        if (current) chunks.push(current.trim());
        // 단락 자체가 너무 길면 문장 단위로 분리
        if (para.length > maxChars) {
          const sentenceChunks = this._splitBySentence(para, maxChars);
          sentenceChunks.forEach((c, i) => {
            if (i < sentenceChunks.length - 1) {
              chunks.push(c.trim());
            } else {
              current = c;
            }
          });
        } else {
          current = para;
        }
      }
    }
    if (current.trim()) chunks.push(current.trim());

    return chunks.filter(c => c.length > 0);
  },

  _splitBySentence(text, maxChars) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks = [];
    let current = "";
    for (const s of sentences) {
      const candidate = current ? `${current} ${s}` : s;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        if (current) chunks.push(current.trim());
        current = s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  },
};
