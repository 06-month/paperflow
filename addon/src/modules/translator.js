"use strict";

var PTTranslator = {
  _apiBase: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",

  // ── 단일 chunk 번역 ────────────────────────────────────────────────────────
  // isLastChunk: true면 섹션 요약도 함께 생성
  async translateChunk(job, apiKey, isLastChunk = false) {
    const prompt = this._buildPrompt(job, isLastChunk);

    const reqBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    };

    let resp;
    try {
      resp = await fetch(`${this._apiBase}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
    } catch (e) {
      throw new PTError(`네트워크 오류: ${e.message}`, "NETWORK_ERROR");
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("Retry-After") || "10", 10) * 1000;
        throw new PTRateLimitError(retryAfter);
      }
      throw new PTApiError(
        `Gemini API 오류 ${resp.status}: ${body.slice(0, 300)}`,
        resp.status
      );
    }

    const data = await resp.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return this._parseResponse(raw, isLastChunk);
  },

  // ── 프롬프트 ──────────────────────────────────────────────────────────────
  _buildPrompt(job, isLastChunk) {
    const chunkLabel = job.totalChunks > 1
      ? ` (${job.chunkIndex + 1}/${job.totalChunks})`
      : "";

    const summaryInstruction = isLastChunk
      ? `\n- "summary": 이 섹션 전체 내용을 ${PTPrefs.getSummaryLines()}줄 이내로 한국어 요약`
      : `\n- "summary": ""  (마지막 chunk가 아니므로 빈 문자열)`;

    return `당신은 ML/CV 학술 논문 전문 번역가입니다.
아래 논문 섹션의 텍스트를 한국어로 번역하세요.

규칙:
- 원문의 문체와 구조를 최대한 유지하세요 (직역 우선)
- 전문 용어는 영어 원문을 괄호 병기하세요 (예: 자기 주의(self-attention))
- 수식, 변수명, 모델명, 데이터셋명은 번역하지 마세요
- 반드시 JSON만 반환하세요 (마크다운 코드블록, 설명 없이)

섹션: ${job.heading}${chunkLabel}

본문:
${job.text}

반환 형식:
{
  "translation": "번역된 본문 전체"${summaryInstruction.replace("- ", ",\n  ")}
}`;
  },

  // ── 응답 파싱 ─────────────────────────────────────────────────────────────
  _parseResponse(raw, isLastChunk) {
    try {
      const cleaned = raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      return {
        translation: parsed.translation || "",
        summary: isLastChunk ? (parsed.summary || "") : "",
      };
    } catch (e) {
      PTLogger.warn(`JSON 파싱 실패 — raw 텍스트로 대체: ${e.message}`);
      return { translation: raw.trim(), summary: "" };
    }
  },
};
