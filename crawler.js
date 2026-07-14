import { chromium } from 'playwright';
import { appendFileSync, rmSync } from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { installConsoleFileLogger } from './src/logger.js';
import { sendFailureNotification } from './src/notifier.js';
import { openOrderDatabase } from './src/order-db.js';
import { parseOrderDetailPage } from './src/order-detail-parser.js';
import { toOrderRecord, upsertOrderRecord, validateOrderRecord } from './src/order-record-store.js';
import { extractOrderBlocks, extractOrderDateInfo } from './src/order-parser.js';
import { loadRuntimeConfig } from './src/runtime-config.js';

const LOG_FILE = './logs/crawler.log';
const ORDERS_JSON_FILE = './data/orders.json';
const USER_DATA_DIR = './.local-session';
const COUPANG_HOME_URL = 'https://www.coupang.com';
const ORDER_LIST_URL = 'https://mc.coupang.com/ssr/desktop/order/list';
const BROWSER_LOCALE = 'ko-KR';
const BROWSER_TIMEZONE = 'Asia/Seoul';
const ACCEPT_LANGUAGE = 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7';
const BROWSER_WINDOW = {
  width: 1280,
  height: 900,
  x: 80,
  y: 80
};

class CrawlAbortError extends Error {
  constructor(message, context = '') {
    super(message);
    this.name = 'CrawlAbortError';
    this.context = context;
  }
}

function debugLog(runtimeConfig, ...args) {
  if (runtimeConfig.debug) console.log(...args);
}

function writeDetailRawLogOnce(detailText, runtimeConfig, debugState, context) {
  if (debugState.detailTextWritten) return;

  const header = [
    `===== ${new Date().toLocaleString()} 주문 상세 원문 =====`,
    `page=${context.currentPage}`,
    `orderBlockIndex=${context.orderBlock.index}`,
    `listDateAnchor=${context.orderBlock.rawDateText ?? ''}`,
    ''
  ].join('\n');

  appendFileSync(runtimeConfig.debugDetailLogFile, `${header}${detailText}\n\n`);
  debugState.detailTextWritten = true;
  console.log(`🧪 주문 상세 원문 저장: ${runtimeConfig.debugDetailLogFile}`);
}

function abortCrawl(message, context) {
  throw new CrawlAbortError(message, context);
}

function resetLoginSession() {
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
  console.log(`🧹 기존 로그인 세션 초기화: ${USER_DATA_DIR}`);
}

async function debugOrderDetail(page, currentPage, orderBlock, runtimeConfig, debugState, orderDb) {
  const listUrl = page.url();
  const detailButtons = await page.$$('text="주문 상세보기"');
  const detailButton = detailButtons[orderBlock.index - 1];

  if (!detailButton) {
    abortCrawl(
      `주문 블록 ${orderBlock.index}에 대응하는 상세보기 버튼을 찾지 못했습니다.`,
      `page=${currentPage}, orderBlockIndex=${orderBlock.index}, listDateAnchor=${orderBlock.rawDateText ?? ''}`
    );
  }

  debugLog(runtimeConfig, `\n🧪 [상세 디버그] 페이지 ${currentPage} / 주문 블록 ${orderBlock.index} 상세 진입`);

  const popupPromise = page.context().waitForEvent('page', { timeout: 1500 }).catch(() => null);
  await detailButton.scrollIntoViewIfNeeded().catch(() => {});
  await detailButton.click({ timeout: 10000 });

  const popup = await popupPromise;
  const detailPage = popup ?? page;
  await waitForPageSettled(detailPage);

  const detailText = await detailPage.locator('body').innerText();
  writeDetailRawLogOnce(detailText, runtimeConfig, debugState, { currentPage, orderBlock });

  const parsed = parseOrderDetailPage(detailText);
  const orderRecord = toOrderRecord(parsed);

  debugLog(runtimeConfig, '----- 주문 상세 페이지 파싱 결과 -----');
  debugLog(runtimeConfig, JSON.stringify({
    listContext: {
      page: currentPage,
      orderBlockIndex: orderBlock.index,
      listDateAnchor: orderBlock.rawDateText
    },
    detail: parsed
  }, null, 2));

  if (orderRecord.orderNumber) {
    const validation = validateOrderRecord(orderRecord);
    if (!validation.valid) {
      abortCrawl(
        `저장용 주문 JSON 필드가 비어 있습니다: ${validation.missingFields.join(', ')}`,
        JSON.stringify({ orderRecord, parserWarnings: parsed.parserWarnings }, null, 2)
      );
    }

    const saveResult = upsertOrderRecord(ORDERS_JSON_FILE, orderRecord);
    orderDb?.upsertOrder(orderRecord);
    debugLog(runtimeConfig, '----- 저장용 주문 JSON 레코드 -----');
    debugLog(runtimeConfig, JSON.stringify(orderRecord, null, 2));
    console.log(`💾 저장 완료: ${orderRecord.orderNumber} / JSON 총 ${saveResult.totalRecords}건${orderDb ? ' / DB upsert' : ''}`);
  } else {
    abortCrawl(
      '주문번호가 없어 JSON 저장을 진행할 수 없습니다.',
      JSON.stringify({ orderRecord, parserWarnings: parsed.parserWarnings }, null, 2)
    );
  }

  debugLog(runtimeConfig, '----------------------------------');

  if (popup) {
    await popup.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  } else {
    await returnToOrderList(page, listUrl);
  }
}

async function waitForPageSettled(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function returnToOrderList(page, listUrl) {
  const beforeUrl = page.url();
  const hasListButton = await page.$('text="주문 상세보기"');

  if (beforeUrl !== listUrl || !hasListButton) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(async error => {
      console.warn(`⚠️ 뒤로가기로 목록 복귀 실패: ${error.message}`);
      await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
    });
  }

  await waitForPageSettled(page);

  const restoredListButton = await page.$('text="주문 상세보기"');
  if (!restoredListButton) {
    console.warn('⚠️ 목록 복귀 후 주문 상세보기 버튼이 보이지 않아 목록 URL로 재진입합니다.');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
    await waitForPageSettled(page);
  }
}

async function launchCrawlerContext({ headless = false } = {}) {
  const browserArgs = [
    `--lang=${BROWSER_LOCALE}`,
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-infobars'
  ];

  if (!headless) {
    browserArgs.push(
      '--start-normal',
      `--window-size=${BROWSER_WINDOW.width},${BROWSER_WINDOW.height}`,
      `--window-position=${BROWSER_WINDOW.x},${BROWSER_WINDOW.y}`
    );
  }

  // 💡 아카마이(Akamai) 봇 탐지 우회 및 로컬 GUI 구동 셋업
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--enable-automation'],
    extraHTTPHeaders: {
      'Accept-Language': ACCEPT_LANGUAGE
    },
    args: browserArgs
  });
}

async function bringPageToFront(page) {
  await page.bringToFront().catch(() => {});
  await page.evaluate(({ width, height, x, y }) => {
    window.moveTo(x, y);
    window.resizeTo(width, height);
    window.focus();
  }, BROWSER_WINDOW).catch(() => {});
}

async function runLoginOnly(context) {
  const page = context.pages()[0] ?? await context.newPage();
  await bringPageToFront(page);
  console.log('🔐 로그인 전용 모드: 쿠팡 홈을 엽니다.');
  await page.goto(COUPANG_HOME_URL, { waitUntil: 'domcontentloaded' });
  await bringPageToFront(page);
  await waitForPageSettled(page);
  await bringPageToFront(page);
  console.log('브라우저에서 쿠팡 로그인을 완료하세요. 필요하면 구매내역까지 이동해 로그인 상태를 확인하세요.');
  await waitForEnter('로그인이 끝났으면 이 터미널에서 Enter를 누르세요. 세션을 저장하고 종료합니다.');
  console.log('✅ 로그인 세션 확인 완료. .local-session에 저장됩니다.');
}

async function waitForEnter(message) {
  if (!input.isTTY) {
    throw new Error('--login은 터미널 입력이 필요합니다. SSH/터미널에서 직접 실행하세요.');
  }

  const readline = createInterface({ input, output });
  try {
    await readline.question(`${message}\n`);
  } finally {
    readline.close();
  }
}

async function main() {
  const uninstallLogger = installConsoleFileLogger(LOG_FILE);
  const runtimeConfig = loadRuntimeConfig();
  const { startDate, endDate } = runtimeConfig;
  const debugState = { detailTextWritten: false };
  let orderDb = null;
  let context = null;
  const runMode = runtimeConfig.loginOnly ? '로그인 세션 준비' : '크롤링';
  const browserHeadless = runtimeConfig.loginOnly ? false : runtimeConfig.headless;
  try {
    console.log(`\n\n===== ${new Date().toLocaleString()} ${runMode} 시작 =====`);
    if (runtimeConfig.loginOnly && runtimeConfig.headless) {
      console.warn('⚠️ 로그인 전용 모드는 브라우저 창이 필요해 headed 모드로 실행합니다.');
    }
    console.log(`🧭 브라우저 모드: ${browserHeadless ? 'headless' : 'headed'}`);
    if (!runtimeConfig.loginOnly) {
      console.log(`🎯 크롤링 타겟 기간: ${startDate.toLocaleDateString()} ~ ${endDate.toLocaleDateString()}`);
    }
    debugLog(runtimeConfig, `📝 로그 파일: ${LOG_FILE}`);
    debugLog(runtimeConfig, `🧪 디버그 모드: ${runtimeConfig.debugDetailLogFile}`);
    debugLog(runtimeConfig, `📅 날짜 설정 출처: ${runtimeConfig.dateRangeSource}`);
    debugLog(runtimeConfig, `🛑 최대 페이지 안전장치: ${runtimeConfig.maxPages}페이지`);

    if (runtimeConfig.loginOnly) {
      resetLoginSession();
      context = await launchCrawlerContext({ headless: browserHeadless });
      await runLoginOnly(context);
      return;
    }

    orderDb = await openOrderDatabase(runtimeConfig.database);
    if (orderDb) console.log(`🗄️ DB 연결 완료: ${orderDb.path}`);

    context = await launchCrawlerContext({ headless: browserHeadless });

    const page = await context.newPage();
    if (!browserHeadless) await bringPageToFront(page);
    debugLog(runtimeConfig, '📦 쿠팡 구매내역 진입 중 (봇 탐지 우회 적용)...');
    await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded' });

    let currentPage = 1;
    let keepCrawling = true;

    // 🔄 페이지 순회 루프
    while (keepCrawling) {
      if (currentPage > runtimeConfig.maxPages) {
        abortCrawl(
          `${runtimeConfig.maxPages}페이지를 초과하려고 해서 이상동작으로 판단하고 중지합니다.`,
          `currentPage=${currentPage}, maxPages=${runtimeConfig.maxPages}`
        );
      }

      await page.waitForTimeout(3000); // 비동기 렌더링 넉넉히 대기
      console.log(`\n🔍 [페이지 ${currentPage}] 데이터 스캔 시작...`);

      const detailBtns = await page.$$('text="주문 상세보기"');
      const pageText = await page.locator('body').innerText();
      const orderBlocks = extractOrderBlocks(pageText);

      if (detailBtns.length === 0 && orderBlocks.length === 0) {
        abortCrawl(
          '주문 상세보기 버튼과 주문 블록이 모두 없습니다. 로그인이 풀렸거나 페이지 구조가 바뀐 것으로 판단합니다.',
          page.url()
        );
      }

      debugLog(runtimeConfig, `📌 주문 상세보기 버튼 ${detailBtns.length}개 / 주문 블록 ${orderBlocks.length}개 감지`);

      if (orderBlocks.length === 0) {
        abortCrawl(
          '주문일 기준으로 블록을 나누지 못했습니다.',
          pageText.slice(0, 3000)
        );
      }

      for (const orderBlock of orderBlocks) {
        const cardText = orderBlock.text;
        const dateInfo = orderBlock.orderDate
          ? { date: orderBlock.orderDate, line: orderBlock.rawDateText }
          : extractOrderDateInfo(cardText);
        const orderDate = dateInfo?.date ?? null;
        const rawDateText = dateInfo?.line ?? null;

        console.log(`\n========== 페이지 ${currentPage} / 주문 블록 ${orderBlock.index} ==========`);
        if (rawDateText) console.log(`🗓️ 날짜 앵커: ${rawDateText}`);
        console.log(cardText);
        console.log('==============================================');

        if (!orderDate) {
          abortCrawl(
            '주문일을 파싱하지 못했습니다.',
            cardText
          );
        }

        console.log(`➡️ 발견된 주문일: ${orderDate.toLocaleDateString()}`);

        if (orderDate > endDate) {
          console.log('⏭️ 타겟 종료일 이후 주문이라 건너뜁니다.');
          continue;
        }

        // 💡 범위 이탈 감지 시 즉시 크롤링 컷!
        if (orderDate < startDate) {
          console.log(`\n🚫 [탐색 중지] 타겟 범위(${startDate.toLocaleDateString()}) 이전 데이터 발견. 크롤링 종료.`);
          keepCrawling = false;
          break;
        }

        await debugOrderDetail(page, currentPage, orderBlock, runtimeConfig, debugState, orderDb);
        
        // ==========================================
        // TODO: 나중에 여기에 텍스트 파싱 및 DB Upsert (dataset.set) 로직 추가
        // ==========================================
      }

      if (!keepCrawling) break;

      // 🚀 다음 페이지 이동
      try {
        const nextButton = await page.$('.btn-next, a.next, button:has-text("다음")');
        if (nextButton) {
          const isDisabled = await nextButton.evaluate(el => el.disabled || el.classList.contains('disabled'));
          if (isDisabled) {
            console.log('✅ 마지막 페이지 도달.');
            keepCrawling = false;
          } else {
            currentPage++;
            console.log(`➡️ 다음 페이지(${currentPage}) 이동...`);
            await nextButton.click();
          }
        } else {
          keepCrawling = false;
        }
      } catch (e) {
        console.warn(`⚠️ 다음 페이지 이동 실패: ${e.message}`);
        keepCrawling = false;
      }
    }
  } catch (error) {
    console.error(error);
    await notifyFailure(runtimeConfig, error);
    process.exitCode = 1;
  } finally {
    if (context) {
      await context.close().catch(error => {
        console.warn(`⚠️ 브라우저 종료 실패: ${error.message}`);
      });
    }
    orderDb?.close();
    console.log(`\n🏁 ${runMode} 안전하게 종료됨.`);
    console.log(`===== ${new Date().toLocaleString()} ${runMode} 종료 =====`);
    uninstallLogger();
  }
}

async function notifyFailure(runtimeConfig, error) {
  try {
    const result = await sendFailureNotification(runtimeConfig.notifications, {
      title: '쿠팡 크롤러 비정상 중단',
      message: error.message,
      context: error.context ?? error.stack
    });

    if (result.sent) {
      console.log(`📣 알림 전송 완료: ${result.provider}`);
    }
  } catch (notificationError) {
    console.warn(`⚠️ 알림 전송 실패: ${notificationError.message}`);
  }
}

main();
