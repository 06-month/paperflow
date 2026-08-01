# Changelog

## v0.5.0

### Layout-aware translation

- Add a layout-aware PDF pipeline inspired by the existing pdf2md workflow: retain native text coordinates, classify page blocks with Gemini structured output, translate stable text-block IDs, and reconstruct complete original Figure/Table regions from the rendered source page. Fall back to the existing text-only pipeline on analysis failure.
- Add a Zotero-data `PaperFlow_PdfSplit` cache with per-paper Markdown, manifest JSON, page text, full-page renders, extracted Figure/Table images, repeated/small/header-footer filtering, and Markdown backup behavior.
- Reconstruct every detected formula as LaTeX plus sanitized Presentation MathML. Render inline math natively, center standalone/numbered equations, retain `$$...$$` source in the split Markdown, and expose a collapsible LaTeX source in the translation view.
- Associate Figure/Table captions with their owning visual, translate caption blocks, and render the translated caption immediately below the original visual without a duplicate standalone caption.
- Run Gemini page analysis and translation jobs concurrently with a configurable 2-14 worker setting. Serialize rate-limit slot allocation to prevent parallel workers from racing past the RPM/RPD guard.
- Add a privacy-visible preference for layout analysis because rendered PDF pages and embedded text are sent to Gemini when enabled.

### Chat

- Bring the standalone Open PaperFlow Panel chat to feature parity with the Reader sidebar: PDF/Summary/Translation selection capture, removable attachment cards, Finder file attachments, clipboard image paste, Gemini multimodal payloads, and multi-turn history.
- Clear the composer immediately on send and safely render Gemini Markdown (headings, emphasis, lists, tables, quotes, links, and code) plus inline/display LaTeX as native MathML in both chat surfaces.
- Replace the fixed "무엇이든 질문하세요." placeholder with suggested questions ("이 논문의 배경을 분석해서 설명해줘", "메서드를 이해하기 쉽게 설명해줘", …) that cross-fade every 5 seconds while the input is empty, in both the panel and the Reader sidebar. The suggestion disappears instantly on the first keystroke.
- Fix the leftover Korean character after sending a chat message: an open IME composition is now committed before the value is read, so the syllable being composed can no longer be re-inserted into the just-cleared input. The send button path is covered too, not only Enter.

### Layout / UX

- Add paragraph-aware translation rendering and resizable pane snap modes for the Reader sidebar and standalone PaperFlow panel.
- Make both the standalone Open PaperFlow Panel and Zotero Reader sidebar document widths fully responsive: translation text, visuals, equations, and metadata now expand with their host pane and reflow safely at narrow widths.
- Refresh sidebar icon assets and use the correctly sized 24×24 variants in Zotero's fixed-size sidebar slots.
- Grow the chat input with its content (up to 200px in the panel, 132px in the sidebar) and pin the chat pane's bottom edge: the pane now measures what its attachment chips and composer actually need and claims that height from the view above, so the composer expands upward instead of sliding past the bottom of the window. The divider can no longer be dragged below that floor either, and the floor is frozen for the duration of a drag so holding the cursor at the collapse threshold no longer flickers between split and content-only.

## v0.4.0

### Features

- Attachment-aware chat: selecting text in the PDF reader, Summary view, or Translation view automatically attaches the selection to the sidebar chat. Each attachment renders as a card above the input showing the source as a bold title (**Summary** / **Translation** / **PDF 원문**) with the selected text underneath, truncated with "…" past 140 chars. Cards are removable; the latest selection per source replaces the previous one. Selections as short as 2 characters are captured.
- The chat `+` button opens the OS file picker (Finder): attach local text files (12k-char cap), images (≤6MB), or PDFs (≤10MB). Images and PDFs are sent to Gemini as inline multimodal data.
- Paste an image from the clipboard (⌘V / Ctrl+V) into the chat input to attach it. Image attachments render as a bare thumbnail with a corner × overlay (no text label), and sent messages show the image inside the user bubble, GPT/Claude style. Falls back to reading the image directly from `nsIClipboard` when the chrome paste event does not expose clipboard image data.
- Multiple image attachments lay out horizontally (left to right) in both the attachment area and the sent message bubble.
- The translation progress window now has an × button that closes the popup without cancelling — translation keeps running in the background. The 취소 button still cancels.
- Selection attachments auto-dismiss when the selection is cleared (e.g., clicking elsewhere): sidebar-view selections are tracked via `selectionchange`, PDF selections via a hidden marker in the reader selection popup. Clicking into the chat composer to type does not dismiss them.
- Sent messages display what was attached and from where inside the user bubble; attachments are passed to Gemini with explicit source labels and prioritized as grounding for the answer. Attachment usage is also recorded in the multi-turn history so follow-up questions keep working.
- Removed the canned greeting bubble ("안녕하세요. 이 논문의 요약과...") from the chat log.

### Reliability

- Save partial results at every section boundary and on cancel/error, so completed chunks are never discarded.
- Add a Resume option for interrupted translations: completed chunks (verified by text hash) are reused instead of re-translated.
- Store translated text inside `pt-meta.json`, making the structured JSON the source of truth; HTML and the Zotero note are now derived views. Chat context is built from JSON instead of re-parsing display HTML (legacy HTML parsing kept as fallback).
- Detect truncated (`MAX_TOKENS`), safety-blocked, and empty Gemini responses; fail the chunk instead of saving broken JSON as a "done" translation.
- Reduce chunk size (2000 → 1500 tokens) and raise `maxOutputTokens` (4096 → 8192) to prevent Korean output truncation.
- Persist the daily rate-limit counter across Zotero restarts and align the reset with Google's Pacific-midnight quota reset; chat requests now also go through the rate limiter.
- Skip retries for non-retryable errors (safety block, output truncation) instead of burning quota on 3 doomed attempts.
- Treat only `code === "CANCELLED"` as user cancellation (message regex misclassified network errors like "cancelled by peer").

### Security

- Send the Gemini API key via the `x-goog-api-key` header instead of the URL query string (translation, chat, and connection test).

### Correctness

- Section summaries for multi-chunk sections now receive a section-wide overview instead of only the last chunk's text.
- Prefer PDFWorker extraction over the full-text index, which can silently truncate long papers.
- Preserve the Appendix when truncating References; guard header/footer cleanup patterns by line length to avoid deleting body sentences.
- Identify PaperFlow artifacts (HTML/meta/note) by Zotero tags instead of filename/substring matching (legacy matching kept as fallback).
- Stop embedding base64 metadata in the Zotero note (it broke when users edited the note); `pt-meta.json` is authoritative, legacy notes still readable.
- Fix re-entrancy: the running-queue check now happens before dialogs, and the sidebar button refuses to start a second concurrent translation.

### UX / Maintenance

- Apply the sidenav order (PaperFlow at bottom) only once instead of overriding the user's panel order on every startup.
- Version the reader-panel custom element name so plugin updates don't keep running the stale pre-update element class.
- Centralize model name and plugin version in `src/utils/constants.js`; multi-turn chat history is now sent with sidebar chat questions.

## v0.3.0

- Added Zotero Reader sidebar integration for PaperFlow reading workflow.
- Added Summary, Translation, Meta, and Gemini chat sidebar UI.
- Added generated artifact reuse for existing PaperFlow note, translation, and metadata outputs.
- Improved progress window cancellation and visual status handling.
- Improved sidebar layout resizing, chat panel sizing, and text selection in content views.
- Updated project README for the open-source research assistant direction.

## v0.2.2

- Cleaned Zotero 9.0.3 compatibility metadata in `manifest.json`.
- Standardized public name and add-on ID to PaperFlow and `paperflow@06-month`.
- Applied the GitHub raw `updates.json` URL.
- Updated `updates.json` for the GitHub release asset.
- Kept the build script for packaging `addon/` contents into `dist/paperflow.xpi`.
- Included PaperFlow icon assets in the packaged add-on.
- Prepared Phase 1-11 MVP packaging for install testing.

## v0.2.0

- Established the Phase 1-11 MVP packaging baseline.
