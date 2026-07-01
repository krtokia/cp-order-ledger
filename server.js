import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, 'public');
const SQLITE_FILE = join(ROOT_DIR, 'data/orders.sqlite');
const JSON_FILE = join(ROOT_DIR, 'data/orders.json');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/orders') {
      const month = url.searchParams.get('month');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const recipients = getRecipientFilters(url.searchParams);
      const orders = await readOrders({ month, from, to, recipients });
      const allOrders = await readOrders();
      sendJson(res, {
        orders,
        summary: summarizeOrders(orders),
        months: getMonths(allOrders),
        recipients: getRecipients(allOrders)
      });
      return;
    }

    if (url.pathname === '/api/months') {
      sendJson(res, { months: getMonths(await readOrders()) });
      return;
    }

    if (url.pathname === '/api/recipients') {
      sendJson(res, { recipients: getRecipients(await readOrders()) });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`주문 GUI 서버 실행 중: http://localhost:${PORT}`);
});

async function readOrders(filters = {}) {
  const orders = existsSync(SQLITE_FILE)
    ? await readOrdersFromSqlite()
    : readOrdersFromJson();
  const recipientSet = new Set(filters.recipients ?? []);

  return orders
    .map(normalizeOrderForView)
    .filter(order => !filters.month || order.orderDate?.startsWith(filters.month))
    .filter(order => !filters.from || String(order.orderDate ?? '') >= filters.from)
    .filter(order => !filters.to || String(order.orderDate ?? '') <= filters.to)
    .filter(order => recipientSet.size === 0 || recipientSet.has(order.recipientName))
    .sort((a, b) => {
      const dateCompare = String(b.orderDate ?? '').localeCompare(String(a.orderDate ?? ''));
      if (dateCompare !== 0) return dateCompare;
      return String(b.orderNumber ?? '').localeCompare(String(a.orderNumber ?? ''));
    });
}

async function readOrdersFromSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(SQLITE_FILE, { readOnly: true });

  try {
    return db.prepare(`
      SELECT
        order_number AS orderNumber,
        order_date AS orderDate,
        order_status AS orderStatus,
        product_name AS productName,
        amount,
        recipient_name AS recipientName,
        recipient_address AS recipientAddress
      FROM orders
      ORDER BY order_date DESC, order_number DESC
    `).all().map(row => ({ ...row }));
  } finally {
    db.close();
  }
}

function readOrdersFromJson() {
  if (!existsSync(JSON_FILE)) return [];

  const content = readFileSync(JSON_FILE, 'utf8').trim();
  if (!content) return [];

  const orders = JSON.parse(content);
  if (!Array.isArray(orders)) {
    throw new Error('data/orders.json은 배열이어야 합니다.');
  }

  return orders;
}

function summarizeOrders(orders) {
  return {
    count: orders.length,
    totalAmount: orders.reduce((sum, order) => sum + (Number(order.settlementAmount) || 0), 0),
    originalAmount: orders.reduce((sum, order) => sum + (Number(order.amount) || 0), 0),
    canceledAmount: orders.reduce((sum, order) => sum + Math.abs(Math.min(Number(order.amount) || 0, 0)), 0)
  };
}

function normalizeOrderForView(order) {
  const amount = Number(order.amount) || 0;

  return {
    ...order,
    amount,
    settlementAmount: amount < 0 ? 0 : amount
  };
}

function getMonths(orders) {
  return [...new Set(
    orders
      .map(order => String(order.orderDate ?? '').slice(0, 7))
      .filter(month => /^\d{4}-\d{2}$/.test(month))
  )].sort().reverse();
}

function getRecipients(orders) {
  return [...new Set(
    orders
      .map(order => order.recipientName)
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'ko'));
}

function getRecipientFilters(searchParams) {
  const recipients = [
    ...searchParams.getAll('recipient'),
    ...String(searchParams.get('recipients') ?? '').split(',')
  ];

  return [...new Set(recipients.map(recipient => recipient.trim()).filter(Boolean))];
}

async function serveStatic(pathname, res) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    sendText(res, 'Not Found', 404);
    return;
  }

  const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(readFileSync(filePath));
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
