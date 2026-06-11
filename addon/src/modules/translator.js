"use strict";

var PTTranslator = {
  // 입력 chunk ≤ 1500토큰 기준. 한국어 출력은 원문보다 토큰이 늘어나므로 여유 확보.
  MAX_OUTPUT_TOKENS: 8192,

  // ── 단일 chunk 번역 ────────────────────────────────────────────────────────
  // isLastChunk: true면 섹션 요약도 함께 생성
  async translateChunk(job, apiKey, isLastChunk = false) {
    const prompt = this._buildPrompt(job, isLastChunk);

    const reqBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: this.MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
      },
    };

    let resp;
    try {
      // API 키는 URL이 아닌 헤더로 전송 (로그/프록시 노출 방지)
      resp = await fetch(PTConstants.geminiEndpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
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
    const candidate = data?.candidates?.[0];
    const finishReason = candidate?.finishReason || "";
    const raw = (candidate?.content?.parts || []).map(p => p.text || "").join("");

    this._assertUsableResponse(raw, finishReason);
    return this._parseResponse(raw, isLastChunk);
  },

  // ── 응답 유효성 검사 ──────────────────────────────────────────────────────
  // 빈 응답·safety 차단·토큰 한도 잘림을 "done"으로 위장시키지 않는다.
  _assertUsableResponse(raw, finishReason) {
    if (!raw.trim()) {
      const blocked = finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT";
      throw new PTError(
        `빈 응답 (finishReason: ${finishReason || "unknown"})`,
        "EMPTY_RESPONSE",
        { nonRetryable: blocked }
      );
    }
    if (finishReason === "MAX_TOKENS") {
      // 동일 프롬프트 재시도로는 해결되지 않으므로 즉시 실패 처리
      throw new PTError(
        "출력 토큰 한도 초과로 응답이 잘렸습니다. (chunk가 너무 깁니다)",
        "OUTPUT_TRUNCATED",
        { nonRetryable: true }
      );
    }
  },

  // ── 프롬프트 ──────────────────────────────────────────────────────────────
  _buildPrompt(job, isLastChunk) {
    const chunkLabel = job.totalChunks > 1
      ? ` (${job.chunkIndex + 1}/${job.totalChunks})`
      : "";

    const summaryInstruction = isLastChunk
      ? `\n- "summary": 이 섹션 전체 내용을 ${PTPrefs.getSummaryLines()}줄 이내로 한국어 요약`
      : `\n- "summary": ""  (마지막 chunk가 아니므로 빈 문자열)`;

    // 여러 chunk로 나뉜 섹션의 마지막 chunk에는 섹션 전체 개요를 함께 제공해
    // "섹션 전체 요약" 지시가 실제로 성립하도록 한다.
    const summaryContext = isLastChunk && job.summaryContext
      ? `\n\n[섹션 전체 개요 — 요약 작성 시에만 참고, 번역 대상 아님]\n${job.summaryContext}`
      : "";

    return `당신은 ML/CV 학술 논문 전문 번역가입니다.
아래 논문 섹션의 텍스트를 한국어로 번역하세요.

규칙:
- 원문의 문체와 구조를 최대한 유지하세요 (직역 우선)
- 전문 용어는 영어 원문을 괄호 병기하세요 (예: 자기 주의(self-attention))
- 수식, 변수명, 모델명, 데이터셋명은 번역하지 마세요
- 반드시 JSON만 반환하세요 (마크다운 코드블록, 설명 없이)

섹션: ${job.heading}${chunkLabel}

본문:
${job.text}${summaryContext}

반환 형식:
{
  "translation": "번역된 본문 전체"${summaryInstruction.replace("- ", ",\n  ")}
}`;
  },

  // ── 응답 파싱 ─────────────────────────────────────────────────────────────
  _parseResponse(raw, isLastChunk) {
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned);
      const translation = (parsed.translation || "").trim();
      if (!translation) {
        throw new PTError("응답 JSON에 translation이 비어 있습니다.", "EMPTY_TRANSLATION");
      }
      return {
        translation,
        summary: isLastChunk ? (parsed.summary || "") : "",
      };
    } catch (e) {
      if (e instanceof PTError) throw e;
      // JSON처럼 시작하는데 파싱이 깨졌다면 잘린/불완전 JSON — 그대로 저장하면
      // 깨진 JSON이 번역 결과로 둔갑하므로 실패 처리하고 재시도에 맡긴다.
      if (cleaned.startsWith("{")) {
        PTLogger.warn(`불완전 JSON 응답 — chunk 실패 처리: ${e.message}`);
        throw new PTError("응답 JSON 파싱 실패 (불완전한 응답)", "PARSE_FAILED");
      }
      // 모델이 JSON 지시를 무시하고 평문으로 응답한 경우만 평문 fallback 허용
      PTLogger.warn(`JSON 아님 — 평문 응답으로 처리: ${e.message}`);
      return { translation: cleaned, summary: "" };
    }
  },
};
