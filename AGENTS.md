# AGENTS.md

## Project

PaperFlow is a Zotero 9 plugin for translating academic papers and reading them inside Zotero.

The current priority is to make the plugin installable and testable on Zotero 9.0.3, then stabilize the Phase 1–11 MVP.

## Current MVP Scope

Implement and maintain the following features:

- Load as a Zotero plugin on Zotero 9.0.3.
- Add a Tools menu entry for manual paper translation.
- Resolve the selected Zotero parent item or PDF attachment.
- Extract full text from the selected PDF attachment.
- Clean extracted PDF text.
- Split text into sections.
- Split long sections into translation chunks.
- Translate chunks with Gemini.
- Use a job queue, rate limiter, retry, and exponential backoff.
- Save output as:
  - Zotero Note: short summary and section-level quick view.
  - `translated.ko.html`: full Korean translation attachment.
  - `pt-meta.json`: metadata attachment containing job state, chunk state, hashes, timestamps, and attachment IDs.
- Provide a PaperFlow panel window with:
  - Translation tab.
  - Chat tab.
  - Metadata tab.
- Chat should answer using the translated paper context and avoid unsupported claims.

PDF Reader native sidebar integration is not required for the current MVP. A separate panel window is acceptable for now.

## Repository Structure

Use this structure unless there is a strong reason to change it:

```text
paperflow/
├─ addon/
│  ├─ manifest.json
│  ├─ bootstrap.js
│  ├─ content/
│  │  ├─ icons/
│  │  │  ├─ icon.png
│  │  │  └─ icon@2x.png
│  │  ├─ modules/
│  │  ├─ preferences/
│  │  └─ panel/
│  └─ locale/
├─ scripts/
│  └─ build.sh
├─ dist/
│  └─ paperflow.xpi
├─ updates.json
├─ README.md
├─ CHANGELOG.md
└─ AGENTS.md
```

If the uploaded XPI contains a different but valid Zotero plugin structure, preserve behavior first and normalize structure incrementally.

## Naming

Use the public product name:

```text
PaperFlow
```

Use this plugin ID unless explicitly changed:

```text
paperflow@06-month
```

Use this XPI filename:

```text
paperflow.xpi
```

Avoid reverting to older names such as `paper-translator` unless required for migration compatibility.

## Zotero Compatibility

The target local test version is:

```text
Zotero 9.0.3
```

The manifest should include Zotero compatibility metadata similar to:

```json
"applications": {
  "zotero": {
    "id": "paperflow@06-month",
    "strict_min_version": "7.0",
    "strict_max_version": "9.99.99",
    "update_url": "https://raw.githubusercontent.com/06-month/paperflow/main/updates.json"
  }
}
```

If the GitHub account or repository name is different, update `update_url` accordingly.

Do not leave `update_url` as `https://example.com/...` in committed code.

## GitHub Release Update File

Maintain `updates.json` at the repository root.

Example:

```json
{
  "addons": {
    "paperflow@06-month": {
      "updates": [
        {
          "version": "0.2.0",
          "update_link": "https://github.com/06-month/paperflow/releases/download/v0.2.0/paperflow.xpi",
          "applications": {
            "zotero": {
              "strict_min_version": "7.0",
              "strict_max_version": "9.99.99"
            }
          }
        }
      ]
    }
  }
}
```

If the GitHub account or repository name differs, update the URL.

## Build

Add and maintain a build script:

```bash
scripts/build.sh
```

Expected behavior:

- Remove stale `dist/paperflow.xpi`.
- Zip the contents of `addon/`, not the `addon/` folder itself.
- Place output at `dist/paperflow.xpi`.
- Exclude macOS metadata and temporary files.

Expected command:

```bash
bash scripts/build.sh
```

The produced XPI should contain `manifest.json` at the archive root.

## Development Rules

- Preserve Zotero 9 compatibility first.
- Prefer small, testable patches over large rewrites.
- Do not remove working functionality while fixing packaging issues.
- Keep the plugin manually triggered. Do not add automatic translation triggers yet.
- Do not implement PDF Reader native sidebar integration until the MVP installs and runs reliably.
- Keep Gemini API keys in Zotero preferences or Zotero preference storage. Do not hard-code API keys.
- Do not commit secrets, tokens, private papers, or local Zotero profile data.
- Do not commit generated logs unless they are anonymized and intentionally added for debugging.

## Coding Style

- Use plain JavaScript compatible with Zotero’s runtime.
- Avoid introducing bundlers unless necessary.
- Keep modules focused:
  - `extractor`: PDF/full-text retrieval.
  - `cleaner`: text cleanup.
  - `sectionizer`: section tree creation.
  - `chunker`: chunk splitting.
  - `translator`: Gemini API calls.
  - `rateLimiter`: request pacing.
  - `jobQueue`: chunk execution orchestration.
  - `storage`: Zotero Note and attachment persistence.
  - `panel`: translation/chat/metadata UI.
- Handle failures explicitly and show useful user-facing errors.
- Use defensive checks around Zotero APIs because runtime differences between Zotero versions can break plugins.

## Testing Checklist

After every packaging or runtime change, test manually on Zotero 9.0.3:

```text
1. Install XPI from file.
2. Restart Zotero.
3. Confirm plugin appears in Plugins/Add-ons manager.
4. Confirm PaperFlow preferences pane appears.
5. Save Gemini API key.
6. Run connection test.
7. Select a Zotero item with a PDF attachment.
8. Run Tools → Translate Paper.
9. Confirm output attachments are created:
   - [PaperFlow] Note
   - translated.ko.html
   - pt-meta.json
10. Run Tools → Open PaperFlow Panel.
11. Confirm Translation tab loads.
12. Confirm Metadata tab loads.
13. Ask a paper-specific question in Chat tab.
14. Check Tools → Developer → Error Console for errors.
```

If an error occurs, fix based on the exact Error Console log.

## Known Current Risk Areas

- Zotero 9 manifest validation may reject missing or malformed `applications.zotero.update_url`.
- The add-on ID must be consistent across `manifest.json`, `updates.json`, and release assets.
- The XPI must place `manifest.json` at the archive root.
- Zotero internal APIs for preferences, menus, and attachment saving may differ between versions.
- The current panel is a separate window, not a native PDF Reader sidebar.
- PDF full-text extraction depends on Zotero’s indexed text availability and attachment handling.

## Release Process

Recommended process for each version:

```text
1. Update addon/manifest.json version.
2. Run bash scripts/build.sh.
3. Verify dist/paperflow.xpi archive structure.
4. Commit source changes.
5. Create GitHub release tag, e.g. v0.2.0.
6. Upload dist/paperflow.xpi as release asset.
7. Update updates.json update_link and version if needed.
8. Commit updates.json.
9. Install release XPI in Zotero 9.0.3.
10. Test the full checklist.
```

## Immediate Task for Codex

When starting from the existing XPI, do this first:

```text
1. Unzip the existing XPI.
2. Move its contents into addon/.
3. Rename plugin metadata to PaperFlow.
4. Set ID to paperflow@06-month.
5. Set Zotero compatibility to 7.0–9.99.99.
6. Set update_url to the GitHub raw updates.json URL.
7. Add scripts/build.sh.
8. Add updates.json.
9. Build dist/paperflow.xpi.
10. Show git diff before committing.
```

Do not make feature changes during this first packaging pass.
