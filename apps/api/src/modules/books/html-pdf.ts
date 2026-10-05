import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// This is the same content stylesheet used by the reader, without mobile UI rules.
const readerCssUrl = new URL("../../../../web/src/features/reader/reading-document.css", import.meta.url);

export async function renderBookHtmlPdf(title: string, language: string, sheets: string[]): Promise<Buffer> {
  const readerCss = await readFile(readerCssUrl, "utf8");
  const browser = await chromium.launch({
    ...(process.env.PDF_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PDF_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, javaScriptEnabled: false });
    // Book HTML is untrusted. Assets have already been hydrated as data URLs by the API.
    await page.route("**/*", (route) => route.abort());
    await page.emulateMedia({ media: "screen" });
    await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
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
        .pdf-toc a { display: flex; justify-content: space-between; gap: 1em; color: inherit; text-decoration: none; margin-block: .5em; }
      </style></head><body>${sheets.join("")}</body></html>`, { waitUntil: "load" });
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
      for (const sheet of Array.from(document.querySelectorAll<HTMLElement>(".pdf-sheet"))) {
        const content = sheet.querySelector<HTMLElement>(".pdf-content")!;
        const inset = 50 * 96 / 72;
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
