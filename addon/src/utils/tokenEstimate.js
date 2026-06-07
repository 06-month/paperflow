"use strict";

var PTTokenEstimate = {
  // 영어: 1 token ≈ 4자, 한국어: 1 token ≈ 1.5자
  // 논문 텍스트(영어 위주) 기준 보수적으로 4자/token
  CHARS_PER_TOKEN: 4,

  estimate(text) {
    if (!text) return 0;
    return Math.ceil(text.length / this.CHARS_PER_TOKEN);
  },

  // chunk이 maxTokens 이하인지 확인
  fits(text, maxTokens) {
    return this.estimate(text) <= maxTokens;
  },
};
