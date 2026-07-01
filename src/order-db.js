import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export async function openOrderDatabase(databaseConfig) {
  if (!databaseConfig?.enabled) return null;
  if (databaseConfig.type !== 'sqlite') {
    throw new Error(`지원하지 않는 DB 타입입니다: ${databaseConfig.type}`);
  }

  return openSqliteOrderDatabase(databaseConfig.path);
}

async function openSqliteOrderDatabase(dbPath) {
  if (!dbPath) throw new Error('SQLite DB path가 필요합니다.');

  mkdirSync(dirname(dbPath), { recursive: true });

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS orders (
      order_number TEXT PRIMARY KEY,
      order_date TEXT NOT NULL,
      order_status TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      recipient_name TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);
  `);

  const upsertStatement = db.prepare(`
    INSERT INTO orders (
      order_number,
      order_date,
      order_status,
      product_name,
      amount,
      recipient_name,
      recipient_address,
      updated_at
    ) VALUES (
      :orderNumber,
      :orderDate,
      :orderStatus,
      :productName,
      :amount,
      :recipientName,
      :recipientAddress,
      datetime('now')
    )
    ON CONFLICT(order_number) DO UPDATE SET
      order_date = excluded.order_date,
      order_status = excluded.order_status,
      product_name = excluded.product_name,
      amount = excluded.amount,
      recipient_name = excluded.recipient_name,
      recipient_address = excluded.recipient_address,
      updated_at = datetime('now')
  `);

  return {
    path: dbPath,
    upsertOrder(record) {
      upsertStatement.run(record);
    },
    close() {
      db.close();
    }
  };
}
