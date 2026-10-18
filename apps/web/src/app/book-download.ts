import { downloadBookExport, downloadOriginalBook, type PdfProfile } from "./api";

export async function downloadBookToDevice(
  accessToken: string,
  bookId: string,
  title: string,
  format?: "epub" | "pdf" | "pdf-images",
  profile: PdfProfile = "original"
) {
  // Await the actual file, not just a download link: preparation can take minutes.
  const download = format
    ? await downloadBookExport(accessToken, bookId, format, profile)
    : await downloadOriginalBook(accessToken, bookId);
  const url = URL.createObjectURL(download.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const extension = format === "epub" || (!format && download.blob.type.includes("epub")) ? "epub" : "pdf";
  anchor.download = download.fileName ?? `${title.replace(/[\\/:*?"<>|]/gu, "_")}.${extension}`;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Give the browser time to hand the file to its download manager.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
