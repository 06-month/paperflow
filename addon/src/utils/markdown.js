"use strict";

// Gemini chat 응답용 경량 Markdown renderer.
// 모델 응답을 innerHTML로 주입하지 않고 DOM 노드를 직접 만들어 XSS를 방지한다.
var PTMarkdown = {
  XHTML_NS: "http://www.w3.org/1999/xhtml",

  renderInto(container, markdown) {
    if (!container) return;

    const doc = container.ownerDocument;
    if (!doc) {
      container.textContent = String(markdown || "");
      return;
    }

    container.textContent = "";
    if (container.classList) container.classList.add("pt-msg-markdown");
    this._renderBlocks(container, String(markdown || ""), doc);
  },

  _renderBlocks(parent, markdown, doc) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }

      const fence = line.match(/^ {0,3}(\x60{3,}|~{3,})\s*([A-Za-z0-9_+.-]*)\s*$/);
      if (fence) {
        const marker = fence[1];
        const language = fence[2] || "";
        const body = [];
        i++;
        while (i < lines.length && !this._isClosingFence(lines[i], marker)) {
          body.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;

        const pre = this._element(doc, "pre");
        const code = this._element(doc, "code");
        if (language) code.className = "language-" + language.replace(/[^A-Za-z0-9_+.-]/g, "");
        code.textContent = body.join("\n");
        pre.appendChild(code);
        parent.appendChild(pre);
        continue;
      }

      const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const el = this._element(doc, "h" + heading[1].length);
        this._appendInline(el, heading[2], doc);
        parent.appendChild(el);
        i++;
        continue;
      }

      if (/^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
        parent.appendChild(this._element(doc, "hr"));
        i++;
        continue;
      }

      if (this._isTableStart(lines, i)) {
        i = this._renderTable(parent, lines, i, doc);
        continue;
      }

      if (/^ {0,3}>/.test(line)) {
        const quoted = [];
        while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || !lines[i].trim())) {
          quoted.push(lines[i].replace(/^ {0,3}> ?/, ""));
          i++;
        }
        const blockquote = this._element(doc, "blockquote");
        this._renderBlocks(blockquote, quoted.join("\n"), doc);
        parent.appendChild(blockquote);
        continue;
      }

      const listMatch = this._matchListItem(line);
      if (listMatch) {
        const ordered = listMatch.ordered;
        const list = this._element(doc, ordered ? "ol" : "ul");
        if (ordered && listMatch.start !== 1) list.setAttribute("start", String(listMatch.start));

        while (i < lines.length) {
          const item = this._matchListItem(lines[i]);
          if (!item || item.ordered !== ordered) break;

          const li = this._element(doc, "li");
          this._appendInline(li, item.text, doc);
          i++;

          // 같은 목록 항목에 이어지는 들여쓰기 문장은 줄바꿈하여 보존한다.
          while (i < lines.length
            && lines[i].trim()
            && !this._matchListItem(lines[i])
            && !this._isBlockStart(lines, i)) {
            li.appendChild(this._element(doc, "br"));
            this._appendInline(li, lines[i].trim(), doc);
            i++;
          }
          list.appendChild(li);
        }
        parent.appendChild(list);
        continue;
      }

      const paragraphLines = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !this._isBlockStart(lines, i)) {
        paragraphLines.push(lines[i].trim());
        i++;
      }

      const p = this._element(doc, "p");
      this._appendInline(p, paragraphLines.join("\n"), doc);
      parent.appendChild(p);
    }
  },

  _isBlockStart(lines, index) {
    const line = lines[index] || "";
    return /^ {0,3}(\x60{3,}|~{3,})/.test(line)
      || /^ {0,3}#{1,6}\s+/.test(line)
      || /^ {0,3}>/.test(line)
      || /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)
      || Boolean(this._matchListItem(line))
      || this._isTableStart(lines, index);
  },

  _isClosingFence(line, openingMarker) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed[0] !== openingMarker[0]) return false;
    return trimmed.length >= openingMarker.length
      && Array.from(trimmed).every(ch => ch === openingMarker[0]);
  },

  _matchListItem(line) {
    const match = String(line || "").match(/^\s{0,3}([-+*]|(\d+)[.)])\s+(.+)$/);
    if (!match) return null;
    return {
      ordered: Boolean(match[2]),
      start: match[2] ? parseInt(match[2], 10) : 1,
      text: match[3],
    };
  },

  _isTableStart(lines, index) {
    if (index + 1 >= lines.length || !String(lines[index]).includes("|")) return false;
    const delimiterCells = this._splitTableRow(lines[index + 1]);
    return delimiterCells.length > 0
      && delimiterCells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
  },

  _renderTable(parent, lines, start, doc) {
    const headers = this._splitTableRow(lines[start]);
    const delimiters = this._splitTableRow(lines[start + 1]);
    const table = this._element(doc, "table");
    const thead = this._element(doc, "thead");
    const headRow = this._element(doc, "tr");

    headers.forEach((header, index) => {
      const th = this._element(doc, "th");
      this._applyTableAlignment(th, delimiters[index] || "");
      this._appendInline(th, header.trim(), doc);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = this._element(doc, "tbody");
    let i = start + 2;
    while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
      const tr = this._element(doc, "tr");
      const cells = this._splitTableRow(lines[i]);
      headers.forEach((_, index) => {
        const td = this._element(doc, "td");
        this._applyTableAlignment(td, delimiters[index] || "");
        this._appendInline(td, (cells[index] || "").trim(), doc);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
      i++;
    }
    table.appendChild(tbody);
    parent.appendChild(table);
    return i;
  },

  _splitTableRow(line) {
    let text = String(line || "").trim();
    if (text.startsWith("|")) text = text.slice(1);
    if (text.endsWith("|")) text = text.slice(0, -1);

    const cells = [];
    let current = "";
    let escaped = false;
    for (const ch of text) {
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "|") {
        cells.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (escaped) current += "\\";
    cells.push(current);
    return cells;
  },

  _applyTableAlignment(cell, delimiter) {
    const value = String(delimiter || "").trim();
    if (value.startsWith(":") && value.endsWith(":")) {
      cell.className = "pt-md-align-center";
    } else if (value.endsWith(":")) {
      cell.className = "pt-md-align-right";
    }
  },

  _appendInline(parent, text, doc) {
    const value = String(text || "");
    let buffer = "";
    let i = 0;

    const flush = () => {
      if (!buffer) return;
      parent.appendChild(doc.createTextNode(buffer));
      buffer = "";
    };

    while (i < value.length) {
      if (value[i] === "\\" && i + 1 < value.length && /[\\*_[\]{}()#+.!|>~-]/.test(value[i + 1])) {
        buffer += value[i + 1];
        i += 2;
        continue;
      }

      if (value[i] === "\n") {
        flush();
        parent.appendChild(this._element(doc, "br"));
        i++;
        continue;
      }

      if (value[i] === "\x60") {
        let size = 1;
        while (value[i + size] === "\x60") size++;
        const marker = "\x60".repeat(size);
        const close = value.indexOf(marker, i + size);
        if (close >= 0) {
          flush();
          const code = this._element(doc, "code");
          code.textContent = value.slice(i + size, close).replace(/^ | $/g, "");
          parent.appendChild(code);
          i = close + size;
          continue;
        }
      }

      const strongMarker = value.startsWith("**", i)
        ? "**"
        : (value.startsWith("__", i) ? "__" : null);
      if (strongMarker) {
        const close = value.indexOf(strongMarker, i + 2);
        if (close > i + 2) {
          flush();
          const strong = this._element(doc, "strong");
          this._appendInline(strong, value.slice(i + 2, close), doc);
          parent.appendChild(strong);
          i = close + 2;
          continue;
        }
      }

      if (value.startsWith("~~", i)) {
        const close = value.indexOf("~~", i + 2);
        if (close > i + 2) {
          flush();
          const del = this._element(doc, "del");
          this._appendInline(del, value.slice(i + 2, close), doc);
          parent.appendChild(del);
          i = close + 2;
          continue;
        }
      }

      if (value[i] === "[") {
        const labelEnd = value.indexOf("](", i + 1);
        const urlEnd = labelEnd >= 0 ? value.indexOf(")", labelEnd + 2) : -1;
        if (labelEnd > i + 1 && urlEnd > labelEnd + 2) {
          const label = value.slice(i + 1, labelEnd);
          const href = value.slice(labelEnd + 2, urlEnd).trim();
          const safeHref = this._safeHref(href);
          flush();
          if (safeHref) {
            const link = this._element(doc, "a");
            link.setAttribute("href", safeHref);
            link.setAttribute("rel", "noopener noreferrer");
            this._appendInline(link, label, doc);
            parent.appendChild(link);
          } else {
            this._appendInline(parent, label, doc);
          }
          i = urlEnd + 1;
          continue;
        }
      }

      if (value[i] === "*" || value[i] === "_") {
        const marker = value[i];
        const close = value.indexOf(marker, i + 1);
        if (close > i + 1) {
          flush();
          const em = this._element(doc, "em");
          this._appendInline(em, value.slice(i + 1, close), doc);
          parent.appendChild(em);
          i = close + 1;
          continue;
        }
      }

      buffer += value[i];
      i++;
    }
    flush();
  },

  _safeHref(href) {
    const value = String(href || "").trim();
    if (/^https?:\/\//i.test(value)) return value;
    if (/^mailto:/i.test(value)) return value;
    if (/^zotero:/i.test(value)) return value;
    if (/^#[A-Za-z0-9_.:-]+$/.test(value)) return value;
    return "";
  },

  _element(doc, tag) {
    if (typeof doc.createElementNS === "function") {
      return doc.createElementNS(this.XHTML_NS, tag);
    }
    return doc.createElement(tag);
  },
};
