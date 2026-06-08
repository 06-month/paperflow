# PaperFlow

**AI-assisted paper reading inside Zotero Reader.**

**PaperFlow is an AI-assisted Zotero Reader sidebar for paper summarization, translation, metadata inspection, and paper-context-aware chat.**

PaperFlow brings an AI reading layer directly into Zotero Reader. It allows researchers to inspect summaries, translations, processing metadata, and ask paper-specific questions without leaving their literature management environment.

PaperFlow is not intended to be just a simple translator. It is an experimental, work-in-progress Zotero-native research reading assistant for reading, understanding, translating, inspecting, and asking questions about papers inside the Zotero workflow.

## Overview

Research reading often involves too much context switching: PDF viewers, translation tools, LLM chats, note-taking apps, Notion, external web apps, and Zotero itself. PaperFlow is designed to reduce that friction by keeping the paper and its AI-assisted reading layer in the same place.

Instead of copying passages out of Zotero into external tools, a researcher can open a paper in Zotero Reader and use the PaperFlow sidebar to review generated summaries, inspect translations, check processing metadata, and ask questions about the current paper.

The intended workflow is:

```text
Read -> summarize -> translate -> inspect metadata -> ask follow-up questions
```

## Why PaperFlow?

PaperFlow is built around research workflow integration rather than generic web translation.

- **Zotero-native interaction**: keep the paper, generated artifacts, and AI assistant close to the Reader UI.
- **Artifact reuse**: load previously generated summaries, translations, and metadata instead of reprocessing the same paper.
- **Chunk-level processing**: make long-document processing more trackable, inspectable, and debuggable.
- **Paper-specific context**: ask questions against the current paper's generated context rather than an isolated chat prompt.
- **Research-oriented reading**: support literature review, paper triage, and deep reading workflows.
- **Long-term source alignment**: evolve toward translation and explanation workflows that remain connected to the original PDF context.

## Current Features

PaperFlow is experimental, but the current implementation includes the following core capabilities.

### Native Zotero Reader Sidebar Integration

- Works inside the Zotero Reader / item pane.
- Keeps the paper, summary, translation, metadata, and AI assistant in one place.
- Reduces context switching during paper reading.

### Paper-Specific Views

- **Summary tab**: displays the generated paper summary.
- **Translation tab**: displays the generated translation result.
- **Meta tab**: displays processing metadata, chunk status, attachment IDs, and completion status.

### Chunk-Based Processing

- Long papers are processed in chunks.
- The UI can show progress such as completed chunks / total chunks.
- Chunk metadata makes long-document processing more trackable and debuggable.

### Reuse of Generated Artifacts

- Previously generated summary, translation, and metadata can be loaded again.
- Completed results can be detected to avoid unnecessary reprocessing.
- Outputs are associated with the Zotero item / attachment workflow.

Current generated artifacts include:

- `[PaperFlow]` note
- `translated.ko.html`
- `pt-meta.json`

### Context-Aware Gemini Chat

- A Gemini chat panel is embedded in the PaperFlow sidebar.
- The chat is intended to answer questions based on the current paper's generated summary and translation context.
- Useful for asking about contributions, method details, experiments, limitations, related work, and confusing passages.

### Researcher-Oriented Workflow

- Designed for academic reading rather than generic web translation.
- Suitable for literature review, paper triage, and deep reading.
- Keeps generated reading artifacts inside the Zotero item context.

## How It Works

At a high level, PaperFlow processes a selected Zotero paper as follows:

1. Resolve the selected Zotero parent item or PDF attachment.
2. Extract text from the selected PDF.
3. Clean the extracted text.
4. Split the paper into sections.
5. Split long sections into chunks.
6. Translate chunks with Gemini.
7. Save generated outputs as Zotero-linked artifacts.
8. Load the summary, translation, and metadata into the PaperFlow sidebar.
9. Use generated paper context for sidebar chat.

The chunk-based architecture is designed to make long papers easier to process, resume, inspect, and debug.

## Current Status

PaperFlow is a work-in-progress Zotero plugin targeting Zotero 9.x, with local testing focused on Zotero 9.0.3.

Current status:

- Installable Zotero plugin package.
- Manual translation trigger through Zotero's Tools menu.
- Native Reader / item-pane sidebar integration.
- Summary, Translation, and Meta views.
- Gemini API key preference UI and connection test.
- Gemini-based translation and paper-context chat.
- Zotero artifact reuse through generated notes and attachments.
- Experimental UI and runtime behavior that still requires manual validation in Zotero.

** PaperFlow can be tested with the Gemini API free tier, which is currently available with daily usage limits. **
PaperFlow should not yet be considered production-stable. It is suitable for development, testing, and iterative research-tooling experiments.

## Installation / Build

PaperFlow currently uses a simple shell build script. No bundler is required.

Build the XPI:

```bash
bash scripts/build.sh
```

or:

```bash
chmod +x scripts/build.sh
./scripts/build.sh
```

The built XPI is generated under:

```text
dist/paperflow.xpi
```

Install the XPI in Zotero:

1. Open Zotero.
2. Go to `Tools -> Plugins`.
3. Choose `Install Plugin From File`.
4. Select `dist/paperflow.xpi`.
5. Restart Zotero.
6. Open Zotero Preferences and confirm that the PaperFlow settings pane is available.
7. Save a Gemini API key and run the connection test.

Basic usage:

1. Select a Zotero item with a PDF attachment, or select the PDF attachment directly.
2. Run `Tools -> Translate Paper`.
3. Open the paper in Zotero Reader.
4. Open the PaperFlow sidebar section.
5. Use `Summary`, `Translation`, and `Meta` views.
6. Ask paper-specific questions in the Gemini chat panel.

## Development

Recommended development loop:

1. Edit source files under `addon/`.
2. Run static checks where possible:

```bash
find addon -name '*.js' -exec node --check {} \;
```

3. Build the XPI:

```bash
./scripts/build.sh
```

4. Install `dist/paperflow.xpi` in Zotero.
5. Restart Zotero.
6. Test translation, artifact generation, Reader sidebar loading, metadata loading, and chat behavior.
7. Check Zotero's Error Console for runtime errors.

The build script zips the contents of `addon/`, not the `addon/` directory itself. The resulting XPI should contain `manifest.json` at the archive root.

## Roadmap: Toward a Zotero-Native Research Assistant

The following items are planned or future directions. They are not all implemented today.

### Source-Aligned Translation

Long-term goals:

- Align translated passages with their corresponding original source text.
- Preserve paragraph-level and section-level mappings between the original paper and the translated view.
- Allow users to navigate from a translated passage back to the original PDF context.

### Zotero Annotation / Highlight Integration

Planned directions:

- Allow users to select or drag translated text and map it back to the original PDF span.
- Create Zotero highlights on the original PDF from translated passages.
- Link AI-generated summaries, explanations, and translations to Zotero annotations.
- Support annotation-aware follow-up questions.

### Attachment-Aware Chat

Future directions:

- Support attaching supplementary files, notes, or additional paper-related materials to the paper-level chat context.
- Allow questions over paper-specific artifacts beyond the main PDF.
- Reuse Zotero-linked generated artifacts as persistent context.

### Selection-Based Assistance

Planned capabilities:

- Explain selected passages from the paper or translation view.
- Ground follow-up answers in the selected text span.
- Provide section-aware explanations for methods, equations, experiments, and limitations.

### Multimodal Paper Understanding

Long-term research directions:

- Future support for figures, tables, equations, and captions.
- Connect visual elements with surrounding text and experimental claims.
- Support figure-grounded question answering.

### Literature Review Workflow

Planned workflow extensions:

- Export structured reading notes to Zotero Notes, Markdown, Obsidian, or Notion.
- Compare multiple papers by contribution, method, dataset, and limitations.
- Generate related-work tables from selected papers.

## Project Structure

```text
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
```

## Notes / Limitations

- PaperFlow is experimental and should be tested carefully with your Zotero setup.
- Zotero internal APIs can change, and Reader/sidebar behavior may require version-specific adjustments.
- Gemini API access is required for translation and chat.
- AI output should be reviewed critically. PaperFlow is a reading assistant, not a substitute for reading or verification.
- Very long papers may require chunked processing and may be affected by model limits, rate limits, or API errors.
- The current generated translation artifact is stored as `translated.ko.html`.
- Processing metadata is stored as `pt-meta.json`.
- Source-aligned translation, Zotero annotation mapping, attachment-aware chat, and multimodal paper understanding are roadmap directions.

## Contributing and Contact

PaperFlow is being developed as an open-source research productivity project.

The project started as a personal project, but collaboration is welcome, especially from people interested in Zotero-native research workflows, AI-assisted paper reading, source-aligned translation, annotation-aware reading systems, and scholarly knowledge tools.

If you would like to help improve PaperFlow or discuss collaboration, please contact:

```text
junjeon@edu.hanbat.ac.kr
```

## License

PaperFlow is open-source software released under the MIT License.

You are free to use, modify, and distribute this project under the terms of the license. See [LICENSE](LICENSE) for details.
