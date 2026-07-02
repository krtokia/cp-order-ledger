import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getTargetDateRange, parseFlexibleDate } from './date-utils.js';
import { sendFailureNotification } from './notifier.js';
import { openOrderDatabase } from './order-db.js';
import { parseOrderDetailPage } from './order-detail-parser.js';
import { toOrderRecord, upsertOrderRecord, validateOrderRecord } from './order-record-store.js';
import { extractOrderBlocks, extractOrderDateInfo } from './order-parser.js';
import { loadRuntimeConfig, parseCliArgs } from './runtime-config.js';

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

test('parseFlexibleDate handles common Coupang date shapes', () => {
  assert.equal(localDateKey(parseFlexibleDate('2026. 6. 30 주문')), '2026-06-30');
  assert.equal(localDateKey(parseFlexibleDate('2026년 6월 30일 주문')), '2026-06-30');
  assert.equal(localDateKey(parseFlexibleDate('2026-06-30 주문')), '2026-06-30');
  assert.equal(parseFlexibleDate('6/25(목) 도착'), null);
});

test('getTargetDateRange uses one month ago through now', () => {
  const { startDate, endDate } = getTargetDateRange(new Date(2026, 6, 1, 14, 30, 0));

  assert.equal(localDateKey(startDate), '2026-06-01');
  assert.equal(localDateKey(endDate), '2026-07-01');
});

test('extractOrderDateInfo finds date even when first line is not a date', () => {
  const info = extractOrderDateInfo(`
    주문목록
    최근 6개월
    2026
    2026. 6. 30 주문
    주문 상세보기
  `);

  assert.equal(info.line, '2026. 6. 30 주문');
  assert.equal(localDateKey(info.date), '2026-06-30');
});

test('extractOrderBlocks splits full page text by order date anchors', () => {
  const blocks = extractOrderBlocks(`
    주문목록
    최근 6개월
    2026
    2025
    2026. 6. 30 주문
    주문 상세보기
    배송완료
    WIHOLL 중년 여성 오버핏 티셔츠
    23,900 원
    2026. 6. 29 주문
    주문 상세보기
    배송완료
    휴엔팜 혼합 샐러드
    13,700 원
    이전
    다음
    배송상품 주문상태 안내
  `);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].rawDateText, '2026. 6. 30 주문');
  assert.equal(blocks[1].rawDateText, '2026. 6. 29 주문');
  assert.match(blocks[0].text, /WIHOLL/);
  assert.match(blocks[1].text, /휴엔팜/);
});

test('parseOrderDetailPage extracts the first debug detail payload', () => {
  const result = parseOrderDetailPage(`
    주문상세
    주문번호
    12345678901234
    주문일자
    2026. 6. 30 주문
    배송완료
    오늘(수) 도착
    WIHOLL 중년 여성 오버핏 티셔츠 여름 루즈핏 배트윙 소매 무지 반팔티, 커피, FREE
    23,900 원
    1개
    받는 사람 정보
    받는 사람
    홍*동
    연락처
    010-****-1234
    주소
    서울특별시 강남구 테헤란로 **길 **, ***호
    결제 정보
    총 결제 금액
    23,900 원
  `);

  assert.equal(result.orderNumber, '12345678901234');
  assert.equal(result.orderDate, '2026-06-30');
  assert.deepEqual(result.deliveryStatus, {
    raw: '배송완료',
    line: '배송완료',
    amountSign: '+'
  });
  assert.deepEqual(result.productNames, [
    'WIHOLL 중년 여성 오버핏 티셔츠 여름 루즈핏 배트윙 소매 무지 반팔티, 커피, FREE'
  ]);
  assert.deepEqual(result.productItems, [
    {
      name: 'WIHOLL 중년 여성 오버핏 티셔츠 여름 루즈핏 배트윙 소매 무지 반팔티, 커피, FREE',
      amount: 23900,
      amountText: '23,900 원'
    }
  ]);
  assert.deepEqual(result.recipient, {
    name: '홍*동',
    address: '서울특별시 강남구 테헤란로 **길 **, ***호'
  });
  assert.equal(result.totalPaymentAmount, 23900);
  assert.equal(result.signedTotalPaymentAmount, 23900);
  assert.deepEqual(result.parserWarnings, []);
});

test('parseOrderDetailPage applies negative sign for cancel/refund statuses', () => {
  const result = parseOrderDetailPage(`
    주문번호 99999999999999
    주문 날짜 2026-06-20
    주문취소
    테스트 상품명
    10,000 원
    총 결제 금액
    10,000 원
  `);

  assert.equal(result.deliveryStatus.amountSign, '-');
  assert.equal(result.signedTotalPaymentAmount, -10000);
});

test('parseOrderDetailPage does not mistake 배송지 정보 heading for address', () => {
  const result = parseOrderDetailPage(`
    주문번호 88888888888888
    주문일자 2026. 6. 21
    배송완료
    테스트 상품
    5,000 원
    배송지 정보
    수령인
    김*진
    연락처
    010-****-5678
    주소
    경기도 성남시 분당구 판교역로 **, ***동 ***호
    결제 정보
    총 결제 금액
    5,000 원
  `);

  assert.equal(result.recipient.address, '경기도 성남시 분당구 판교역로 **, ***동 ***호');
});

test('parseOrderDetailPage follows current Coupang detail text schema', () => {
  const result = parseOrderDetailPage(`
    주문상세
    2026. 6. 30 주문주문번호 20101310316083
    배송완료
    오늘(수) 도착 (문앞 전달)
    WIHOLL 중년 여성 오버핏 티셔츠 여름 루즈핏 배트윙 소매 무지 반팔티, 커피, FREE
    23,900 원
    1개
    장바구니 담기
    배송 조회
    교환, 반품 신청
    리뷰 작성하기
    받는사람 정보
    받는사람 조*연
    연락처 010****0079
    받는주소 (10936) 경기도 파주시 조리읍 능안로 ** ***동 ***호 ( 한라아파트 )
    배송요청사항
    문 앞
    결제 정보
    총 상품가격
    25,160 원
    할인금액
    -1,260 원
    배송비
    0 원
    총 결제금액
    23,900 원
  `);

  assert.equal(result.orderNumber, '20101310316083');
  assert.equal(result.orderDate, '2026-06-30');
  assert.equal(result.deliveryStatus.raw, '배송완료');
  assert.deepEqual(result.productItems, [
    {
      name: 'WIHOLL 중년 여성 오버핏 티셔츠 여름 루즈핏 배트윙 소매 무지 반팔티, 커피, FREE',
      amount: 23900,
      amountText: '23,900 원'
    }
  ]);
  assert.deepEqual(result.recipient, {
    name: '조*연',
    address: '(10936) 경기도 파주시 조리읍 능안로 ** ***동 ***호 ( 한라아파트 )'
  });
  assert.equal(result.totalPaymentAmount, 23900);
  assert.deepEqual(result.parserWarnings, []);
});

test('toOrderRecord keeps only DB-ready order fields', () => {
  const detail = parseOrderDetailPage(`
    주문상세
    2026. 6. 30 주문주문번호 20101310316083
    배송완료
    오늘(수) 도착 (문앞 전달)
    WIHOLL 중년 여성 오버핏 티셔츠 여름 루즈핏 배트윙 소매 무지 반팔티, 커피, FREE
    23,900 원
    1개
    받는사람 정보
    받는사람 조*연
    받는주소 (10936) 경기도 파주시 조리읍 능안로 ** ***동 ***호 ( 한라아파트 )
    결제 정보
    총 결제금액
    23,900 원
  `);

  assert.deepEqual(toOrderRecord(detail), {
    orderNumber: '20101310316083',
    orderDate: '2026-06-30',
    orderStatus: '배송완료',
    productName: 'WIHOLL 중년 여성 오버핏 티셔츠 여름 루즈핏 배트윙 소매 무지 반팔티, 커피, FREE',
    amount: 23900,
    recipientName: '조*연',
    recipientAddress: '(10936) 경기도 파주시 조리읍 능안로 ** ***동 ***호 ( 한라아파트 )'
  });
});

test('upsertOrderRecord writes JSON by orderNumber primary key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coupang-orders-'));
  const filePath = join(dir, 'orders.json');

  upsertOrderRecord(filePath, {
    orderNumber: '1',
    orderDate: '2026-06-01',
    orderStatus: '배송완료',
    productName: 'old',
    amount: 1000,
    recipientName: '김*진',
    recipientAddress: '서울'
  });
  const result = upsertOrderRecord(filePath, {
    orderNumber: '1',
    orderDate: '2026-06-02',
    orderStatus: '주문취소',
    productName: 'new',
    amount: -1000,
    recipientName: '김*진',
    recipientAddress: '서울'
  });

  const saved = JSON.parse(readFileSync(filePath, 'utf8'));

  assert.equal(result.totalRecords, 1);
  assert.deepEqual(saved, [
    {
      orderNumber: '1',
      orderDate: '2026-06-02',
      orderStatus: '주문취소',
      productName: 'new',
      amount: -1000,
      recipientName: '김*진',
      recipientAddress: '서울'
    }
  ]);
});

test('parseCliArgs supports debug and date range options', () => {
  assert.deepEqual(parseCliArgs([
    '--debug',
    '--login',
    '--notify',
    '--notify-provider=pushover',
    '--notify-priority=urgent',
    '--db',
    '--db-path',
    './tmp/orders.sqlite',
    '--days-ago=7',
    '--to-date',
    '2026-07-01',
    '--max-pages=3'
  ]), {
    debug: true,
    loginOnly: true,
    notify: true,
    notifyProvider: 'pushover',
    notifyPriority: 'urgent',
    databaseEnabled: true,
    databasePath: './tmp/orders.sqlite',
    daysAgo: 7,
    toDate: '2026-07-01',
    maxPages: 3
  });
});

test('loadRuntimeConfig prefers CLI cutoff over config daysAgo', () => {
  const config = loadRuntimeConfig({
    argv: ['--cutoff-date=2026-06-24'],
    configPath: './not-found-config.json',
    now: new Date(2026, 6, 1, 14, 30, 0)
  });

  assert.equal(localDateKey(config.startDate), '2026-06-24');
  assert.equal(localDateKey(config.endDate), '2026-07-01');
  assert.equal(config.dateRangeSource, 'cli:cutoffDate');
});

test('loadRuntimeConfig uses CLI daysAgo when provided', () => {
  const config = loadRuntimeConfig({
    argv: ['--days-ago', '3'],
    configPath: './not-found-config.json',
    now: new Date(2026, 6, 1, 14, 30, 0)
  });

  assert.equal(localDateKey(config.startDate), '2026-06-28');
  assert.equal(config.dateRangeSource, 'cli:daysAgo');
});

test('loadRuntimeConfig exposes maxPages from CLI', () => {
  const config = loadRuntimeConfig({
    argv: ['--max-pages', '5'],
    configPath: './not-found-config.json',
    now: new Date(2026, 6, 1, 14, 30, 0)
  });

  assert.equal(config.maxPages, 5);
});

test('loadRuntimeConfig exposes database settings from CLI', () => {
  const config = loadRuntimeConfig({
    argv: ['--db', '--db-path', './data/custom.sqlite'],
    configPath: './not-found-config.json',
    now: new Date(2026, 6, 1, 14, 30, 0)
  });

  assert.equal(config.database.enabled, true);
  assert.equal(config.database.type, 'sqlite');
  assert.equal(config.database.path, './data/custom.sqlite');
});

test('loadRuntimeConfig exposes notification settings from CLI', () => {
  const config = loadRuntimeConfig({
    argv: ['--notify', '--notify-provider', 'pushover', '--notify-priority', 'low'],
    configPath: './not-found-config.json',
    now: new Date(2026, 6, 1, 14, 30, 0)
  });

  assert.equal(config.notifications.enabled, true);
  assert.equal(config.notifications.provider, 'pushover');
  assert.equal(config.notifications.priority, 'low');
});

test('loadRuntimeConfig exposes login-only mode from CLI', () => {
  const config = loadRuntimeConfig({
    argv: ['--login'],
    configPath: './not-found-config.json',
    now: new Date(2026, 6, 1, 14, 30, 0)
  });

  assert.equal(config.loginOnly, true);
});

test('validateOrderRecord catches empty DB fields', () => {
  const result = validateOrderRecord({
    orderNumber: '1',
    orderDate: null,
    orderStatus: '배송완료',
    productName: '',
    amount: null,
    recipientName: '김*진',
    recipientAddress: '서울'
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.missingFields, ['orderDate', 'productName', 'amount']);
});

test('sendFailureNotification sends ntfy POST', async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true };
  };

  try {
    const result = await sendFailureNotification({
      enabled: true,
      provider: 'ntfy',
      ntfy: {
        serverUrl: 'https://ntfy.example.com',
        topic: 'my-topic',
        token: 'secret'
      }
    }, {
      title: '중단',
      message: '필드 누락',
      context: 'orderNumber=1'
    });

    assert.deepEqual(result, { sent: true, provider: 'ntfy' });
    const requestUrl = new URL(captured.url);
    assert.equal(`${requestUrl.origin}${requestUrl.pathname}`, 'https://ntfy.example.com/my-topic');
    assert.equal(requestUrl.searchParams.get('title'), '중단');
    assert.equal(requestUrl.searchParams.get('priority'), 'high');
    assert.equal(requestUrl.searchParams.get('tags'), 'warning');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers.Title, undefined);
    assert.equal(captured.options.headers.Authorization, 'Bearer secret');
    assert.match(captured.options.body, /필드 누락/);
    assert.match(captured.options.body, /orderNumber=1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendFailureNotification maps Pushover priority', async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true };
  };

  try {
    const result = await sendFailureNotification({
      enabled: true,
      provider: 'pushover',
      priority: 'low',
      pushover: {
        apiUrl: 'https://api.pushover.example.com/1/messages.json',
        token: 'app-token',
        user: 'user-key'
      }
    }, {
      title: '중단',
      message: '필드 누락'
    });

    assert.deepEqual(result, { sent: true, provider: 'pushover' });
    assert.equal(captured.url, 'https://api.pushover.example.com/1/messages.json');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.body.get('token'), 'app-token');
    assert.equal(captured.options.body.get('user'), 'user-key');
    assert.equal(captured.options.body.get('priority'), '-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendFailureNotification skips disabled notifications', async () => {
  const result = await sendFailureNotification({ enabled: false }, {
    message: '중단'
  });

  assert.deepEqual(result, { sent: false, reason: 'disabled' });
});

test('openOrderDatabase upserts SQLite orders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coupang-orders-db-'));
  const dbPath = join(dir, 'orders.sqlite');
  const orderDb = await openOrderDatabase({
    enabled: true,
    type: 'sqlite',
    path: dbPath
  });

  try {
    orderDb.upsertOrder({
      orderNumber: '20101310316083',
      orderDate: '2026-06-30',
      orderStatus: '배송완료',
      productName: '테스트 상품',
      amount: 23900,
      recipientName: '조*연',
      recipientAddress: '경기도'
    });
  } finally {
    orderDb.close();
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT order_number, order_date, amount FROM orders WHERE order_number = ?').get('20101310316083');

    assert.deepEqual({ ...row }, {
      order_number: '20101310316083',
      order_date: '2026-06-30',
      amount: 23900
    });
  } finally {
    db.close();
  }
});
