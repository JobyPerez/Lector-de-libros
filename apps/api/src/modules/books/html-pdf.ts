import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import type { HydratableContentImage } from "./content-images.js";
import { preparePdfAssets, optimizePdfAssets } from "./pdf-assets.js";
import type { PdfProfile } from "./pdf-profile.js";

// This is the same content stylesheet used by the reader, without mobile UI rules.
const readerCssUrl = new URL("../../../../web/src/features/reader/reading-document.css", import.meta.url);

export async function renderBookHtmlPdf(title: string, language: string, sheets: string[], contentImages?: ReadonlyMap<string, HydratableContentImage>, profile: PdfProfile = "original"): Promise<Buffer> {
  const assets = await optimizePdfAssets(preparePdfAssets(sheets, contentImages), profile);
  const readerCss = await readFile(readerCssUrl, "utf8");
  const browser = await chromium.launch({
    ...(process.env.PDF_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PDF_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, javaScriptEnabled: false });
    // Book HTML is untrusted. Fulfil only this export's known image resources.
    await page.route("**/*", async (route) => {
      const image = assets.resources.get(route.request().url());
      if (!image || route.request().resourceType() !== "image" || route.request().method() !== "GET") {
        return route.abort();
      }
      await route.fulfill({ body: image.buffer, contentType: image.mimeType });
    });
    await page.emulateMedia({ media: "screen" });
    await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https://lector-pdf-assets.invalid; style-src 'unsafe-inline'; font-src data:">
      <style>
        @page { size: A4; margin: 0; }
        html { font: 16px/1.5 "Aptos", "Trebuchet MS", sans-serif; color: #1f2b23; --ink: #1f2b23; }
        body { margin: 0; }
        * { box-sizing: border-box; }
        ${readerCss}
        img { display: block; max-width: 100%; }
        .reader-rich-content h2, .reader-rich-content h3 { margin: 0; font-family: "Constantia", "Georgia", serif; }
        .pdf-sheet { position: relative; width: 210mm; height: 297mm; overflow: hidden; break-after: page; }
        .pdf-sheet:last-child { break-after: auto; }
        .pdf-content { position: absolute; width: 900px; display: flow-root; }
        .pdf-content * { break-before: auto !important; break-after: auto !important; break-inside: auto !important; }
        .pdf-footer { position: absolute; bottom: 35pt; left: 0; width: 100%; text-align: center; font: 10pt sans-serif; color: #666; }
        .pdf-cover { display: block; width: 100%; height: 970px; object-fit: contain; }
        .pdf-content.pdf-toc { width: calc(210mm - 100pt); font: 12pt/1.5 "Aptos", "Trebuchet MS", sans-serif; }
        .pdf-toc h1 { margin: 0 0 18pt; font-size: 22pt; }
        .pdf-toc a { display: flex; justify-content: space-between; align-items: baseline; gap: 1em; color: inherit; text-decoration: none; margin-block: .5em; }
        .pdf-toc a > span:first-child { min-width: 0; overflow-wrap: anywhere; }
        .pdf-toc-page-number { flex: 0 0 4ch; text-align: right; }
      </style></head><body>${assets.sheets.join("")}</body></html>`, { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map((image) => image.decode().catch(() => undefined)));
      // Legacy pages encode OCR geometry in attributes rather than explicit grid weights.
      const geometry = { bbox(node: Element) {
        try { return JSON.parse(node.getAttribute("data-element-geometry") ?? "null")?.bbox ?? null; }
        catch { return null; }
      } };
      document.querySelectorAll<HTMLElement>(".reader-reading-row:not([data-layout-id])").forEach((row) => {
        const boxes = Array.from(row.children).map((block) => {
          const bodyBoxes = Array.from(block.querySelectorAll("[data-paragraph-number]"))
            .filter((node) => !["header", "footer", "pageNumber"].includes(node.getAttribute("data-element-role") ?? ""))
            .map(geometry.bbox).filter(Boolean);
          if (!bodyBoxes.length) return geometry.bbox(block);
          const left = Math.min(...bodyBoxes.map((box) => box.left));
          const right = Math.max(...bodyBoxes.map((box) => box.left + box.width));
          return { left, width: right - left, height: 1 };
        });
        if (!boxes.length || boxes.some((box) => !box || !Number.isFinite(box.left) || !Number.isFinite(box.width) || box.width <= 0)) return;
        const span = Math.max(...boxes.map((box) => box.left + box.width)) - Math.min(...boxes.map((box) => box.left));
        const gaps = boxes.slice(1).map((box, index) => Math.max(0, box.left - boxes[index].left - boxes[index].width) / span);
        row.style.setProperty("--reader-row-columns", boxes.map((box) => `minmax(0, ${box.width / span}fr)`).join(" "));
        row.style.setProperty("--reader-row-gap", `${Math.min(.08, gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0) * 100}%`);
      });
      document.querySelectorAll<HTMLElement>("[data-image-width]").forEach((node) => {
        const width = Number(node.dataset.imageWidth?.replace(/%$/u, ""));
        if (Number.isFinite(width) && width >= 1 && width <= 100) {
          if (node.tagName === "IMG") node.style.width = `${width}%`;
          else node.style.setProperty("--reader-image-width", `${width}%`);
        } else node.removeAttribute("data-image-width");
      });
      document.querySelectorAll<HTMLElement>("figure[data-paragraph-number]:not([data-image-width])").forEach((figure) => {
        const imageGeometry = geometry.bbox(figure);
        const block = figure.closest(".reader-reading-block");
        const blockGeometry = block ? geometry.bbox(block) : null;
        if (imageGeometry && blockGeometry?.width > 0) figure.style.setProperty("--reader-image-width", `${Math.min(1, imageGeometry.width / blockGeometry.width) * 100}%`);
      });
      const inset = 50 * 96 / 72;
      // Paginate the index at its final reading size before fitting book content.
      // Measure actual wrapped titles rather than assuming a fixed entry count.
      for (const toc of Array.from(document.querySelectorAll<HTMLElement>(".pdf-toc"))) {
        let sheet = toc.closest<HTMLElement>(".pdf-sheet")!;
        let content = toc;
        const heading = toc.querySelector("h1")!;
        const entries = Array.from(toc.querySelectorAll<HTMLAnchorElement>("a"));
        for (const entry of entries) entry.remove();
        const availableHeight = sheet.clientHeight - inset * 2;
        let entryCount = 0;
        for (const entry of entries) {
          content.append(entry);
          if (content.offsetHeight > availableHeight && entryCount > 0) {
            entry.remove();
            const nextSheet = sheet.cloneNode(false) as HTMLElement;
            const nextContent = toc.cloneNode(false) as HTMLElement;
            const nextHeading = heading.cloneNode(true) as HTMLElement;
            nextHeading.textContent = `${heading.textContent} (${document.documentElement.lang === "it" ? "continua" : "continuación"})`;
            nextContent.append(nextHeading, entry);
            nextSheet.append(nextContent, sheet.querySelector(".pdf-footer")!.cloneNode(true));
            sheet.after(nextSheet);
            sheet = nextSheet;
            content = nextContent;
            entryCount = 0;
          }
          entryCount += 1;
        }
      }
      const sheets = Array.from(document.querySelectorAll<HTMLElement>(".pdf-sheet"));
      const physicalPages = new Map<string, number>();
      for (const [index, sheet] of sheets.entries()) {
        if (sheet.id) physicalPages.set(sheet.id, index + 1);
        const footer = sheet.querySelector<HTMLElement>(".pdf-footer");
        if (footer) footer.textContent = String(index + 1);
      }
      document.querySelectorAll<HTMLAnchorElement>(".pdf-toc a").forEach((link) => {
        const number = physicalPages.get(link.getAttribute("href")!.slice(1));
        link.querySelector(".pdf-toc-page-number")!.textContent = number ? String(number) : "";
      });
      for (const sheet of sheets) {
        const content = sheet.querySelector<HTMLElement>(".pdf-content")!;
        if (content.classList.contains("pdf-toc")) {
          content.style.top = `${inset}px`;
          content.style.left = `${inset}px`;
          continue;
        }
        const width = Math.max(content.offsetWidth, content.scrollWidth);
        const height = Math.max(content.offsetHeight, content.scrollHeight, 1);
        const scale = Math.min(1, (sheet.clientWidth - inset * 2) / width, (sheet.clientHeight - inset * 2) / height);
        // Unlike transforms, zoom also scales the layout box used by Chromium's PDF clipping.
        content.style.zoom = String(scale);
        content.style.top = `${inset / scale}px`;
        content.style.left = `${(sheet.clientWidth - width * scale) / 2 / scale}px`;
      }
    });
    await page.evaluate((value) => { document.title = value; }, title);
    return await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true });
  } finally {
    await browser.close();
  }
}
