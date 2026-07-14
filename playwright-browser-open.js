import { chromium } from 'playwright';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

const DEFAULT_URL = 'https://www.coupang.com';
const USER_DATA_DIR = './.local-browser-test';
const TARGET_URL = process.argv[2] ?? DEFAULT_URL;
const BROWSER_WINDOW = {
  width: 1280,
  height: 900,
  x: 80,
  y: 80
};

async function waitForEnter(message) {
  if (!input.isTTY) {
    console.log('터미널 입력을 받을 수 없어 브라우저를 계속 열어둡니다. 종료하려면 Ctrl+C를 누르세요.');
    await new Promise(() => {});
  }

  const readline = createInterface({ input, output });
  try {
    await readline.question(`${message}\n`);
  } finally {
    readline.close();
  }
}

async function bringPageToFront(page) {
  await page.bringToFront().catch(() => {});
  await page.evaluate(({ width, height, x, y }) => {
    window.moveTo(x, y);
    window.resizeTo(width, height);
    window.focus();
  }, BROWSER_WINDOW).catch(() => {});
}

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  viewport: { width: 1280, height: 800 },
  ignoreDefaultArgs: ['--enable-automation'],
  extraHTTPHeaders: {
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  },
  args: [
    '--lang=ko-KR',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-sandbox',
    '--start-normal',
    `--window-size=${BROWSER_WINDOW.width},${BROWSER_WINDOW.height}`,
    `--window-position=${BROWSER_WINDOW.x},${BROWSER_WINDOW.y}`
  ]
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  await bringPageToFront(page);

  const browserInfo = await page.evaluate(() => ({
    language: navigator.language,
    languages: navigator.languages,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: navigator.userAgent
  }));

  console.log('브라우저 설정 확인:');
  console.log(JSON.stringify(browserInfo, null, 2));
  console.log(`열 URL: ${TARGET_URL}`);

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await bringPageToFront(page);

  await waitForEnter('브라우저를 닫으려면 이 터미널에서 Enter를 누르세요.');
} finally {
  await context.close();
}
