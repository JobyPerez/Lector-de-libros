import oracledb from "oracledb";

import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";
import { calculateParagraphReadingMetrics } from "../services/paragraph-metrics.js";

const migrationStatements = [
  `
    DECLARE
      column_count NUMBER;
    BEGIN
      SELECT COUNT(*) INTO column_count
      FROM user_tab_columns
      WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'WORD_COUNT';

      IF column_count = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (word_count NUMBER DEFAULT 0 NOT NULL)';
      END IF;
    END;
  `,
  `
    DECLARE
      column_count NUMBER;
    BEGIN
      SELECT COUNT(*) INTO column_count
      FROM user_tab_columns
      WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'TTS_CHARACTER_COUNT';

      IF column_count = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (tts_character_count NUMBER DEFAULT 0 NOT NULL)';
      END IF;
    END;
  `
];

type ParagraphRecord = {
  paragraphId: string;
  paragraphText: string;
};

type ParagraphResultSet = {
  close: () => Promise<void>;
  getRows: (count: number) => Promise<ParagraphRecord[]>;
};

async function main() {
  await initializeConnectionPool();
  const connection = await getConnection();
  let resultSet: ParagraphResultSet | undefined;
  let updatedParagraphs = 0;

  try {
    for (const statement of migrationStatements) {
      await connection.execute(statement);
    }

    const result = await connection.execute(
      `
        SELECT
          paragraph_id AS "paragraphId",
          paragraph_text AS "paragraphText"
        FROM book_paragraphs
        ORDER BY book_id, sequence_number
      `,
      {},
      { resultSet: true }
    );
    const paragraphResultSet = result.resultSet as ParagraphResultSet | undefined;
    if (!paragraphResultSet) {
      throw new Error("Oracle no devolvio el cursor para migrar las metricas de lectura.");
    }
    resultSet = paragraphResultSet;

    while (true) {
      const rows = await paragraphResultSet.getRows(500);
      if (rows.length === 0) {
        break;
      }

      const metrics = rows.map((row) => {
        const readingMetrics = calculateParagraphReadingMetrics(row.paragraphText);
        return {
          characterCount: readingMetrics.characterCount,
          paragraphId: row.paragraphId,
          wordCount: readingMetrics.wordCount
        };
      });

      await connection.executeMany(
        `
          UPDATE book_paragraphs
          SET word_count = :wordCount,
              tts_character_count = :characterCount
          WHERE paragraph_id = :paragraphId
        `,
        metrics,
        {
          autoCommit: true,
          bindDefs: {
            characterCount: { type: oracledb.NUMBER },
            paragraphId: { maxSize: 36, type: oracledb.STRING },
            wordCount: { type: oracledb.NUMBER }
          }
        }
      );
      updatedParagraphs += rows.length;
    }

    console.log(`Metricas de lectura actualizadas para ${updatedParagraphs} parrafos.`);
  } finally {
    if (resultSet) {
      await resultSet.close();
    }
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
