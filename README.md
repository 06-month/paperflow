# PaperFlow

PaperFlow is a Zotero plugin MVP for translating PDF papers into Korean, storing a summary note, a translated HTML attachment, metadata JSON, and opening a simple translation/chat panel.

## Repository layout

```text
paperflow/
├─ addon/              # Zotero plugin source. The XPI root is this directory.
├─ scripts/build.sh    # Builds dist/paperflow.xpi from addon/.
├─ dist/paperflow.xpi  # Build artifact.
├─ updates.json        # Zotero update manifest.
├─ AGENTS.md           # Codex/agent development instructions.
└─ README.md
```

## Build

```bash
./scripts/build.sh
```

The output is:

```text
dist/paperflow.xpi
```

## Install locally

1. Zotero → Tools → Plugins.
2. Gear icon → Install Plugin From File.
3. Select `dist/paperflow.xpi`.
4. Restart Zotero.

## Test workflow

1. Preferences → Paper Translator / PaperFlow.
2. Save Gemini API key and run connection test.
3. Select a Zotero item with a PDF attachment.
4. Tools → Translate Paper.
5. Confirm generated child items:
   - `[PaperTranslator] ...` note
   - `translated.ko.html`
   - `pt-meta.json`
6. Select the same item.
7. Tools → Open Paper Translator Panel.
8. Check translation, chat, and metadata tabs.

## Release update URL

The current manifest uses a placeholder update URL. For real distribution, set `addon/manifest.json`:

```json
"update_url": "https://raw.githubusercontent.com/06-month/paperflow/main/updates.json"
```

Then ensure `updates.json` points to the release asset:

```text
https://github.com/06-month/paperflow/releases/download/v0.2.2/paperflow.xpi
```

If your GitHub owner is not `06-month`, replace it in both files.
