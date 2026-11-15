import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { buildPaginationMeta, type PaginatedResult, toPageOffset } from '../common/utils/public-search.util';
import {
  type CreateNotificationInput,
  normalizeNotificationInput,
  type NotificationPayload,
  type NotificationTarget,
  type NotificationTargetType,
  type NotificationType,
} from './notification-types';

/** Public representation. Never contains recipient id, event key or internals. */
export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  payload: NotificationPayload;
  target: NotificationTarget | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export type NotificationReadFilter = 'all' | 'unread' | 'read';

export interface NotificationListQuery {
  page: number;
  limit: number;
  status: NotificationReadFilter;
  /** Snapshot anchor: only notifications with id <= maxId. */
  maxId?: string;
}

export interface NotificationListEcho {
  status: NotificationReadFilter;
  /** Anchor actually applied (the newest id when not supplied; null for an empty inbox). Pass it back for the next pages. */
  maxId: string | null;
}

export interface CreateNotificationResult {
  created: boolean;
  notification: NotificationView;
}

/** The recipient user does not exist (FK violation). */
export class NotificationRecipientNotFoundError extends Error {
  constructor(recipientUserId: string) {
    super(`Notification recipient ${recipientUserId} does not exist`);
    this.name = 'NotificationRecipientNotFoundError';
  }
}

interface NotificationRow {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  payload: NotificationPayload;
  target_type: NotificationTargetType | null;
  target_id: string | null;
  read_at: Date | null;
  created_at: Date;
}

const COLUMNS = 'id::text AS id, type, title, body, payload, target_type, target_id::text AS target_id, read_at, created_at';
export const NOTIFICATION_NOT_FOUND = 'Notification not found';

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: row.payload ?? {},
    target: row.target_type && row.target_id ? { type: row.target_type, id: row.target_id } : null,
    isRead: row.read_at !== null,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/**
 * P3-BE04 notification inbox.
 *
 * Reading: every query is scoped by the recipient taken from the
 * authenticated principal; someone else's notification is
 * indistinguishable from a missing one (404). Ordering is newest first by
 * id (creation order), deterministic and index-backed.
 *
 * Writing: `create` is internal (no public endpoint); events re-delivered
 * with the same `eventKey` return the existing row. Content is immutable;
 * `read_at` is set once.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Persists one notification. Pass the caller's `manager` to make it part
   * of a business transaction (it commits or rolls back with it).
   * Idempotent per (recipient, eventKey): a duplicate returns
   * `{ created: false }` with the original. Throws NotificationInputError
   * for invalid input and NotificationRecipientNotFoundError for an
   * unknown recipient (inside a caller transaction, that error aborts it).
   */
  async create(input: CreateNotificationInput, manager?: EntityManager): Promise<CreateNotificationResult> {
    const n = normalizeNotificationInput(input);
    const em = manager ?? this.dataSource.manager;
    let rows: NotificationRow[];

    try {
      rows = await em.query(
        `INSERT INTO notifications (recipient_user_id, type, title, body, payload, target_type, target_id, event_key)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (recipient_user_id, event_key) DO NOTHING
         RETURNING ${COLUMNS}`,
        [n.recipientUserId, n.type, n.title, n.body, JSON.stringify(n.payload), n.targetType, n.targetId, n.eventKey],
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503') {
        throw new NotificationRecipientNotFoundError(n.recipientUserId);
      }
      throw error;
    }

    if (rows.length === 1) {
      return { created: true, notification: toView(rows[0]) };
    }

    // ON CONFLICT DO NOTHING: an earlier delivery of the same event exists.
    const existing: NotificationRow[] = await em.query(
      `SELECT ${COLUMNS} FROM notifications WHERE recipient_user_id = $1 AND event_key = $2`,
      [n.recipientUserId, n.eventKey],
    );

    return { created: false, notification: toView(existing[0]) };
  }

  /** Creates several notifications (e.g. every staff member of a provider) in one transaction. */
  async createMany(inputs: CreateNotificationInput[], manager?: EntityManager): Promise<CreateNotificationResult[]> {
    const run = async (em: EntityManager) => {
      const results: CreateNotificationResult[] = [];
      for (const input of inputs) results.push(await this.create(input, em));
      return results;
    };
    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  async list(recipientUserId: string, query: NotificationListQuery): Promise<PaginatedResult<NotificationView, NotificationListEcho>> {
    const anchor =
      query.maxId ??
      ((await this.dataSource.query(`SELECT max(id)::text AS max FROM notifications WHERE recipient_user_id = $1`, [recipientUserId])) as { max: string | null }[])[0].max;

    if (anchor === null) {
      return { items: [], meta: buildPaginationMeta(query.page, query.limit, 0), query: { status: query.status, maxId: null } };
    }

    const readFilter = query.status === 'unread' ? 'AND read_at IS NULL' : query.status === 'read' ? 'AND read_at IS NOT NULL' : '';
    const where = `recipient_user_id = $1 AND id <= $2 ${readFilter}`;
    const [{ total }] = (await this.dataSource.query(`SELECT count(*)::int AS total FROM notifications WHERE ${where}`, [recipientUserId, anchor])) as { total: number }[];
    // Order by the bigint column, qualified: a bare "id" would resolve to the
    // text output alias (id::text AS id) and sort lexicographically ("9" > "30").
    const rows: NotificationRow[] = await this.dataSource.query(
      `SELECT ${COLUMNS} FROM notifications WHERE ${where} ORDER BY notifications.id DESC LIMIT $3 OFFSET $4`,
      [recipientUserId, anchor, query.limit, toPageOffset(query.page, query.limit)],
    );

    return {
      items: rows.map(toView),
      meta: buildPaginationMeta(query.page, query.limit, total),
      query: { status: query.status, maxId: anchor },
    };
  }

  async unreadCount(recipientUserId: string): Promise<{ unreadCount: number }> {
    const [{ count }] = (await this.dataSource.query(
      `SELECT count(*)::int AS count FROM notifications WHERE recipient_user_id = $1 AND read_at IS NULL`,
      [recipientUserId],
    )) as { count: number }[];
    return { unreadCount: count };
  }

  /** Details; does NOT mark the notification as read. */
  async findOne(recipientUserId: string, id: string): Promise<NotificationView> {
    const rows: NotificationRow[] = await this.dataSource.query(
      `SELECT ${COLUMNS} FROM notifications WHERE id = $1 AND recipient_user_id = $2`,
      [id, recipientUserId],
    );
    if (rows.length === 0) throw new NotFoundException(NOTIFICATION_NOT_FOUND);
    return toView(rows[0]);
  }

  /** Idempotent: an already read notification keeps its original readAt. */
  async markRead(recipientUserId: string, id: string): Promise<NotificationView> {
    const updated: [NotificationRow[], number] = await this.dataSource.query(
      `UPDATE notifications SET read_at = now() WHERE id = $1 AND recipient_user_id = $2 AND read_at IS NULL RETURNING ${COLUMNS}`,
      [id, recipientUserId],
    );
    const rows = updated[0];
    if (rows.length === 1) return toView(rows[0]);
    return this.findOne(recipientUserId, id);
  }

  /**
   * Marks the caller's unread notifications as read: all of them, or only
   * those with id <= upToId (what the client has actually displayed), so
   * notifications arriving meanwhile stay unread. Idempotent.
   */
  async markAllRead(recipientUserId: string, upToId?: string): Promise<{ markedCount: number; unreadCount: number }> {
    const params: string[] = [recipientUserId];
    let bound = '';
    if (upToId) {
      params.push(upToId);
      bound = 'AND id <= $2';
    }
    const updated: [unknown[], number] = await this.dataSource.query(
      `UPDATE notifications SET read_at = now() WHERE recipient_user_id = $1 AND read_at IS NULL ${bound}`,
      params,
    );
    const { unreadCount } = await this.unreadCount(recipientUserId);
    return { markedCount: updated[1] ?? 0, unreadCount };
  }
}
