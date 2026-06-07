"use strict";

var PTSectionizer = {
  // 섹션 헤딩 패턴 (레벨 포함)
  _patterns: [
    // level 1: Abstract, Introduction, ... (단독 키워드)
    { level: 1, re: /^(Abstract|Introduction|Related Work|Background|Preliminaries|Motivation|Problem Statement|Method(?:ology)?|Approach|Model|Framework|System|Architecture|Experiment(?:s)?|Evaluation|Results?|Analysis|Discussion|Limitation(?:s)?|Conclusion(?:s)?|Future Work|Acknowledgement(?:s)?|Appendix)$/i },
    // level 1: "1 Introduction", "1. Introduction"
    { level: 1, re: /^(\d+)\.?\s+([A-Z][A-Za-z\s\-:&]{2,60})$/, notSub: true },
    // level 1: "I. Introduction"
    { level: 1, re: /^([IVX]+)\.\s+([A-Z][A-Za-z\s\-:&]{2,60})$/ },
    // level 2: "1.1 Overview", "1.1. Overview"
    { level: 2, re: /^(\d+\.\d+)\.?\s+([A-Z][A-Za-z\s\-:&]{2,60})$/ },
    // level 2: "A. Setup" (subsection in IEEE style)
    { level: 2, re: /^([A-Z])\.\s+([A-Z][A-Za-z\s\-:&]{2,60})$/ },
    // level 3: "1.1.1 Details"
    { level: 3, re: /^(\d+\.\d+\.\d+)\.?\s+([A-Z][A-Za-z\s\-:&]{2,60})$/ },
  ],

  // ── 메인: 정제 텍스트 → 섹션 트리 ────────────────────────────────────────
  sectionize(text) {
    const lines = text.split("\n");
    const flat = this._buildFlatSections(lines);

    if (flat.length === 0) {
      PTLogger.warn("섹션 감지 실패 — 전체를 단일 섹션으로 처리");
      return [{
        id: "s0",
        heading: "본문 전체",
        level: 1,
        body: text.trim(),
        subsections: [],
      }];
    }

    PTLogger.info(`섹션 감지: ${flat.length}개`);
    return this._nestSections(flat);
  },

  // ── flat 섹션 리스트 생성 ─────────────────────────────────────────────────
  _buildFlatSections(lines) {
    const sections = [];
    let current = null;
    let bodyLines = [];
    let sectionIdx = 0;

    const flush = () => {
      if (current) {
        current.body = bodyLines.join("\n").trim();
        sections.push(current);
      }
    };

    for (const line of lines) {
      const trimmed = line.trim();
      const headingInfo = this._detectHeading(trimmed);

      if (headingInfo) {
        flush();
        current = {
          id: `s${sectionIdx++}`,
          heading: trimmed,
          level: headingInfo.level,
          body: "",
          subsections: [],
        };
        bodyLines = [];
      } else if (current) {
        bodyLines.push(line);
      }
      // current가 없으면(논문 시작 전 메타데이터) 무시
    }
    flush();

    return sections;
  },

  // ── 헤딩 감지 ─────────────────────────────────────────────────────────────
  _detectHeading(line) {
    if (!line || line.length < 2 || line.length > 100) return null;
    // 소문자로 시작하는 줄은 헤딩 아님
    if (/^[a-z]/.test(line)) return null;
    // 마침표로 끝나는 줄은 문장일 가능성 높음
    if (/[.!?]$/.test(line) && line.length > 40) return null;

    for (const { level, re, notSub } of this._patterns) {
      if (re.test(line)) {
        // notSub: "1 word" 같은 1단어 숫자+단어는 헤딩으로 보지 않음
        if (notSub) {
          const wordCount = line.replace(/^\d+\.?\s+/, "").split(/\s+/).length;
          if (wordCount < 1) return null;
        }
        return { level };
      }
    }
    return null;
  },

  // ── flat → 트리 중첩 ──────────────────────────────────────────────────────
  _nestSections(flat) {
    const root = [];
    // stack: 각 레벨의 마지막 섹션 추적
    const stack = [];

    for (const section of flat) {
      const level = section.level;

      // 현재 레벨보다 높거나 같은 항목 팝
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      if (stack.length === 0) {
        root.push(section);
      } else {
        const parent = stack[stack.length - 1].section;
        parent.subsections.push(section);
      }

      stack.push({ level, section });
    }

    return root;
  },
};
