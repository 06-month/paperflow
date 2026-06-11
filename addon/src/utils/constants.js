"use strict";

// 플러그인 전역 상수. 모델명/버전은 반드시 여기서만 정의한다.
var PTConstants = {
  // manifest.json의 version과 일치시킬 것
  VERSION: "0.4.0",

  MODEL_NAME: "gemini-3.1-flash-lite",
  MODEL_LABEL: "Gemini 3.1 Flash-Lite",

  API_BASE: "https://generativelanguage.googleapis.com/v1beta/models",

  geminiEndpoint(modelName) {
    return `${this.API_BASE}/${modelName || this.MODEL_NAME}:generateContent`;
  },

  // chunk 텍스트 동일성 검증용 경량 해시 (djb2)
  hashText(text) {
    const s = String(text || "");
    let hash = 5381;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  },
};
