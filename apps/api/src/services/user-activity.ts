import { randomUUID } from "node:crypto";

export type UserActivityAction = "LOGIN" | "BOOK_VIEWED" | "BOOK_CREATED" | "BOOK_UPDATED" | "BOOK_DELETED";

type ActivityConnection = {
  execute: (sql: string, binds?: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
};

export async function recordUserActivity(
  connection: ActivityConnection,
  activity: {
    action: UserActivityAction;
    bookId?: string | null;
    bookTitle?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    userId: string;
  }
): Promise<void> {
  await connection.execute(
    `
      INSERT INTO user_activity_events (
        activity_id,
        user_id,
        action,
        book_id,
        book_title,
        ip_address,
        user_agent
      ) VALUES (
        :activityId,
        :userId,
        :action,
        :bookId,
        :bookTitle,
        :ipAddress,
        :userAgent
      )
    `,
    {
      action: activity.action,
      activityId: randomUUID(),
      bookId: activity.bookId ?? null,
      bookTitle: activity.bookTitle ?? null,
      ipAddress: activity.ipAddress ?? null,
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
