"use strict";

var PTChunker = {
  // 청크당 최대 토큰 (입력 1500토큰 ≈ 6000자)
  // 한국어 번역 출력은 원문보다 토큰이 늘어나므로 maxOutputTokens 한도 내에
  // 안전하게 들어오도록 입력을 보수적으로 잡는다.
  MAX_CHUNK_TOKENS: 1500,

  // 마지막 chunk에 첨부하는 섹션 개요(요약 생성용) 최대 길이
  MAX_SUMMARY_CONTEXT_CHARS: 6000,

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
          const isLast = idx === chunks.length - 1;
          jobs.push({
            chunkId: `${section.id}_c${idx}`,
            sectionId: section.id,
            heading: section.heading,
            text,
            chunkIndex: idx,
            totalChunks: chunks.length,
            // 여러 chunk로 나뉜 섹션의 마지막 chunk에는 섹션 전체 개요를 첨부해
            // "섹션 전체 요약"이 마지막 chunk 내용만으로 만들어지지 않게 한다
            summaryContext: (isLast && chunks.length > 1)
              ? body.slice(0, this.MAX_SUMMARY_CONTEXT_CHARS)
              : "",
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
