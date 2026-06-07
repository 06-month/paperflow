# PaperFlow

PaperFlow is a Zotero plugin for translating academic papers and reading the translated result inside Zotero. The current target is an installable and testable MVP for Zotero 9.0.3.

## Features

1. Select a Zotero item or PDF attachment.
2. Run Tools -> Translate Paper.
3. Extract text from the selected PDF.
4. Split extracted text into sections and translation chunks.
5. Translate chunks into Korean with Gemini.
6. Create a Zotero Note summary.
7. Create a `translated.ko.html` attachment with the full Korean translation.
8. Create a `pt-meta.json` attachment with job, chunk, hash, timestamp, and attachment metadata.
9. Run Tools -> Open PaperFlow Panel to view translation, chat, and metadata tabs.

## Repository Layout

```text
paperflow/
├─ addon/              # Zotero plugin source. The XPI root is this directory.
│  ├─ manifest.json
│  ├─ bootstrap.js
│  ├─ content/
│  └─ src/
├─ scripts/
│  └─ build.sh
├─ dist/
│  └─ paperflow.xpi
├─ updates.json
├─ README.md
├─ CHANGELOG.md
└─ AGENTS.md
```

## Install

1. Open Zotero 9.0.3.
2. Go to Tools -> Plugins.
3. Choose Install Plugin From File.
4. Select `dist/paperflow.xpi`.
5. Restart Zotero.

## Build

```bash
chmod +x scripts/build.sh
./scripts/build.sh
```

The build script zips the contents of `addon/` into `dist/paperflow.xpi`, so `manifest.json` is at the archive root.

## Test Workflow

1. Start Zotero 9.0.3.
2. Install `dist/paperflow.xpi`.
3. Restart Zotero.
4. Confirm Preferences -> PaperFlow appears.
5. Save a Gemini API key and run the connection test.
6. Select a paper with a PDF attachment.
7. Run Tools -> Translate Paper.
8. Confirm `[PaperFlow]` note, `translated.ko.html`, and `pt-meta.json` are created.
9. Run Tools -> Open PaperFlow Panel.
10. Confirm the translation, chat, and metadata tabs load.
11. Ask a paper-specific question in the chat tab.
12. Check Tools -> Developer -> Error Console for errors.

## Known Limits

- PaperFlow may use a separate panel window instead of a native Zotero PDF Reader sidebar.
- Zotero 9 runtime APIs still need manual validation in the local Zotero app.
- A Gemini API key is required for translation and chat.

## Release Update URL

`addon/manifest.json` uses:

```json
"update_url": "https://raw.githubusercontent.com/06-month/paperflow/main/updates.json"
```

`updates.json` points to the GitHub release asset:

```text
https://github.com/06-month/paperflow/releases/download/v0.2.2/paperflow.xpi
```
