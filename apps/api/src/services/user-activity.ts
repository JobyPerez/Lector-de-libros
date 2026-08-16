import { randomUUID } from "node:crypto";

export type UserActivityAction =
  | "LOGIN"
  | "LOGOUT"
  | "PROFILE_UPDATED"
  | "PASSWORD_RESET"
  | "BOOK_VIEWED"
  | "BOOK_CREATED"
  | "BOOK_IMPORTED"
  | "BOOK_UPDATED"
  | "BOOK_DELETED"
  | "BOOK_EXPORTED"
  | "BOOK_STATUS_UPDATED"
  | "BOOK_RATED"
  | "BOOK_SHARED"
  | "BOOK_UNSHARED"
  | "BOOK_TRANSFERRED"
  | "AUDIO_LISTENED"
  | "OCR_UPDATED"
  | "PAGE_OCR_RERUN"
  | "PAGE_IMAGE_ROTATED"
  | "PAGE_IMAGE_UPDATED"
  | "PAGE_DELETED"
  | "PAGES_IMPORTED"
  | "BOOKMARK_CREATED"
  | "BOOKMARK_DELETED"
  | "NOTE_CREATED"
  | "NOTE_UPDATED"
  | "NOTE_DELETED"
  | "HIGHLIGHT_CREATED"
  | "HIGHLIGHT_DELETED"
  | "AI_REQUEST_CREATED"
  | "AI_REQUEST_DELETED"
  | "CHAPTER_SUMMARY_GENERATED"
  | "USER_CREATED"
  | "USER_UPDATED"
  | "USER_DELETED";

type ActivityConnection = {
  execute: (sql: string, binds?: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
};

export async function recordUserActivity(
  connection: ActivityConnection,
  activity: {
    action: UserActivityAction;
    bookId?: string | null;
    bookTitle?: string | null;
    chapterTitle?: string | null;
    detail?: string | null;
    durationSeconds?: number | null;
    ipAddress?: string | null;
    pageNumber?: number | null;
    sessionId?: string | null;
    userAgent?: string | null;
    userId: string;
  }
): Promise<void> {
  await connection.execute(
    `
      INSERT INTO user_activity_events (
        activity_id,
        user_id,
        session_id,
        action,
        book_id,
        book_title,
        chapter_title,
        page_number,
        detail,
        duration_seconds,
        ip_address,
        user_agent
      ) VALUES (
        :activityId,
        :userId,
        :sessionId,
        :action,
        :bookId,
        :bookTitle,
        :chapterTitle,
        :pageNumber,
        :detail,
        :durationSeconds,
        :ipAddress,
        :userAgent
      )
    `,
    {
      action: activity.action,
      activityId: randomUUID(),
      bookId: activity.bookId ?? null,
      bookTitle: activity.bookTitle ?? null,
      chapterTitle: activity.chapterTitle ?? null,
      detail: activity.detail ? activity.detail.slice(0, 1000) : null,
      durationSeconds: activity.durationSeconds ?? 0,
      ipAddress: activity.ipAddress ?? null,
      pageNumber: typeof activity.pageNumber === "number" ? activity.pageNumber : null,
      sessionId: activity.sessionId ?? null,
      userAgent: activity.userAgent ?? null,
      userId: activity.userId
    }
  );
}

export async function recordBookView(
  connection: ActivityConnection,
  activity: { bookId: string; bookTitle: string; userId: string }
): Promise<void> {
  await connection.execute(
    `
      INSERT INTO user_activity_events (
        activity_id,
        user_id,
        action,
        book_id,
        book_title
      )
      SELECT
        :activityId,
        :userId,
        'BOOK_VIEWED',
        :bookId,
        :bookTitle
      FROM dual
      WHERE NOT EXISTS (
        SELECT 1
        FROM user_activity_events
        WHERE user_id = :userId
          AND book_id = :bookId
          AND action = 'BOOK_VIEWED'
          AND created_at >= SYSTIMESTAMP - INTERVAL '10' MINUTE
      )
    `,
    {
      activityId: randomUUID(),
      bookId: activity.bookId,
      bookTitle: activity.bookTitle,
      userId: activity.userId
    }
  );
}

export async function recordListeningActivity(
  connection: ActivityConnection,
  activity: {
    activeSeconds: number;
    bookId: string;
    bookTitle: string;
    chapterTitle?: string | null;
    sessionId: string;
    userId: string;
  }
): Promise<void> {
  const updateResult = (await connection.execute(
    `
      UPDATE user_activity_events
      SET duration_seconds = NVL(duration_seconds, 0) + :activeSeconds,
          created_at = SYSTIMESTAMP
      WHERE activity_id = (
        SELECT activity_id FROM (
          SELECT activity_id
          FROM user_activity_events
          WHERE user_id = :userId
            AND book_id = :bookId
            AND action = 'AUDIO_LISTENED'
            AND (
              (chapter_title IS NULL AND :chapterTitle IS NULL)
              OR chapter_title = :chapterTitle
            )
            AND (
              session_id = :sessionId
              OR created_at >= SYSTIMESTAMP - INTERVAL '30' MINUTE
            )
          ORDER BY created_at DESC
        ) WHERE ROWNUM = 1
      )
    `,
    {
      activeSeconds: activity.activeSeconds,
      bookId: activity.bookId,
      chapterTitle: activity.chapterTitle ?? null,
      sessionId: activity.sessionId,
      userId: activity.userId
    }
  )) as { rowsAffected?: number };

  if (!updateResult?.rowsAffected || updateResult.rowsAffected === 0) {
    await connection.execute(
      `
        INSERT INTO user_activity_events (
          activity_id,
          user_id,
          session_id,
          action,
          book_id,
          book_title,
          chapter_title,
          duration_seconds,
          created_at
        ) VALUES (
          :activityId,
          :userId,
          :sessionId,
          'AUDIO_LISTENED',
          :bookId,
          :bookTitle,
          :chapterTitle,
          :durationSeconds,
          SYSTIMESTAMP
        )
      `,
      {
        activityId: randomUUID(),
        bookId: activity.bookId,
        bookTitle: activity.bookTitle,
        chapterTitle: activity.chapterTitle ?? null,
        durationSeconds: activity.activeSeconds,
        sessionId: activity.sessionId,
        userId: activity.userId
      }
    );
  }
}
