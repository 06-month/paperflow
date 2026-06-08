# PaperFlow
<p align="center">
  <strong>AI-assisted paper reading inside Zotero Reader.</strong>
</p>
<p align="center">
  Summarize, translate, inspect metadata, and ask paper-specific questions without leaving Zotero.
</p>
<p align="center">
  <img alt="Status" src="https://img.shields.io/badge/status-experimental-orange">
  <img alt="Zotero" src="https://img.shields.io/badge/Zotero-Reader%20Plugin-blue">
  <img alt="AI" src="https://img.shields.io/badge/AI-Gemini-7c3aed">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
</p>
---

## Overview

**PaperFlow** is an AI-assisted Zotero Reader sidebar for paper summarization, translation, metadata inspection, and paper-context-aware chat.
It brings an AI reading layer directly into Zotero Reader, allowing researchers to review generated summaries, inspect translations, check processing metadata, and ask paper-specific questions without switching between PDF viewers, translators, LLM chat windows, note-taking apps, or external web tools.
PaperFlow is not designed as a generic translator. It is an experimental, work-in-progress attempt to build a **Zotero-native research assistant** for academic reading workflows.

```text
Read → Summarize → Translate → Inspect → Ask

⸻

Preview

<p align="center">
  <img src="docs/assets/paperflow-reader-sidebar.png" alt="PaperFlow Zotero Reader Sidebar" width="960">
</p>

If the preview image is not available in your local clone, it can be added later under docs/assets/paperflow-reader-sidebar.png.

⸻

Why PaperFlow?

Research reading is rarely a single-window task. A typical workflow often involves:

* reading the PDF in Zotero,
* copying passages into a translator,
* asking questions in an LLM chat,
* saving notes somewhere else,
* returning to Zotero,
* and repeating the same process for the next paper.

PaperFlow reduces this friction by keeping the paper and its AI-assisted reading context inside the same Zotero Reader environment.

Read	Translate	Inspect	Ask
Stay inside Zotero Reader	View generated translations	Check chunk status and artifacts	Ask questions using paper context

Core Design Goals

* Zotero-native interaction
    Keep the PDF, generated artifacts, and AI assistant close to the Reader UI.
* Artifact reuse
    Load existing summaries, translations, and metadata instead of reprocessing the same paper.
* Chunk-level processing
    Make long-document processing more trackable, inspectable, and debuggable.
* Paper-specific context
    Ask questions against the current paper’s generated context rather than an isolated chat prompt.
* Annotation-aware future direction
    Build toward translation, explanation, and highlighting workflows that remain connected to the original PDF.

⸻

Current Features

PaperFlow is experimental, but the current implementation already supports a Zotero-native reading workflow.

Feature	Description	Status
Zotero Reader sidebar	Sidebar integration inside Zotero Reader / item pane	Implemented
Summary view	Displays generated paper summaries	Implemented
Translation view	Displays generated translation artifacts	Implemented
Meta view	Shows chunk progress, artifact IDs, and completion state	Implemented
Chunk-based processing	Processes long papers in smaller chunks	Implemented
Artifact reuse	Reloads generated notes, translations, and metadata	Implemented
Gemini chat	Embedded paper-context-aware chat panel	Experimental
Source-aligned translation	Map translations back to original PDF spans	Planned
Zotero highlight integration	Create highlights from translated passages	Planned
Attachment-aware chat	Attach supplementary materials to paper context	Planned

⸻

Zotero Reader Sidebar Integration

PaperFlow adds a dedicated sidebar section inside the Zotero Reader / item pane.

The sidebar is designed to keep the following in one place:

* the current paper,
* generated summary,
* generated translation,
* processing metadata,
* and paper-context-aware chat.

This reduces context switching while reading papers.

⸻

Paper-Specific Views

PaperFlow organizes generated results into three views.

View	Purpose
Summary	Displays the generated paper summary
Translation	Displays the generated translation artifact
Meta	Shows processing metadata, chunk status, attachment IDs, and completion state

This separation keeps the UI focused: quick understanding, full translation, and debugging/inspection are not mixed into one long page.

⸻

Chunk-Based Processing

Long papers are processed in chunks.

This makes the pipeline easier to:

* track,
* resume,
* inspect,
* debug,
* and reason about when model/API limits are involved.

The sidebar can show progress such as:

14 / 14 chunks
completed

Generated metadata is stored so that processing state can be inspected later.

⸻

Artifact Reuse

PaperFlow is designed to reuse previously generated outputs.

Instead of retranslating a paper every time it is opened, PaperFlow can load existing generated artifacts associated with the Zotero item.

Current generated artifacts include:

[PaperFlow] note
translated.ko.html
pt-meta.json

This makes PaperFlow closer to a persistent research workflow tool rather than a one-off prompt wrapper.

⸻

Gemini-Based Translation and Chat

PaperFlow uses Gemini for translation and paper-context-aware chat.

The embedded chat panel is intended to answer questions grounded in the current paper’s generated context.

Example questions:

What is the main contribution of this paper?
How is this method different from prior work?
What does the ablation study prove?
What are the limitations?
Explain this method section more simply.

The goal is not to replace reading, but to make difficult papers easier to inspect, question, and revisit.

At the time of writing, the Gemini API provides a free tier with daily usage limits, making it possible to test PaperFlow without setting up paid billing immediately.

⸻

How It Works

At a high level, PaperFlow follows this pipeline:

flowchart LR
    A[Zotero Item / PDF] --> B[Text Extraction]
    B --> C[Text Cleaning]
    C --> D[Section Splitting]
    D --> E[Chunking]
    E --> F[Gemini Translation]
    F --> G[Zotero Artifacts]
    G --> H[Reader Sidebar]
    H --> I[Summary / Translation / Meta / Chat]

Plain text version:

Zotero item / PDF
        ↓
PDF text extraction
        ↓
Text cleaning
        ↓
Section splitting
        ↓
Chunking
        ↓
Gemini translation
        ↓
Generated artifacts
        ↓
Zotero-linked storage
        ↓
Reader sidebar display
        ↓
Paper-context-aware chat

More concretely:

1. Resolve the selected Zotero parent item or PDF attachment.
2. Extract text from the PDF.
3. Clean and normalize the extracted text.
4. Split the paper into sections.
5. Split long sections into chunks.
6. Translate chunks with Gemini.
7. Save generated outputs as Zotero-linked artifacts.
8. Load summary, translation, and metadata into the Reader sidebar.
9. Use generated paper context for sidebar chat.

⸻

Current Status

PaperFlow is currently a work-in-progress Zotero plugin.

It is suitable for development, testing, and iterative research-tooling experiments, but it should not yet be considered production-stable.

Current status:

* Installable Zotero plugin package
* Manual translation trigger through Zotero’s Tools menu
* Zotero Reader / item-pane sidebar integration
* Summary / Translation / Meta views
* Gemini API key preference UI
* Gemini connection test
* Gemini-based translation
* Paper-context-aware chat panel
* Zotero-linked generated notes and attachments
* Chunk metadata and completion tracking
* Experimental sidebar layout and runtime behavior

Tested primarily with local Zotero 9.x development environments.

⸻

Installation

The easiest way to install PaperFlow is to download the prebuilt XPI from the GitHub Releases page.

Download

Download the latest release from:

https://github.com/06-month/paperflow/releases/tag/v0.3.0

Download the .xpi file attached to the release.

Install in Zotero

1. Open Zotero.
2. Go to Tools → Plugins.
3. Click the gear icon or menu button.
4. Choose Install Plugin From File.
5. Select the downloaded .xpi file.
6. Restart Zotero.
7. Open Zotero Preferences and confirm that the PaperFlow settings pane is available.
8. Save a Gemini API key and run the connection test.

⸻

Basic Usage

1. Select a Zotero item with a PDF attachment, or select the PDF attachment directly.
2. Run:

Tools → Translate Paper

3. Open the paper in Zotero Reader.
4. Open the PaperFlow sidebar section.
5. Use the available views:

Summary | Translation | Meta

6. Ask paper-specific questions in the Gemini chat panel.

⸻

Development Build

For development, PaperFlow can be built locally from source.

Recommended development loop:

1. Edit source files under addon/.
2. Run static checks where possible:

find addon -name '*.js' -exec node --check {} \;

3. Build the XPI:

bash scripts/build.sh

or:

chmod +x scripts/build.sh
./scripts/build.sh

4. Install the generated XPI in Zotero:

dist/paperflow.xpi

5. Restart Zotero.
6. Test translation, artifact generation, Reader sidebar loading, metadata loading, and chat behavior.
7. Check Zotero’s Error Console for runtime errors.

The build script zips the contents of addon/, not the addon/ directory itself.
The resulting XPI should contain manifest.json at the archive root.

⸻

Roadmap: Toward a Zotero-Native Research Assistant

The following items are planned or long-term directions. They are not all implemented today.

Source-Aligned Translation

PaperFlow’s long-term translation goal is not only to produce translated text, but to keep that translation connected to the original paper.

Planned directions:

* Align translated passages with corresponding original source text.
* Preserve paragraph-level and section-level mappings.
* Allow navigation from a translated passage back to the original PDF context.
* Support source-grounded explanations and verification.

⸻

Zotero Annotation / Highlight Integration

A major future direction is connecting AI-generated reading artifacts with Zotero’s annotation system.

Planned directions:

* Select or drag translated text and map it back to the original PDF span.
* Create Zotero highlights on the original PDF from translated passages.
* Link summaries, explanations, and translations to Zotero annotations.
* Support annotation-aware follow-up questions.

Example intended workflow:

Read translation
    ↓
Select translated passage
    ↓
Map to original PDF span
    ↓
Create Zotero highlight
    ↓
Ask follow-up questions about that annotation

⸻

Attachment-Aware Chat

Paper reading often involves more than the main PDF.

Future directions:

* Attach supplementary materials, notes, or related files to the paper-level chat context.
* Ask questions over paper-specific artifacts beyond the main PDF.
* Reuse Zotero-linked generated artifacts as persistent context.
* Support richer paper-level memory across reading sessions.

⸻

Selection-Based Assistance

Planned capabilities:

* Explain selected passages from the paper or translation view.
* Ground answers in the selected text span.
* Provide section-aware explanations for methods, equations, experiments, and limitations.
* Support follow-up questions based on the current selection.

⸻

Multimodal Paper Understanding

Long-term research directions:

* Explain figures, tables, equations, and captions.
* Connect visual elements with surrounding text and experimental claims.
* Support figure-grounded question answering.
* Help users interpret experimental results and ablation tables.

⸻

Literature Review Workflow

PaperFlow is intended to grow beyond single-paper reading.

Future workflow extensions:

* Export structured reading notes to Zotero Notes, Markdown, Obsidian, or Notion.
* Compare multiple papers by contribution, method, dataset, and limitation.
* Generate related-work tables from selected papers.
* Support paper triage for literature review.

⸻

What PaperFlow Is Not

PaperFlow is a research reading assistant, not a replacement for careful reading or verification.

It is not:

* a production-stable Zotero extension yet,
* a replacement for reading the original paper,
* a guarantee of translation or summary correctness,
* a verified source-aligned annotation system yet,
* or a fully automated literature review system.

AI-generated outputs should be reviewed critically.

⸻

Project Structure

paperflow/
├─ addon/
│  ├─ manifest.json
│  ├─ bootstrap.js
│  ├─ prefs.js
│  ├─ content/
│  │  ├─ preferences.xhtml
│  │  ├─ preferences.js
│  │  ├─ panel.xhtml
│  │  ├─ panel.js
│  │  ├─ panel.css
│  │  ├─ readerSidebar.css
│  │  └─ icons/
│  ├─ locale/
│  │  └─ en-US/
│  │     └─ paperflow.ftl
│  └─ src/
│     ├─ addon.js
│     ├─ modules/
│     │  ├─ readerSidebar.js
│     │  ├─ itemResolver.js
│     │  ├─ extractor.js
│     │  ├─ cleaner.js
│     │  ├─ sectionizer.js
│     │  ├─ chunker.js
│     │  ├─ translator.js
│     │  ├─ jobQueue.js
│     │  ├─ rateLimiter.js
│     │  ├─ storage.js
│     │  └─ chat.js
│     └─ utils/
│        ├─ prefs.js
│        ├─ logger.js
│        ├─ errors.js
│        └─ tokenEstimate.js
├─ scripts/
│  └─ build.sh
├─ dist/
│  └─ paperflow.xpi
├─ updates.json
├─ CHANGELOG.md
├─ AGENTS.md
└─ README.md

⸻

Notes and Limitations

* PaperFlow is experimental.
* Zotero internal APIs may change.
* Reader/sidebar behavior may require version-specific adjustments.
* Gemini API access is required for translation and chat.
* AI output should be reviewed critically.
* Very long papers may be affected by model limits, rate limits, or API errors.
* Current translation artifacts are generated as translated.ko.html.
* Processing metadata is stored as pt-meta.json.
* Source-aligned translation, Zotero annotation mapping, attachment-aware chat, and multimodal understanding are roadmap directions, not fully implemented features.

⸻

Contributing

PaperFlow started as a personal research productivity project, but collaboration is welcome.

Areas of interest include:

* Zotero-native research workflows
* AI-assisted paper reading
* Source-aligned translation
* Annotation-aware reading systems
* Scholarly knowledge tools
* Literature review automation

For discussion or collaboration:

junjeon@edu.hanbat.ac.kr

⸻

License

PaperFlow is open-source software released under the MIT License.

You are free to use, modify, and distribute this project under the terms of the license. See LICENSE￼ for details.
