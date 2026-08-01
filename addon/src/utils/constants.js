"use strict";

// 플러그인 전역 상수. 모델명/버전은 반드시 여기서만 정의한다.
var PTConstants = {
  // manifest.json의 version과 일치시킬 것
  VERSION: "0.5.3",

  MODEL_NAME: "gemini-3.1-flash-lite",
  MODEL_LABEL: "Gemini 3.1 Flash-Lite",

  API_BASE: "https://generativelanguage.googleapis.com/v1beta/models",

  // 채팅 입력창에서 천천히 번갈아 보여주는 추천 질문.
  // 사이드바 폭에서도 잘리지 않도록 한 줄 분량으로 유지한다.
  CHAT_SUGGESTIONS: [
    "이 논문의 배경을 분석해서 설명해줘",
    "메서드를 이해하기 쉽게 설명해줘",
    "핵심 기여를 세 가지로 정리해줘",
    "실험 결과에서 중요한 수치를 짚어줘",
    "이 연구의 한계는 무엇인지 알려줘",
    "기존 연구와 무엇이 다른지 비교해줘",
    "수식이 의미하는 바를 풀어서 설명해줘",
    "데이터셋과 실험 설정을 정리해줘",
    "이 논문을 세 문장으로 요약해줘",
    "후속 연구로 이어갈 주제를 제안해줘",
  ],

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
