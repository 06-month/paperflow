// Zotero's PDF.js display build expects DOM globals that are unavailable in
// bootstrap sub-script globals. Load it inside this hidden chrome document.
try {
  const workerModule = await import("resource://zotero/reader/pdf/build/pdf.worker.mjs");
  globalThis.pdfjsWorker = workerModule;

  const pdfjs = await import("resource://zotero/reader/pdf/build/pdf.mjs");
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
  }
  window.PaperFlowPDFRuntime = { pdfjs };
} catch (error) {
  window.PaperFlowPDFRuntimeError = {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
}

window.dispatchEvent(new CustomEvent("paperflow-pdf-runtime-ready"));
