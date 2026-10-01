import { chromium } from 'playwright';

const USER_DATA_DIR = './.local-session';
const ORDER_LIST_URL = 'https://mc.coupang.com/ssr/desktop/order/list';

const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  viewport: { width: 1280, height: 800 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--lang=ko-KR', '--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-infobars'],
});

const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const out = {};
  out.url = location.href;
  out.title = document.title;
  // 로그인 여부 힌트
  out.hasDetailBtn = [...document.querySelectorAll('*')].some(e => (e.textContent || '').trim() === '주문 상세보기');

  // "다음" 텍스트를 가진 a/button
  out.nextTextEls = [...document.querySelectorAll('a,button')]
    .filter(e => (e.textContent || '').includes('다음'))
    .map(e => ({ tag: e.tagName, cls: e.className, aria: e.getAttribute('aria-label'), disabled: e.disabled || e.classList.contains('disabled'), href: e.getAttribute('href'), html: e.outerHTML.slice(0, 160) }));

  // 기존 셀렉터 매칭 결과
  out.oldSelectorMatch = [...document.querySelectorAll('.btn-next, a.next, .next')]
    .map(e => ({ cls: e.className, tag: e.tagName, html: e.outerHTML.slice(0, 160) }));

  // 페이지네이션스러운 컨테이너
  out.paginationLike = [...document.querySelectorAll('[class*="pag" i],[class*="Pag" i],[aria-label*="페이지" i],nav')]
    .slice(0, 6)
    .map(e => ({ cls: e.className, aria: e.getAttribute('aria-label'), html: e.outerHTML.slice(0, 500) }));

  // page 파라미터 힌트가 있는 링크
  out.pageParamLinks = [...document.querySelectorAll('a[href]')]
    .map(e => e.getAttribute('href'))
    .filter(h => h && /page|pageIndex|currentPage|listSize|offset/i.test(h))
    .slice(0, 15);

  // 숫자 페이지 버튼 후보
  out.numberedBtns = [...document.querySelectorAll('a,button')]
    .filter(e => /^\d{1,3}$/.test((e.textContent || '').trim()))
    .slice(0, 15)
    .map(e => ({ tag: e.tagName, text: e.textContent.trim(), cls: e.className, href: e.getAttribute('href'), html: e.outerHTML.slice(0, 120) }));

  return out;
});

console.log(JSON.stringify(info, null, 2));
await ctx.close();
