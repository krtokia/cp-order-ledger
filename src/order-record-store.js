import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function toOrderRecord(detail) {
  const productItems = Array.isArray(detail?.productItems) ? detail.productItems : [];
  const amountSign = detail?.deliveryStatus?.amountSign ?? 'unknown';
  const productAmount = productItems.length > 0
    ? productItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
    : null;

  return {
    orderNumber: detail?.orderNumber ?? null,
    orderDate: detail?.orderDate ?? null,
    orderStatus: detail?.deliveryStatus?.raw ?? null,
    productName: productItems.map(item => item.name).filter(Boolean).join(' / ') || null,
    amount: applyAmountSign(productAmount ?? detail?.totalPaymentAmount ?? null, amountSign),
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

function applyAmountSign(amount, amountSign) {
  if (amount === null || amount === undefined) return null;
  if (amountSign === '-') return -Math.abs(amount);
  if (amountSign === '+') return Math.abs(amount);
  return amount;
}
