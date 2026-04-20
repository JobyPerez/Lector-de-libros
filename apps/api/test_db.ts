import { getConnection, initializeConnectionPool, closeConnectionPool } from './src/config/database.js';

async function run() {
  try {
    await initializeConnectionPool();
    const conn = await getConnection();
    
    const bookId = 'ad573330-520c-4538-b544-d5313fefda25';
    
    console.log(`\nPages for book_id: ${bookId}`);
    const pages = await conn.execute(`SELECT page_number, html_content FROM book_pages WHERE book_id = :bookId AND page_number = 2 ORDER BY page_number ASC`, { bookId });
    console.dir(pages.rows, { depth: null });
    
    await closeConnectionPool();
  } catch(e) {
    console.error(e);
  }
}
run();