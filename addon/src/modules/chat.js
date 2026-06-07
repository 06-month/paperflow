"use strict";

var PTChat = {
  MAX_CONTEXT_CHARS: 24000,

  async ask(question, bundle, opts = {}) {
    const apiKey = PTPrefs.getApiKey();
    if (!apiKey) throw new PTApiError("API 키가 설정되지 않았습니다.", 403);
    if (!question || !question.trim()) throw new Error("질문이 비어 있습니다.");

    const title = bundle?.meta?.title || opts.title || "제목 없음";
    const context = this._buildContext(bundle);
    const prompt = this._buildPrompt(title, context, question.trim());

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048,
        },
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new PTApiError(`Gemini API 오류 ${res.status}: ${raw.slice(0, 500)}`, res.status);
    }

    let data;
    try { data = JSON.parse(raw); } catch (_) { return raw.trim(); }
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n").trim();
    return text || "응답을 생성하지 못했습니다.";
  },

  _buildContext(bundle) {
    const parts = [];
    if (bundle?.sections?.length) {
      const walk = (secs, depth = 0) => {
        for (const sec of secs) {
          parts.push(`${"#".repeat(Math.min(depth + 2, 6))} ${sec.heading || "Untitled"}`);
          if (sec.summary) parts.push(`[요약]\n${sec.summary}`);
          if (sec.translation) parts.push(`[번역]\n${sec.translation}`);
          if ((!sec.translation || sec.translation.length < 100) && sec.body) parts.push(`[원문]\n${sec.body.slice(0, 3000)}`);
          if (sec.subsections?.length) walk(sec.subsections, depth + 1);
        }
      };
      walk(bundle.sections);
    } else if (bundle?.htmlText) {
      parts.push(bundle.htmlText.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
    }

    let ctx = parts.join("\n\n").trim();
    if (ctx.length > this.MAX_CONTEXT_CHARS) {
      ctx = ctx.slice(0, this.MAX_CONTEXT_CHARS) + "\n\n[문맥이 길어 앞부분 기준으로 잘렸습니다.]";
    }
    return ctx || "번역 문맥을 찾지 못했습니다.";
  },

  _buildPrompt(title, context, question) {
    return `당신은 사용자가 Zotero에 저장한 논문 번역본을 근거로 답하는 연구 보조자입니다.\n\n규칙:\n- 아래 제공된 번역/요약/원문 문맥 안에서만 답하세요.\n- 문맥에 없는 내용은 추측하지 말고 \"번역된 문맥만으로는 확인할 수 없습니다\"라고 말하세요.\n- 한국어로 답하세요.\n- 논문 용어는 필요한 경우 영어 원어를 괄호에 병기하세요.\n- 가능한 한 어느 섹션 근거인지 함께 언급하세요.\n\n논문 제목: ${title}\n\n[번역 문맥]\n${context}\n\n[사용자 질문]\n${question}\n\n[답변]`;
  },
};
