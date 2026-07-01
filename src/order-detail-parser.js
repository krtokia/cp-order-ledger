import { readFileSync } from 'node:fs';
import { formatLocalDate, parseFlexibleDate } from './date-utils.js';
import { splitMeaningfulLines } from './order-parser.js';

const DEFAULT_STATUS_CONFIG = JSON.parse(
  readFileSync(new URL('../config/order-statuses.json', import.meta.url), 'utf8')
);

const MONEY_PATTERN = /[-+]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\s*원/;
const ORDER_NUMBER_PATTERN = /주문\s*번호\s*([0-9][0-9-]{7,})/;
const DETAIL_END_PATTERN = /^(받는\s*사람\s*정보|받는사람\s*정보|결제\s*정보|결제수단|총\s*상품가격|총\s*결제\s*금액|총\s*결제금액)$/;

const PRODUCT_NOISE_PATTERNS = [
  /^(배송완료|배송중|상품준비중|배송준비중|주문완료|결제완료|구매확정|주문취소|취소완료|환불완료|반품완료)$/,
  /(도착|문앞\s*전달|문앞|배송\s*조회|교환,\s*반품\s*신청|장바구니\s*담기|리뷰\s*작성하기|판매자\s*문의)/,
  /^(주문상세|주문목록|주문번호|결제\s*정보|받는\s*사람\s*정보|받는사람\s*정보)$/,
  /^\d+\s*개$/,
  MONEY_PATTERN
];

export function parseOrderDetailPage(detailText, statusConfig = DEFAULT_STATUS_CONFIG) {
  const lines = splitMeaningfulLines(detailText).map(cleanValue);
  const header = extractOrderHeader(lines);
  const status = extractStatus(lines, header.index, statusConfig);
  const items = extractProductItems(lines, header.index, status?.lineIndex ?? header.index);
  const totalPayment = extractTotalPaymentAmount(lines);
  const amountSign = status?.amountSign ?? 'unknown';

  const result = {
    orderNumber: header.orderNumber ?? extractOrderNumber(lines),
    orderDate: header.orderDate ? formatLocalDate(header.orderDate) : null,
    orderDateText: header.orderDateText,
    deliveryStatus: status
      ? {
          raw: status.status,
          line: status.line,
          amountSign
        }
      : null,
    productNames: items.map(item => item.name),
    productItems: items,
    recipient: {
      name: extractRecipientName(lines),
      address: extractRecipientAddress(lines)
    },
    totalPaymentAmount: totalPayment?.amount ?? null,
    totalPaymentAmountText: totalPayment?.text ?? null,
    signedTotalPaymentAmount: applyAmountSign(totalPayment?.amount ?? null, amountSign),
    parserWarnings: []
  };

  if (!result.orderNumber) result.parserWarnings.push('주문번호를 찾지 못했습니다.');
  if (!result.orderDate) result.parserWarnings.push('주문 날짜를 찾지 못했습니다.');
  if (!result.deliveryStatus) result.parserWarnings.push('배송/주문 상태를 찾지 못했습니다.');
  if (result.productNames.length === 0) result.parserWarnings.push('상품명을 찾지 못했습니다.');
  if (!result.recipient.name && !result.recipient.address) {
    result.parserWarnings.push('받는 사람 정보를 찾지 못했습니다.');
  }
  if (result.totalPaymentAmount === null) result.parserWarnings.push('총 결제 금액을 찾지 못했습니다.');

  return result;
}

function extractOrderHeader(lines) {
  const detailIndex = lines.findIndex(line => line === '주문상세');
  const searchStart = detailIndex >= 0 ? detailIndex + 1 : 0;

  for (let index = searchStart; index < lines.length; index += 1) {
    const line = lines[index];
    const orderDate = parseFlexibleDate(line);
    const orderNumber = extractOrderNumberFromText(line);

    if (orderDate || orderNumber) {
      return {
        index,
        line,
        orderDate,
        orderDateText: orderDate ? line : null,
        orderNumber
      };
    }
  }

  return {
    index: -1,
    line: null,
    orderDate: null,
    orderDateText: null,
    orderNumber: null
  };
}

function extractStatus(lines, headerIndex, statusConfig) {
  const statusLineIndex = findStatusLineIndex(lines, headerIndex);
  if (statusLineIndex < 0) return extractConfiguredStatus(lines, statusConfig);

  const line = lines[statusLineIndex];
  const configured = resolveConfiguredStatus(line, statusConfig);

  return {
    status: configured?.status ?? line,
    line,
    lineIndex: statusLineIndex,
    amountSign: configured?.amountSign ?? 'unknown'
  };
}

function findStatusLineIndex(lines, headerIndex) {
  if (headerIndex < 0) return -1;

  for (let index = headerIndex + 1; index < Math.min(lines.length, headerIndex + 5); index += 1) {
    const line = lines[index];
    if (!line || parseFlexibleDate(line) || ORDER_NUMBER_PATTERN.test(line)) continue;
    if (MONEY_PATTERN.test(line) || /^\d+\s*개$/.test(line)) continue;
    return index;
  }

  return -1;
}

function extractConfiguredStatus(lines, statusConfig) {
  for (const [lineIndex, line] of lines.entries()) {
    if (/배송상품 주문상태 안내/.test(line)) break;

    const configured = resolveConfiguredStatus(line, statusConfig);
    if (!configured) continue;

    return {
      status: configured.status,
      line,
      lineIndex,
      amountSign: configured.amountSign
    };
  }

  return null;
}

function resolveConfiguredStatus(line, statusConfig) {
  const entries = [
    ...(statusConfig.positiveAmountStatuses ?? []).map(status => ({ status, amountSign: '+' })),
    ...(statusConfig.negativeAmountStatuses ?? []).map(status => ({ status, amountSign: '-' }))
  ];

  return entries.find(entry => normalizeLoose(line) === normalizeLoose(entry.status))
    ?? entries.find(entry => normalizeLoose(line).includes(normalizeLoose(entry.status)))
    ?? null;
}

function extractProductItems(lines, headerIndex, statusLineIndex) {
  const startIndex = Math.max(statusLineIndex + 1, headerIndex + 1, 0);
  const endIndex = findDetailItemSectionEnd(lines, startIndex);
  const section = lines.slice(startIndex, endIndex);
  const items = [];

  for (let index = 0; index < section.length; index += 1) {
    const amount = parseMoney(section[index]);
    if (amount === null) continue;

    const name = findPreviousProductName(section, index - 1);
    if (!name) continue;

    items.push({
      name,
      amount,
      amountText: extractMoneyText(section[index])
    });
  }

  return dedupeItems(items);
}

function findDetailItemSectionEnd(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (DETAIL_END_PATTERN.test(lines[index])) return index;
  }

  return lines.length;
}

function findPreviousProductName(lines, startIndex) {
  for (let index = startIndex; index >= Math.max(0, startIndex - 6); index -= 1) {
    const line = lines[index];
    if (isProductNameCandidate(line)) return line;
  }

  return null;
}

function isProductNameCandidate(line) {
  if (!line || line.length < 2 || line.length > 220) return false;
  return !PRODUCT_NOISE_PATTERNS.some(pattern => pattern.test(line));
}

function extractRecipientName(lines) {
  return extractLabeledValue(lines, [
    /^받는\s*사람(?!\s*정보)\s*[:：\t ]+(.+)$/,
    /^수령인\s*[:：\t ]+(.+)$/
  ], [
    /^받는\s*사람$/,
    /^수령인$/
  ]);
}

function extractRecipientAddress(lines) {
  return extractLabeledValue(lines, [
    /^받는\s*주소\s*[:：\t ]+(.+)$/,
    /^주소\s*[:：\t ]+(.+)$/
  ], [
    /^받는\s*주소$/,
    /^주소$/
  ]);
}

function extractLabeledValue(lines, inlinePatterns, nextLinePatterns) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    for (const pattern of inlinePatterns) {
      const match = line.match(pattern);
      if (match?.[1]) return cleanValue(match[1]);
    }

    if (nextLinePatterns.some(pattern => pattern.test(line))) {
      const nextValue = findNextPlainValue(lines, index + 1);
      if (nextValue) return nextValue;
    }
  }

  return null;
}

function findNextPlainValue(lines, startIndex) {
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 4); index += 1) {
    const value = lines[index];
    if (!value || /^(정보|연락처|전화|주소|받는\s*주소|받는\s*사람|수령인)$/.test(value)) continue;
    return value;
  }

  return null;
}

function extractOrderNumber(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const orderNumber = extractOrderNumberFromText(line);
    if (orderNumber) return orderNumber;

    if (/^주문\s*번호$/.test(line)) {
      const nextOrderNumber = String(lines[index + 1] ?? '').match(/[0-9][0-9-]{7,}/)?.[0];
      if (nextOrderNumber) return nextOrderNumber.replaceAll('-', '');
    }
  }

  return null;
}

function extractOrderNumberFromText(text) {
  return String(text ?? '').match(ORDER_NUMBER_PATTERN)?.[1]?.replaceAll('-', '') ?? null;
}

function extractTotalPaymentAmount(lines) {
  const labelPattern = /^(총\s*결제\s*금액|총\s*결제금액|최종\s*결제\s*금액|실\s*결제\s*금액)$/;

  for (let index = 0; index < lines.length; index += 1) {
    if (!labelPattern.test(lines[index])) continue;

    for (let offset = 0; offset <= 4; offset += 1) {
      const text = lines[index + offset];
      const amount = parseMoney(text);
      if (amount !== null) {
        return {
          amount,
          text: extractMoneyText(text)
        };
      }
    }
  }

  return null;
}

function parseMoney(text) {
  const moneyText = extractMoneyText(text);
  if (!moneyText) return null;

  const sign = moneyText.trim().startsWith('-') ? -1 : 1;
  const amount = Number(moneyText.replace(/[^\d]/g, ''));
  return Number.isFinite(amount) ? amount * sign : null;
}

function extractMoneyText(text) {
  return String(text ?? '').match(MONEY_PATTERN)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
}

function applyAmountSign(amount, amountSign) {
  if (amount === null) return null;
  if (amountSign === '-') return -Math.abs(amount);
  if (amountSign === '+') return Math.abs(amount);
  return amount;
}

function cleanValue(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\t+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeLoose(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase();
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = `${item.name}::${item.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}
