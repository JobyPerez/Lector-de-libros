import { getConnection, initializeConnectionPool, closeConnectionPool } from './src/config/database.js';
import { buildRichPageFromEditableText, extractEmbeddedImageSources } from './src/modules/books/rich-content.js';

async function run() {
  try {
    await initializeConnectionPool();
    const conn = await getConnection();
    
    const bookId = 'ad573330-520c-4538-b544-d5313fefda25';
    
    const pages = await conn.execute(`SELECT page_id, page_number, edited_text, html_content FROM book_pages WHERE book_id = :bookId`, { bookId });
    const rows = pages.rows as any[];
    
    for (const page of rows) {
      const pageEmbeddedImages = extractEmbeddedImageSources(page.HTML_CONTENT);
      const richPage = buildRichPageFromEditableText(page.EDITED_TEXT, { embeddedImages: pageEmbeddedImages });
      
      console.log(`Updating page ${page.PAGE_NUMBER}`);
      await conn.execute(
        `UPDATE book_pages SET html_content = :htmlContent, raw_text = :rawText WHERE page_id = :pageId`,
        {
          htmlContent: richPage.htmlContent,
          rawText: richPage.rawText || page.EDITED_TEXT,
          pageId: page.PAGE_ID
        }
      );
    }
    
    await conn.commit();
    console.log('Done!');
    await closeConnectionPool();
  } catch(e) {
    console.error(e);
  }
}
run();