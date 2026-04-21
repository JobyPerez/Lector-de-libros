import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import fs from 'fs';

async function test() {
  const fileBuffer = fs.readFileSync('doc/2601-Guide-to-Voice-Agents-By-Deepgram.pdf');
  const pdfDocument = await getDocument(new Uint8Array(fileBuffer)).promise;
  const page = await pdfDocument.getPage(1);
  const operatorList = await page.getOperatorList();
  
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const fn = operatorList.fnArray[i];
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) {
      const objId = operatorList.argsArray[i][0];
      console.log('Found image objId:', objId);
      try {
        const imgData = await page.objs.get(objId);
        console.log('imgData keys:', Object.keys(imgData));
        console.log('width:', imgData.width, 'height:', imgData.height, 'kind:', imgData.kind);
        
        let channels = 3;
        if (imgData.kind === 1) channels = 1; // GRAYSCALE
        else if (imgData.kind === 2) channels = 3; // RGB
        else if (imgData.kind === 3) channels = 4; // RGBA
        
        console.log('channels:', channels);
        
        if (imgData.data) {
          console.log('Has data buffer of length:', imgData.data.length);
          const buf = Buffer.from(imgData.data);
          const pngBuffer = await sharp(buf, {
            raw: {
              width: imgData.width,
              height: imgData.height,
              channels: channels
            }
          }).png().toBuffer();
          console.log('Converted to PNG base64, length:', pngBuffer.toString('base64').length);
          break;
        }
      } catch (e) {
        console.error('Error extracting image', e);
      }
    }
  }
}
test().catch(console.error);