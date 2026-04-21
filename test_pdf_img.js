import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import fs from 'fs';

async function test() {
  const pdfData = new Uint8Array(fs.readFileSync('samples/libro-prueba.pdf') || Buffer.alloc(0));
}
test().catch(console.error);
