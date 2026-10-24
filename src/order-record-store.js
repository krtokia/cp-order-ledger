import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function toOrderRecord(detail) {
  const productItems = Array.isArray(detail?.productItems) ? detail.productItems : [];
  // 금액은 실제 결제액(총 결제금액: 할인·수량·배송비 반영)을 쓴다.
  // 상품 줄 가격은 날에 따라 할인 전 값이 보이고 수량도 빠져 있어서, 총 결제금액을 못 찾았을 때만 쓴다.
  const productAmount = productItems.length > 0 ? sumItems(productItems) : null;
  let amount = detail?.totalPaymentAmount ?? productAmount ?? null;
  let amountSign = detail?.deliveryStatus?.amountSign ?? 'unknown';
  let orderStatus = detail?.deliveryStatus?.raw ?? null;

  // 일부만 반품/취소: 총 결제금액은 처음 결제액 그대로라 돌려받은 상품 줄 가격을 뺀다(상품별 할인은 반영 안 됨 — 근사값).
  const returned = productItems.filter(item => item.amountSign === '-');
  const kept = productItems.filter(item => item.amountSign !== '-');
  if (returned.length > 0 && kept.length > 0) {
    if (amount !== null) amount = Math.max(Math.abs(amount) - sumItems(returned), 0);
    amountSign = '+';
    orderStatus = `${kept[0].status ?? orderStatus} · 일부 ${returned[0].status}`;
  }

  return {
    orderNumber: detail?.orderNumber ?? null,
    orderDate: detail?.orderDate ?? null,
    orderStatus,
    productName: productItems.map(item => item.name).filter(Boolean).join(' / ') || null,
    amount: applyAmountSign(amount, amountSign),
    recipientName: detail?.recipient?.name ?? null,
    recipientAddress: detail?.recipient?.address ?? null
  };
}

export function upsertOrderRecord(filePath, record) {
  if (!record?.orderNumber) {
    throw new Error('주문번호가 없는 레코드는 저장할 수 없습니다.');
  }

  const records = readOrderRecords(filePath);
  const nextRecords = [
    ...records.filter(item => item.orderNumber !== record.orderNumber),
    record
  ].sort(compareOrderRecords);

  writeOrderRecords(filePath, nextRecords);

  return {
    savedRecord: record,
    totalRecords: nextRecords.length,
    filePath
  };
}

export function validateOrderRecord(record) {
  const missingFields = [];

  for (const field of ['orderNumber', 'orderDate', 'orderStatus', 'productName', 'recipientName', 'recipientAddress']) {
    if (isBlank(record?.[field])) missingFields.push(field);
  }

  if (record?.amount === null || record?.amount === undefined || !Number.isFinite(Number(record.amount))) {
    missingFields.push('amount');
  }

  return {
    valid: missingFields.length === 0,
    missingFields
  };
}

export function readOrderRecords(filePath) {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf8').trim();
  if (!content) return [];

  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath}는 주문 배열 JSON이어야 합니다.`);
  }

  return parsed;
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function writeOrderRecords(filePath, records) {
  mkdirSync(dirname(filePath), { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`);
  renameSync(tmpPath, filePath);
}

function compareOrderRecords(a, b) {
  const dateCompare = String(b.orderDate ?? '').localeCompare(String(a.orderDate ?? ''));
  if (dateCompare !== 0) return dateCompare;

  return String(b.orderNumber ?? '').localeCompare(String(a.orderNumber ?? ''));
}

function sumItems(items) {
  return items.reduce((sum, item) => sum + (Number(item.amount) || 0) * (Number(item.quantity) || 1), 0);
}

function applyAmountSign(amount, amountSign) {
  if (amount === null || amount === undefined) return null;
  if (amountSign === '-') return -Math.abs(amount);
  if (amountSign === '+') return Math.abs(amount);
  return amount;
}
