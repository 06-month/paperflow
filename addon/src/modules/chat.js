"use strict";

var PTChat = {
  MAX_CONTEXT_CHARS: 24000,
  MAX_HISTORY_TURNS: 6,

  // opts.history: [{ role: "user"|"assistant", text }] — 이전 대화 턴
  async ask(question, bundle, opts = {}) {
    const apiKey = PTPrefs.getApiKey();
    if (!apiKey) throw new PTApiError("API 키가 설정되지 않았습니다.", 403);
    if (!question || !question.trim()) throw new Error("질문이 비어 있습니다.");

    const title = bundle?.meta?.title || opts.title || "제목 없음";
    const context = this._buildContext(bundle);
    const history = this._formatHistory(opts.history);
    const attachments = this._formatAttachments(opts.attachments);
    // 이미지/PDF 등 바이너리 첨부 (Gemini inline_data 멀티모달)
    const media = Array.isArray(opts.media)
      ? opts.media.filter(m => m && m.data && m.mimeType)
      : [];
    const mediaList = this._formatMediaList(media);
    const prompt = this._buildPrompt(title, context, attachments, mediaList, history, question.trim());

    const parts = [{ text: prompt }];
    for (const m of media) {
      parts.push({ inline_data: { mime_type: m.mimeType, data: m.data } });
    }

    // 번역과 동일한 무료 티어 쿼터를 공유하므로 rate limiter를 거친다
    await PTRateLimiter.waitForSlot();

    const res = await fetch(PTConstants.geminiEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts }],
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

  // ── 컨텍스트 구성 ─────────────────────────────────────────────────────────
  // 1차: 모든 섹션의 헤딩+요약 (논문 전체 커버리지 보장)
  // 2차: 남은 예산으로 섹션별 번역 본문을 앞에서부터 추가
  _buildContext(bundle) {
    const flat = [];
    const collect = (secs, depth = 0) => {
      for (const sec of secs || []) {
        flat.push({ sec, depth });
        if (sec.subsections?.length) collect(sec.subsections, depth + 1);
      }
    };
    collect(bundle?.sections);

    const parts = [];
    let used = 0;
    const push = (text) => {
      if (!text) return false;
      if (used + text.length + 2 > this.MAX_CONTEXT_CHARS) return false;
      parts.push(text);
      used += text.length + 2;
      return true;
    };

    if (bundle?.noteHTML) {
      const noteText = bundle.noteHTML
        .replace(/<!-- PT_META:[\s\S]*?-->/g, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (noteText) push(`[요약 노트]\n${noteText.slice(0, 4000)}`);
    }

    if (flat.length) {
      // 1차: 전체 섹션 요약 — 긴 논문에서도 후반 섹션이 컨텍스트에 들어가도록
      for (const { sec, depth } of flat) {
        const heading = `${"#".repeat(Math.min(depth + 2, 6))} ${sec.heading || "Untitled"}`;
        if (sec.summary) {
          if (!push(`${heading}\n[요약] ${sec.summary}`)) break;
        } else {
          if (!push(heading)) break;
        }
      }
      // 2차: 번역 본문 (예산 내에서)
      for (const { sec } of flat) {
        if (!sec.translation) continue;
        const remaining = this.MAX_CONTEXT_CHARS - used;
        if (remaining < 500) break;
        const body = sec.translation.length > remaining - 100
          ? sec.translation.slice(0, remaining - 100) + "\n[...이하 생략]"
          : sec.translation;
        if (!push(`[번역: ${sec.heading || "Untitled"}]\n${body}`)) break;
      }
      // 번역이 거의 없으면 원문이라도 제공
      for (const { sec } of flat) {
        if (sec.translation && sec.translation.length >= 100) continue;
        if (!sec.body) continue;
        if (!push(`[원문: ${sec.heading || "Untitled"}]\n${sec.body.slice(0, 3000)}`)) break;
      }
    } else if (bundle?.htmlText) {
      push(
        bundle.htmlText
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, this.MAX_CONTEXT_CHARS)
      );
    }

    return parts.join("\n\n").trim() || "번역 문맥을 찾지 못했습니다.";
  },

  // 사용자가 첨부한 발췌/자료 — 출처 라벨과 함께 프롬프트에 포함
  // opts.attachments: [{ label, text }]
  _formatAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";
    const MAX_TOTAL = 9000;
    let used = 0;
    const blocks = [];
    attachments.forEach((att, i) => {
      if (!att || !att.text) return;
      const remaining = MAX_TOTAL - used;
      if (remaining < 200) return;
      const body = att.text.length > remaining
        ? att.text.slice(0, remaining) + "\n[...길이 제한으로 잘림]"
        : att.text;
      used += body.length;
      blocks.push(`(${i + 1}) ${att.label || "첨부 자료"}:\n"""\n${body}\n"""`);
    });
    return blocks.length ? `[사용자가 첨부한 자료]\n${blocks.join("\n\n")}\n\n` : "";
  },

  // 바이너리 첨부 목록을 프롬프트에 명시 — 모델이 어떤 미디어가 왜 왔는지 알도록
  _formatMediaList(media) {
    if (!media.length) return "";
    const lines = media.map((m, i) => `(${i + 1}) ${m.label || m.mimeType} — 이 메시지에 함께 첨부됨`);
    return `[첨부된 이미지/문서]\n${lines.join("\n")}\n\n`;
  },

  _formatHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return "";
    const recent = history.slice(-this.MAX_HISTORY_TURNS * 2);
    const lines = recent
      .filter(turn => turn && turn.text)
      .map(turn => `${turn.role === "user" ? "사용자" : "보조자"}: ${String(turn.text).slice(0, 1500)}`);
    return lines.length ? `[이전 대화]\n${lines.join("\n")}\n\n` : "";
  },

  _buildPrompt(title, context, attachments, mediaList, history, question) {
    return `당신은 사용자가 Zotero에 저장한 논문 번역본을 근거로 답하는 연구 보조자입니다.\n\n규칙:\n- 아래 제공된 번역/요약/원문 문맥과 사용자가 첨부한 자료 안에서만 답하세요.\n- 사용자가 발췌·이미지·문서를 첨부했다면 그것이 질문의 직접 대상이므로 우선 근거로 삼으세요.\n- 문맥에 없는 내용은 추측하지 말고 \"번역된 문맥만으로는 확인할 수 없습니다\"라고 말하세요.\n- 한국어로 답하세요.\n- 논문 용어는 필요한 경우 영어 원어를 괄호에 병기하세요.\n- 가능한 한 어느 섹션(또는 어느 첨부 자료) 근거인지 함께 언급하세요.\n- 이전 대화가 있으면 그 맥락을 이어서 답하세요.\n\n논문 제목: ${title}\n\n[번역 문맥]\n${context}\n\n${attachments}${mediaList}${history}[사용자 질문]\n${question}\n\n[답변]`;
  },
};
