"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

class FakeNode {
  constructor(doc, tag = "#text", namespace = "", text = "") {
    this.ownerDocument = doc;
    this.tag = tag;
    this.namespaceURI = namespace;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.className = "";
    this.value = text;
    this.classList = {
      add: (...names) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach(name => classes.add(name));
        this.className = Array.from(classes).join(" ");
      },
    };
  }

  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  get textContent() { return this.tag === "#text" ? this.value : this.children.map(child => child.textContent).join(""); }
  set textContent(value) {
    this.children = [];
    if (value !== "") this.children.push(this.ownerDocument.createTextNode(String(value)));
  }
}

class FakeDocument {
  createElementNS(namespace, tag) { return new FakeNode(this, tag, namespace); }
  createTextNode(text) { return new FakeNode(this, "#text", "", String(text)); }
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

const sourcePath = require("path").join(__dirname, "../addon/src/modules/responseRenderer.js");
vm.runInThisContext(fs.readFileSync(sourcePath, "utf8"), { filename: sourcePath });

const doc = new FakeDocument();
const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
const markdown = [
  "## 핵심 **결과**",
  "",
  "본문의 인라인 수식은 $x_i^2 + y^2 + \\alpha$ 입니다.",
  "",
  "| 항목 | 값 |",
  "|:---|---:|",
  "| 정확도 | **98%** |",
  "",
  "$$",
  "\\frac{1}{N} \\sum_{i=1}^{N} x_i \\tag{1}",
  "$$",
  "",
  "- 첫 항목",
  "- `코드`와 ~~취소선~~",
  "",
  "<script>alert('unsafe')</script>",
].join("\n");

PTResponseRenderer.render(root, markdown);
const nodes = descendants(root);
const tags = nodes.map(node => node.tag);
assert(tags.includes("h2"), "heading should render");
assert(tags.includes("strong"), "bold should render");
assert(tags.includes("table"), "table should render");
assert(tags.includes("mfrac"), "LaTeX fraction should become MathML");
assert(tags.includes("msubsup") || tags.includes("msub"), "LaTeX scripts should become MathML");
assert(tags.includes("msup"), "inline exponent should become MathML");
assert(!tags.includes("script"), "model HTML must never become executable DOM");
assert(root.textContent.includes("alert('unsafe')"), "unsafe HTML should remain visible text");
assert(nodes.some(node => node.className.includes("pt-md-equation-label") && node.textContent === "(1)"), "equation tag should render separately");

const texRoot = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
PTResponseRenderer.render(texRoot, "\\[E = mc^2\\]\n인라인 \\(a+b\\) 확인");
const texNodes = descendants(texRoot);
assert(texNodes.some(node => node.className.includes("pt-md-math-block")), "\\[...\\] should normalize to display math");
assert(texNodes.some(node => node.className.includes("pt-md-math-inline")), "\\(...\\) should normalize to inline math");

console.log("response renderer tests passed");
