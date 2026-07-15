"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class FakeNode {
  constructor(tagName, ownerDocument, text) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = {};
    this.className = "";
    this._text = text === undefined ? null : String(text);
    this.classList = {
      add: name => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        names.add(name);
        this.className = Array.from(names).join(" ");
      },
    };
  }

  appendChild(child) {
    this._text = null;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  get textContent() {
    if (this.tagName === "#text") return this._text || "";
    if (this._text !== null) return this._text;
    return this.children.map(child => child.textContent).join("");
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
}

class FakeDocument {
  createElementNS(_namespace, tag) {
    return new FakeNode(tag, this);
  }

  createElement(tag) {
    return new FakeNode(tag, this);
  }

  createTextNode(text) {
    return new FakeNode("#text", this, text);
  }
}

function loadRenderer() {
  const source = fs.readFileSync("addon/src/utils/markdown.js", "utf8");
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.PTMarkdown;
}

function findAll(node, tagName, results = []) {
  if (node.tagName === tagName) results.push(node);
  for (const child of node.children || []) findAll(child, tagName, results);
  return results;
}

const renderer = loadRenderer();
const doc = new FakeDocument();
const root = new FakeNode("div", doc);
const tick = String.fromCharCode(96);
const markdown = [
  "## 요약",
  "",
  "**핵심**과 *기울임*, ~~삭제~~, " + tick + "inline" + tick,
  "",
  "- 첫 번째",
  "- 두 번째",
  "",
  "> 중요한 인용",
  "",
  "| 항목 | 값 |",
  "| :--- | ---: |",
  "| 정확도 | **95%** |",
  "",
  tick.repeat(3) + "js",
  "const value = \"<unsafe>\";",
  tick.repeat(3),
  "",
  "[안전 링크](https://example.com) [위험 링크](javascript:alert(1))",
  "<script>alert('xss')</script>",
].join("\n");

renderer.renderInto(root, markdown);

assert.match(root.className, /\bpt-msg-markdown\b/);
assert.equal(findAll(root, "h2")[0].textContent, "요약");
assert.equal(findAll(root, "strong")[0].textContent, "핵심");
assert.equal(findAll(root, "em")[0].textContent, "기울임");
assert.equal(findAll(root, "del")[0].textContent, "삭제");
assert.equal(findAll(root, "ul")[0].children.length, 2);
assert.equal(findAll(root, "blockquote")[0].textContent, "중요한 인용");
assert.equal(findAll(root, "table")[0].children.length, 2);
assert.match(findAll(root, "pre")[0].textContent, /<unsafe>/);

const links = findAll(root, "a");
assert.equal(links.length, 1);
assert.equal(links[0].attributes.href, "https://example.com");
assert.equal(findAll(root, "script").length, 0);
assert.match(root.textContent, /<script>alert\('xss'\)<\/script>/);

console.log("Markdown renderer tests passed");
