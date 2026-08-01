"use strict";

// Safe, dependency-free renderer for Gemini chat responses. It builds DOM
// nodes directly (never injects model output with innerHTML) and converts the
// LaTeX commonly emitted in academic answers to native Presentation MathML.
var PTResponseRenderer = {
  XHTML_NS: "http://www.w3.org/1999/xhtml",
  MATH_NS: "http://www.w3.org/1998/Math/MathML",

  render(container, source) {
    if (!container) return;
    container.textContent = "";
    container.classList.add("pt-markdown");
    const text = String(source || "")
      .replace(/\r\n?/g, "\n")
      // Gemini occasionally emits TeX delimiters instead of Markdown dollar
      // delimiters. Normalize both forms before block/inline parsing.
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\(([^\n]*?)\\\)/g, (_, body) => `$${body.trim()}$`);
    this._renderBlocks(container, text.split("\n"));
  },

  _html(doc, tag, className, text) {
    const el = doc.createElementNS(this.XHTML_NS, tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  },

  _renderBlocks(parent, lines) {
    const doc = parent.ownerDocument;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        if (i < lines.length) i++;
        const pre = this._html(doc, "pre", "pt-md-code-block");
        const code = this._html(doc, "code", fence[1] ? `language-${fence[1]}` : "", body.join("\n"));
        pre.appendChild(code);
        parent.appendChild(pre);
        continue;
      }

      if (/^\s*\$\$/.test(line)) {
        let first = line.replace(/^\s*\$\$/, "");
        const body = [];
        if (/\$\$\s*$/.test(first)) {
          body.push(first.replace(/\$\$\s*$/, ""));
          i++;
        } else {
          if (first) body.push(first);
          i++;
          while (i < lines.length && !/\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
          if (i < lines.length) body.push(lines[i++].replace(/\$\$\s*$/, ""));
        }
        parent.appendChild(this._renderMath(doc, body.join("\n").trim(), true));
        continue;
      }

      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const h = this._html(doc, `h${heading[1].length}`);
        this._renderInline(h, heading[2]);
        parent.appendChild(h);
        i++;
        continue;
      }

      if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
        parent.appendChild(this._html(doc, "hr"));
        i++;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quoteLines.push(lines[i++].replace(/^\s*>\s?/, ""));
        }
        const quote = this._html(doc, "blockquote");
        this._renderBlocks(quote, quoteLines);
        parent.appendChild(quote);
        continue;
      }

      if (i + 1 < lines.length && this._isTableSeparator(lines[i + 1]) && line.includes("|")) {
        const tableLines = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) tableLines.push(lines[i++]);
        parent.appendChild(this._renderTable(doc, tableLines));
        continue;
      }

      const listMatch = line.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
      if (listMatch) {
        const ordered = /^\d/.test(listMatch[1]);
        const list = this._html(doc, ordered ? "ol" : "ul");
        while (i < lines.length) {
          const match = lines[i].match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
          if (!match || /^\d/.test(match[1]) !== ordered) break;
          const li = this._html(doc, "li");
          let itemText = match[2];
          const task = itemText.match(/^\[([ xX])\]\s*(.*)$/);
          if (task) {
            const checkbox = this._html(doc, "input", "pt-md-task");
            checkbox.setAttribute("type", "checkbox");
            checkbox.setAttribute("disabled", "true");
            if (task[1].toLowerCase() === "x") checkbox.setAttribute("checked", "true");
            li.appendChild(checkbox);
            itemText = task[2];
          }
          this._renderInline(li, itemText);
          list.appendChild(li);
          i++;
        }
        parent.appendChild(list);
        continue;
      }

      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !this._startsBlock(lines, i)) {
        paragraph.push(lines[i++]);
      }
      if (!paragraph.length) paragraph.push(lines[i++]);
      const p = this._html(doc, "p");
      paragraph.forEach((part, index) => {
        if (index) p.appendChild(this._html(doc, "br"));
        this._renderInline(p, part.replace(/\s{2}$/, ""));
      });
      parent.appendChild(p);
    }
  },

  _startsBlock(lines, i) {
    const line = lines[i] || "";
    if (/^\s*```/.test(line) || /^\s*\$\$/.test(line) || /^\s{0,3}#{1,6}\s/.test(line)) return true;
    if (/^\s*>/.test(line) || /^\s{0,3}([-+*]|\d+[.)])\s+/.test(line)) return true;
    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) return true;
    return i + 1 < lines.length && line.includes("|") && this._isTableSeparator(lines[i + 1]);
  },

  _isTableSeparator(line) {
    const cells = this._splitTableRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
  },

  _splitTableRow(line) {
    let text = String(line || "").trim();
    if (text.startsWith("|")) text = text.slice(1);
    if (text.endsWith("|")) text = text.slice(0, -1);
    const cells = [];
    let current = "";
    let escaped = false;
    for (const char of text) {
      if (escaped) { current += char; escaped = false; continue; }
      if (char === "\\") { current += char; escaped = true; continue; }
      if (char === "|") { cells.push(current.trim()); current = ""; }
      else current += char;
    }
    cells.push(current.trim());
    return cells;
  },

  _renderTable(doc, lines) {
    const tableWrap = this._html(doc, "div", "pt-md-table-wrap");
    const table = this._html(doc, "table", "pt-md-table");
    const head = this._html(doc, "thead");
    const headRow = this._html(doc, "tr");
    const alignments = this._splitTableRow(lines[1]).map(cell => {
      const left = /^:/.test(cell.trim());
      const right = /:$/.test(cell.trim());
      return left && right ? "center" : right ? "right" : "left";
    });
    for (const cell of this._splitTableRow(lines[0])) {
      const th = this._html(doc, "th");
      this._renderInline(th, cell);
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = this._html(doc, "tbody");
    for (const line of lines.slice(2)) {
      const row = this._html(doc, "tr");
      this._splitTableRow(line).forEach((cell, index) => {
        const td = this._html(doc, "td");
        td.style.textAlign = alignments[index] || "left";
        this._renderInline(td, cell);
        row.appendChild(td);
      });
      body.appendChild(row);
    }
    table.appendChild(body);
    tableWrap.appendChild(table);
    return tableWrap;
  },

  _renderInline(parent, source) {
    const doc = parent.ownerDocument;
    const text = String(source || "");
    const patterns = [
      { type: "image", re: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/ },
      { type: "link", re: /\[([^\]]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/ },
      { type: "code", re: /`([^`]+)`/ },
      { type: "math", re: /(?<!\\)\$(?!\$)([^\n$]+?)(?<!\\)\$/ },
      { type: "bold", re: /\*\*([^*]+?)\*\*|__([^_]+?)__/ },
      { type: "strike", re: /~~([^~]+?)~~/ },
      { type: "italic", re: /(?<!\*)\*([^*\n]+?)\*(?!\*)|(?<!_)_([^_\n]+?)_(?!_)/ },
      { type: "autolink", re: /<((?:https?:\/\/|mailto:)[^>]+)>/ },
    ];
    let rest = text;
    while (rest) {
      let found = null;
      for (const pattern of patterns) {
        const match = pattern.re.exec(rest);
        if (match && (!found || match.index < found.match.index)) found = { ...pattern, match };
      }
      if (!found) {
        parent.appendChild(doc.createTextNode(this._unescapeMarkdown(rest)));
        break;
      }
      if (found.match.index) {
        parent.appendChild(doc.createTextNode(this._unescapeMarkdown(rest.slice(0, found.match.index))));
      }
      const m = found.match;
      if (found.type === "code") {
        parent.appendChild(this._html(doc, "code", "pt-md-inline-code", m[1]));
      } else if (found.type === "math") {
        parent.appendChild(this._renderMath(doc, m[1], false));
      } else if (found.type === "bold" || found.type === "italic" || found.type === "strike") {
        const el = this._html(doc, found.type === "bold" ? "strong" : found.type === "italic" ? "em" : "s");
        this._renderInline(el, m[1] || m[2] || "");
        parent.appendChild(el);
      } else if (found.type === "link" || found.type === "autolink") {
        const label = found.type === "link" ? m[1] : m[1];
        const href = found.type === "link" ? m[2] : m[1];
        const link = this._safeLink(doc, href, label);
        parent.appendChild(link || doc.createTextNode(label));
      } else if (found.type === "image") {
        const link = this._safeLink(doc, m[2], `이미지: ${m[1] || m[2]}`);
        parent.appendChild(link || doc.createTextNode(`[이미지: ${m[1] || "첨부"}]`));
      }
      rest = rest.slice(m.index + m[0].length);
    }
  },

  _safeLink(doc, rawHref, label) {
    const href = String(rawHref || "").trim();
    if (!/^(https?:\/\/|mailto:)/i.test(href)) return null;
    const a = this._html(doc, "a", "", label);
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    return a;
  },

  _unescapeMarkdown(text) {
    return String(text || "").replace(/\\([\\`*{}\[\]()#+.!_>~$|-])/g, "$1");
  },

  _renderMath(doc, rawLatex, display) {
    let latex = String(rawLatex || "").trim();
    let label = "";
    latex = latex.replace(/\\tag\*?\{([^{}]*)\}/g, (_, value) => { label = value; return ""; });
    const wrap = this._html(doc, display ? "div" : "span", display ? "pt-md-math-block" : "pt-md-math-inline");
    try {
      const parser = new PTLatexMathMLParser(doc, latex, display);
      const math = parser.parse();
      math.setAttribute("display", display ? "block" : "inline");
      wrap.appendChild(math);
    } catch (_) {
      wrap.appendChild(this._html(doc, "code", "pt-md-math-fallback", latex));
    }
    if (display && label) wrap.appendChild(this._html(doc, "span", "pt-md-equation-label", `(${label})`));
    return wrap;
  },
};

class PTLatexMathMLParser {
  constructor(doc, source, display) {
    this.doc = doc;
    this.source = String(source || "");
    this.index = 0;
    this.display = display;
  }

  node(tag, text, attrs) {
    const el = this.doc.createElementNS("http://www.w3.org/1998/Math/MathML", tag);
    if (text !== undefined) el.textContent = String(text);
    for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, value);
    return el;
  }

  row(children) {
    const filtered = (children || []).filter(Boolean);
    if (filtered.length === 1) return filtered[0];
    const row = this.node("mrow");
    for (const child of filtered) row.appendChild(child);
    return row;
  }

  parse() {
    const math = this.node("math", undefined, { xmlns: "http://www.w3.org/1998/Math/MathML" });
    math.appendChild(this.parseSequence());
    return math;
  }

  parseSequence(stopChar) {
    const children = [];
    while (this.index < this.source.length) {
      if (stopChar && this.source[this.index] === stopChar) { this.index++; break; }
      if (/\s/.test(this.source[this.index])) {
        while (/\s/.test(this.source[this.index] || "")) this.index++;
        children.push(this.node("mspace", undefined, { width: "0.22em" }));
        continue;
      }
      let atom = this.parseAtom();
      if (!atom) continue;
      while (true) {
        const saved = this.index;
        while (/\s/.test(this.source[this.index] || "")) this.index++;
        if (this.source.startsWith("\\limits", this.index)) {
          this.index += 7;
          continue;
        }
        if (this.source[this.index] !== "^" && this.source[this.index] !== "_") {
          this.index = saved;
          break;
        }
        let sup = null;
        let sub = null;
        while (this.source[this.index] === "^" || this.source[this.index] === "_") {
          const kind = this.source[this.index++];
          const script = this.parseScript();
          if (kind === "^") sup = script; else sub = script;
          while (/\s/.test(this.source[this.index] || "")) this.index++;
        }
        const tag = sub && sup ? "msubsup" : sub ? "msub" : "msup";
        const scripted = this.node(tag);
        scripted.appendChild(atom);
        if (sub) scripted.appendChild(sub);
        if (sup) scripted.appendChild(sup);
        atom = scripted;
      }
      children.push(atom);
    }
    return this.row(children);
  }

  parseScript() {
    while (/\s/.test(this.source[this.index] || "")) this.index++;
    if (this.source[this.index] === "{") { this.index++; return this.parseSequence("}"); }
    return this.parseAtom() || this.node("mrow");
  }

  parseAtom() {
    const char = this.source[this.index];
    if (!char) return null;
    if (char === "{") { this.index++; return this.parseSequence("}"); }
    if (char === "}") { this.index++; return null; }
    if (char === "\\") return this.parseCommand();
    if (/\d/.test(char)) {
      const value = this.take(/^\d+(?:[.,]\d+)?/);
      return this.node("mn", value);
    }
    if (/[A-Za-z]/.test(char)) {
      this.index++;
      return this.node("mi", char);
    }
    const operators = { "-": "−", "*": "∗", "/": "/", "+": "+", "=": "=", "<": "<", ">": ">", "|": "|", "!": "!", ",": ",", ".": ".", ":": ":", ";": ";", "(": "(", ")": ")", "[": "[", "]": "]" };
    this.index++;
    return this.node(operators[char] ? "mo" : "mi", operators[char] || char, /[()[\]|]/.test(char) ? { stretchy: "true" } : undefined);
  }

  parseCommand() {
    this.index++;
    if (this.index >= this.source.length) return this.node("mo", "\\");
    if (!/[A-Za-z]/.test(this.source[this.index])) {
      const symbol = this.source[this.index++];
      const spacing = { ",": "0.17em", ":": "0.22em", ";": "0.28em", "!": "-0.17em", " ": "0.33em" };
      if (spacing[symbol]) return this.node("mspace", undefined, { width: spacing[symbol] });
      return this.node("mo", symbol === "\\" ? "" : symbol);
    }
    const command = this.take(/^[A-Za-z]+/);
    const symbols = PTLatexMathMLParser.SYMBOLS;
    if (symbols[command]) {
      const [tag, value, attrs] = symbols[command];
      return this.node(tag, value, attrs);
    }
    if (command === "frac" || command === "dfrac" || command === "tfrac") {
      const frac = this.node("mfrac");
      frac.appendChild(this.requiredGroup());
      frac.appendChild(this.requiredGroup());
      return frac;
    }
    if (command === "sqrt") {
      this.skipSpace();
      let index = null;
      if (this.source[this.index] === "[") index = this.readBalanced("[", "]");
      const radicand = this.requiredGroup();
      if (!index) { const sqrt = this.node("msqrt"); sqrt.appendChild(radicand); return sqrt; }
      const root = this.node("mroot"); root.appendChild(radicand);
      root.appendChild(new PTLatexMathMLParser(this.doc, index, this.display).parseSequence());
      return root;
    }
    if (["mathrm", "textrm", "text", "operatorname", "mbox"].includes(command)) {
      if (command === "operatorname" && this.source[this.index] === "*") this.index++;
      return this.styledGroup("normal", command === "text" || command === "mbox");
    }
    if (["mathbf", "boldsymbol", "bm"].includes(command)) return this.styledGroup("bold");
    if (["mathit", "textit"].includes(command)) return this.styledGroup("italic");
    if (command === "mathbb") return this.styledGroup("double-struck");
    if (command === "mathcal" || command === "mathscr") return this.styledGroup("script");
    if (command === "mathfrak") return this.styledGroup("fraktur");
    if (["hat", "widehat", "bar", "overline", "vec", "dot", "ddot", "tilde", "widetilde"].includes(command)) {
      const accents = { hat: "^", widehat: "^", bar: "¯", overline: "¯", vec: "→", dot: "˙", ddot: "¨", tilde: "~", widetilde: "~" };
      const over = this.node("mover", undefined, { accent: "true" });
      over.appendChild(this.requiredGroup());
      over.appendChild(this.node("mo", accents[command], { stretchy: command.startsWith("wide") || command === "overline" ? "true" : "false" }));
      return over;
    }
    if (["underline", "underbrace"].includes(command)) {
      const under = this.node("munder", undefined, { accentunder: "true" });
      under.appendChild(this.requiredGroup());
      under.appendChild(this.node("mo", command === "underbrace" ? "⏟" : "_", { stretchy: "true" }));
      return under;
    }
    if (command === "overbrace") {
      const over = this.node("mover"); over.appendChild(this.requiredGroup()); over.appendChild(this.node("mo", "⏞", { stretchy: "true" })); return over;
    }
    if (command === "left" || command === "right" || command === "middle") {
      this.skipSpace();
      let value = this.source[this.index] === "\\" ? this.readDelimiterCommand() : this.source[this.index++];
      value = ({ ".": "", "lbrace": "{", "rbrace": "}", "langle": "⟨", "rangle": "⟩", "vert": "|", "Vert": "‖" })[value] ?? value;
      return this.node("mo", value, { stretchy: "true", fence: command === "middle" ? "false" : "true" });
    }
    if (["big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr"].includes(command)) {
      this.skipSpace();
      const delimiter = this.source[this.index] === "\\" ? this.readDelimiterCommand() : this.source[this.index++];
      const value = ({ lbrace: "{", rbrace: "}", langle: "⟨", rangle: "⟩", vert: "|", Vert: "‖" })[delimiter] ?? delimiter;
      return this.node("mo", value, { stretchy: "true" });
    }
    if (command === "begin") return this.parseEnvironment(this.readRequiredRaw());
    if (command === "end") { this.readRequiredRaw(); return null; }
    if (["quad", "qquad", "enspace", "thinspace"].includes(command)) {
      return this.node("mspace", undefined, { width: command === "qquad" ? "2em" : command === "quad" ? "1em" : command === "enspace" ? "0.5em" : "0.17em" });
    }
    if (["displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "limits", "nolimits"].includes(command)) return this.node("mrow");
    if (command === "color" || command === "class" || command === "label") { this.readRequiredRaw(); return this.requiredGroup(); }
    return this.node("mi", command, { mathvariant: "normal" });
  }

  styledGroup(variant, literalText) {
    const raw = this.readRequiredRaw();
    if (literalText) return this.node("mtext", raw.replace(/\\([{}_%&#$])/g, "$1"), { mathvariant: variant });
    const style = this.node("mstyle", undefined, { mathvariant: variant });
    style.appendChild(new PTLatexMathMLParser(this.doc, raw, this.display).parseSequence());
    return style;
  }

  requiredGroup() {
    this.skipSpace();
    if (this.source[this.index] === "{") { this.index++; return this.parseSequence("}"); }
    return this.parseAtom() || this.node("mrow");
  }

  readRequiredRaw() {
    this.skipSpace();
    return this.source[this.index] === "{" ? this.readBalanced("{", "}") : "";
  }

  readBalanced(open, close) {
    if (this.source[this.index] !== open) return "";
    this.index++;
    const start = this.index;
    let depth = 1;
    while (this.index < this.source.length && depth) {
      const char = this.source[this.index++];
      if (char === "\\") { this.index++; continue; }
      if (char === open) depth++;
      else if (char === close) depth--;
    }
    return this.source.slice(start, depth ? this.index : this.index - 1);
  }

  parseEnvironment(name) {
    const endToken = `\\end{${name}}`;
    const end = this.source.indexOf(endToken, this.index);
    const raw = end >= 0 ? this.source.slice(this.index, end) : this.source.slice(this.index);
    this.index = end >= 0 ? end + endToken.length : this.source.length;
    const rows = this.splitTopLevel(raw, "\\\\");
    const table = this.node("mtable", undefined, { rowspacing: "0.35em", columnspacing: "1em" });
    for (const rowText of rows) {
      if (!rowText.trim()) continue;
      const tr = this.node("mtr");
      for (const cellText of this.splitTopLevel(rowText, "&")) {
        const td = this.node("mtd");
        td.appendChild(new PTLatexMathMLParser(this.doc, cellText.trim(), this.display).parseSequence());
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    const fences = { pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"], cases: ["{", ""] };
    if (!fences[name]) return table;
    return this.row([this.node("mo", fences[name][0], { stretchy: "true" }), table, this.node("mo", fences[name][1], { stretchy: "true" })]);
  }

  splitTopLevel(text, delimiter) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      if (depth === 0 && text.startsWith(delimiter, i)) {
        out.push(text.slice(start, i));
        start = i + delimiter.length;
        i += delimiter.length - 1;
      }
    }
    out.push(text.slice(start));
    return out;
  }

  readDelimiterCommand() {
    this.index++;
    return this.take(/^[A-Za-z]+/) || this.source[this.index++];
  }

  skipSpace() { while (/\s/.test(this.source[this.index] || "")) this.index++; }

  take(regex) {
    const match = this.source.slice(this.index).match(regex);
    if (!match) return "";
    this.index += match[0].length;
    return match[0];
  }
}

PTLatexMathMLParser.SYMBOLS = {
  alpha: ["mi", "α"], beta: ["mi", "β"], gamma: ["mi", "γ"], delta: ["mi", "δ"], epsilon: ["mi", "ϵ"], varepsilon: ["mi", "ε"],
  zeta: ["mi", "ζ"], eta: ["mi", "η"], theta: ["mi", "θ"], vartheta: ["mi", "ϑ"], iota: ["mi", "ι"], kappa: ["mi", "κ"], lambda: ["mi", "λ"],
  mu: ["mi", "μ"], nu: ["mi", "ν"], xi: ["mi", "ξ"], pi: ["mi", "π"], varpi: ["mi", "ϖ"], rho: ["mi", "ρ"], varrho: ["mi", "ϱ"],
  sigma: ["mi", "σ"], varsigma: ["mi", "ς"], tau: ["mi", "τ"], upsilon: ["mi", "υ"], phi: ["mi", "ϕ"], varphi: ["mi", "φ"], chi: ["mi", "χ"], psi: ["mi", "ψ"], omega: ["mi", "ω"],
  Gamma: ["mi", "Γ"], Delta: ["mi", "Δ"], Theta: ["mi", "Θ"], Lambda: ["mi", "Λ"], Xi: ["mi", "Ξ"], Pi: ["mi", "Π"], Sigma: ["mi", "Σ"], Upsilon: ["mi", "Υ"], Phi: ["mi", "Φ"], Psi: ["mi", "Ψ"], Omega: ["mi", "Ω"],
  sum: ["mo", "∑", { largeop: "true", movablelimits: "true" }], prod: ["mo", "∏", { largeop: "true", movablelimits: "true" }], coprod: ["mo", "∐", { largeop: "true" }],
  int: ["mo", "∫", { largeop: "true" }], iint: ["mo", "∬", { largeop: "true" }], iiint: ["mo", "∭", { largeop: "true" }], oint: ["mo", "∮", { largeop: "true" }], lim: ["mo", "lim", { movablelimits: "true" }],
  infty: ["mi", "∞"], partial: ["mi", "∂"], nabla: ["mi", "∇"], ell: ["mi", "ℓ"], hbar: ["mi", "ℏ"], Re: ["mi", "ℜ"], Im: ["mi", "ℑ"],
  times: ["mo", "×"], cdot: ["mo", "·"], div: ["mo", "÷"], pm: ["mo", "±"], mp: ["mo", "∓"], circ: ["mo", "∘"], bullet: ["mo", "•"],
  le: ["mo", "≤"], leq: ["mo", "≤"], ge: ["mo", "≥"], geq: ["mo", "≥"], neq: ["mo", "≠"], ne: ["mo", "≠"], approx: ["mo", "≈"], sim: ["mo", "∼"], simeq: ["mo", "≃"], equiv: ["mo", "≡"], propto: ["mo", "∝"],
  in: ["mo", "∈"], notin: ["mo", "∉"], ni: ["mo", "∋"], subset: ["mo", "⊂"], supset: ["mo", "⊃"], subseteq: ["mo", "⊆"], supseteq: ["mo", "⊇"], cup: ["mo", "∪"], cap: ["mo", "∩"], setminus: ["mo", "∖"], emptyset: ["mi", "∅"],
  to: ["mo", "→"], rightarrow: ["mo", "→"], leftarrow: ["mo", "←"], leftrightarrow: ["mo", "↔"], Rightarrow: ["mo", "⇒"], Leftarrow: ["mo", "⇐"], Leftrightarrow: ["mo", "⇔"], mapsto: ["mo", "↦"],
  forall: ["mo", "∀"], exists: ["mo", "∃"], neg: ["mo", "¬"], land: ["mo", "∧"], lor: ["mo", "∨"], top: ["mi", "⊤"], bot: ["mi", "⊥"],
  ldots: ["mo", "…"], cdots: ["mo", "⋯"], vdots: ["mo", "⋮"], ddots: ["mo", "⋱"], colon: ["mo", ":"], mid: ["mo", "|"], Vert: ["mo", "‖"], vert: ["mo", "|"], lVert: ["mo", "‖"], rVert: ["mo", "‖"], lvert: ["mo", "|"], rvert: ["mo", "|"], langle: ["mo", "⟨", { stretchy: "true" }], rangle: ["mo", "⟩", { stretchy: "true" }],
  sin: ["mi", "sin", { mathvariant: "normal" }], cos: ["mi", "cos", { mathvariant: "normal" }], tan: ["mi", "tan", { mathvariant: "normal" }], log: ["mi", "log", { mathvariant: "normal" }], ln: ["mi", "ln", { mathvariant: "normal" }], exp: ["mi", "exp", { mathvariant: "normal" }], max: ["mi", "max", { mathvariant: "normal" }], min: ["mi", "min", { mathvariant: "normal" }], argmax: ["mi", "arg max", { mathvariant: "normal" }], argmin: ["mi", "arg min", { mathvariant: "normal" }],
};
