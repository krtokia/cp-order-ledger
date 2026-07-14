# 프로젝트 상세 문서

이 문서는 Order Ledger의 구현 의도, 운영 규칙, 파싱 기준, 저장 구조를 기록하는 상세 문서입니다. GitHub 첫 화면용 요약은 루트의 `README.md`를 보고, 코드 수정이나 장애 대응처럼 맥락이 필요한 작업은 이 문서를 기준으로 합니다.

# 프로젝트 목적
Playwright를 사용하여 쿠팡(Coupang) 마이페이지의 `구매내역`을 주기적으로 크롤링하고, 정산에 필요한 주문 데이터를 로컬 JSON/SQLite/GUI로 관리합니다.

최종 목표는 월별 주문 정산을 빠르게 확인하는 개인용 주문 장부입니다. 주문번호를 기준으로 upsert하기 때문에 같은 주문이 배송완료에서 취소/반품 등으로 바뀌어도 다음 크롤링에서 갱신됩니다.

# 기술 스택 및 구동 환경
- 환경: WSL2 (Ubuntu), Node.js v24, pnpm
- 라이브러리: Playwright 내장 Chromium
- 실행 방식: 기본은 headed(`headless: false`)이며, 실행 인자 `--headless`/`--headed`로 브라우저 표시 여부를 선택한다.
- 세션 유지: `.local-session` 폴더의 persistent context 사용
  - 로그인 자동화 코드는 없다. `pnpm run crawl -- --login`은 기존 `.local-session`을 삭제한 뒤 headed 브라우저를 열고, 사람이 직접 쿠팡에 로그인해 새 세션을 적재한다. 이후 실행은 이 세션을 재사용한다. 세션 만료 시 목록 파싱이 비어 `abortCrawl`로 중단되며, 재로그인으로 복구한다. (사용자 절차는 README 참고)
- 로그: 화면 출력과 동시에 `logs/crawler.log`에 append 저장
- 로그 rotate: 실행 시작 시 `logs/crawler.log`가 5MB 이상이면 `logs/crawler.log.1`로 회전, 최대 5개 보관
- 주문 상세 원문은 실행당 1회만 `debug.YYYY-MM-DD.log`에 append 저장

# 반드시 유지할 제약
1. **Akamai 봇 탐지(WAF) 존재**
   - `ignoreDefaultArgs: ['--enable-automation']`
   - `--disable-blink-features=AutomationControlled`
   - 위 stealth 계열 옵션은 유지한다.

2. **DOM 난독화 우회(Text Anchoring)**
   - 쿠팡 CSS 클래스명은 신뢰하지 않는다.
   - `주문 상세보기`, `주문번호`, `받는 사람 정보`, `총 결제 금액` 같은 안정적인 텍스트를 앵커로 삼는다.
   - 현재 목록 파싱은 `body.innerText()`를 주문일 라인 기준으로 쪼개는 방식이다.

3. **효율적인 크롤링(기간 컷오프)**
   - 기본 타겟 기간은 `config/crawl-config.json`의 `dateRange.daysAgo` 기준이다.
   - `dateRange.cutoffDate`가 있으면 해당 날짜부터 현재까지를 대상으로 한다.
   - 실행 인자 `--cutoff-date` 또는 `--days-ago`가 config보다 우선한다.
   - 목록이 최신순이라는 전제하에 타겟 시작일보다 오래된 주문을 만나면 탐색을 중단한다.

# 전체 실행 흐름
1. `crawler.js`가 런타임 config와 CLI 인자를 읽는다.
2. `logs/crawler.log` 파일 로거를 설치해 콘솔 출력과 파일 로그를 동시에 남긴다.
   - 로거 설치 시점에 파일 크기를 확인하고 필요하면 rotate한다.
3. `.local-session` persistent context로 쿠팡 구매내역 페이지에 접속한다.
4. 목록 페이지의 `body.innerText()`를 가져와 날짜 앵커 기준으로 주문 블록을 만든다.
5. 타겟 기간에 들어온 주문 블록만 상세 페이지에 진입한다.
6. 상세 페이지 원문 전체를 실행당 1회 `debug.YYYY-MM-DD.log`에 먼저 저장한다.
7. 상세 페이지 텍스트를 파싱해 저장용 주문 레코드로 변환한다.
8. 필수 필드 검증 후 `data/orders.json`과 SQLite DB에 upsert한다.
9. 페이지 내 타겟 주문 처리가 끝나면 다음 페이지로 이동한다.
10. 타겟 시작일보다 오래된 주문을 만나거나 마지막 페이지/안전장치 조건에 걸리면 종료한다.

# 데이터 흐름
목록 페이지는 주문일과 상세 버튼 위치를 찾기 위한 인덱스 역할만 한다. 실제 저장 데이터는 상세 페이지를 기준으로 만든다.

```text
Coupang list page
  -> extractOrderBlocks()
  -> order block + detail button index
  -> Coupang detail page
  -> parseOrderDetailPage()
  -> toOrderRecord()
  -> validateOrderRecord()
  -> data/orders.json upsert
  -> data/orders.sqlite upsert
```

목록 카드의 상품명/금액은 사람이 확인하기 위한 로그로 남기지만, 저장 기준은 상세 페이지 원문이다.

# 현재 구현 상태

## 1차: 구매내역 목록 스캔
- `crawler.js`가 쿠팡 구매내역 목록에 진입한다.
- 페이지 전체 텍스트를 `src/order-parser.js`에서 `YYYY. M. D 주문` 라인 기준으로 주문 블록으로 분리한다.
- 각 주문 블록의 원문과 날짜 앵커를 콘솔 및 `logs/crawler.log`에 출력한다.
- 한 페이지 스캔이 끝나면 자동으로 다음 페이지로 이동한다.
- `maxPages`를 초과하려고 하면 이상동작으로 판단하고 안전 정지한다.
- 로그인 풀림, 날짜 파싱 실패, 저장용 JSON 필드 누락 등 비정상 상황은 즉시 중단한다.

## GUI: 월별 주문 테이블
- `server.js`가 정적 HTML과 주문 API를 함께 서빙한다.
- `public/index.html`은 월별/직접 날짜 필터, 받는사람 다중 선택 필터, 요약 금액, 주문 테이블을 표시한다.
- 받는사람 필터는 모바일 사용성을 위해 칩 토글 형태로 제공하며, 여러 명을 동시에 선택할 수 있다.
- 날짜 필터에서 `날짜 직접 지정`을 선택하면 시작일/종료일 date input으로 임의 기간을 조회한다.
- 화면 테이블에는 주문번호를 표시하지 않는다. 주문번호는 DB/API에서 PK/upsert 용도로 유지한다.
- 주문일은 기본적으로 최신순(desc) 정렬한다.
- 정산 화면에서는 취소/환불 등 음수 금액을 0원으로 표시하고 합계에도 0원으로 반영한다.
- 현재 필터 결과는 기본적으로 전체 선택되며, 체크를 해제한 주문은 요약 건수/합계/제외액 계산에서 빠진다.
- 상단 필터와 요약 영역은 고정하고, 주문 목록만 스크롤해서 정산 합계를 계속 확인할 수 있게 한다.
- API는 SQLite DB를 우선 읽고, DB 파일이 없으면 `data/orders.json`으로 fallback한다.
- 기본 URL은 `http://localhost:3000`이다.

### GUI API
`server.js`는 별도 프레임워크 없이 Node HTTP 서버로 동작한다.

- `GET /`: `public/index.html` 반환
- `GET /api/orders`: 주문 목록, 요약, 월 목록, 받는사람 목록 반환
- `GET /api/months`: 주문 데이터에 존재하는 `YYYY-MM` 목록 반환
- `GET /api/recipients`: 받는사람 목록 반환

`/api/orders` 쿼리:

```text
month=YYYY-MM
from=YYYY-MM-DD
to=YYYY-MM-DD
recipient=NAME
recipient=OTHER_NAME
```

- `month`는 월별 필터에 사용한다.
- `from`/`to`는 직접 날짜 지정 모드에 사용한다.
- `recipient`는 여러 번 전달할 수 있고, OR 조건으로 필터링한다.
- 응답의 `settlementAmount`는 GUI 정산용 금액이다. 원본 `amount`가 음수면 `settlementAmount`는 0이다.

## 2차: 주문 상세 파싱
- 현재 페이지의 타겟 기간 주문은 순서대로 모두 상세 페이지에 진입한다.
- `src/order-detail-parser.js`가 상세 페이지 텍스트에서 아래 필드를 파싱한다.
  - 주문번호
  - 주문 날짜
  - 배송/주문 상태
  - 상품명 목록
  - 상품별 금액
  - 받는 사람 이름
  - 받는 사람 주소
  - 총 결제 금액
  - 상태 기준 signed 금액
- 상세 파싱 후 구매내역 목록으로 복귀하고, 현재 페이지가 끝나면 자동으로 다음 페이지로 이동한다.

## 3차: 저장용 JSON 생성
- 상세 파싱 결과는 DB에 넣기 쉬운 flat record로 정리해 `data/orders.json`에 저장한다.
- `orderNumber`를 PK처럼 사용하며, 같은 주문번호가 다시 들어오면 기존 레코드를 덮어쓴다.
- 저장 JSON은 배열 형태이며 최신 주문일/주문번호 순으로 정렬한다.

저장 필드:

```json
{
  "orderNumber": "20101310316083",
  "orderDate": "2026-06-30",
  "orderStatus": "배송완료",
  "productName": "WIHOLL 중년 여성 오버핏 티셔츠...",
  "amount": 23900,
  "recipientName": "조*연",
  "recipientAddress": "(10936) 경기도 파주시 ..."
}
```

- `productName`: 여러 상품이 있으면 ` / `로 이어 붙인다.
- `amount`: 여러 상품이 있으면 상품 금액을 합산한다. 취소/환불/반품 상태는 음수로 저장한다.

## 4차: SQLite DB 저장
- 저장용 JSON 레코드 검증이 끝나면 SQLite DB에도 즉시 upsert한다.
- 기본 DB 파일은 `data/orders.sqlite`다.
- 마지막에 JSON 전체를 읽어 DB에 넣는 배치 방식이 아니라, 주문 1건마다 바로 DB에 저장한다.
- 라즈베리파이급 환경에서도 메모리 사용량을 작게 유지하기 위한 구조다.

SQLite 테이블:

```sql
CREATE TABLE orders (
  order_number TEXT PRIMARY KEY,
  order_date TEXT NOT NULL,
  order_status TEXT NOT NULL,
  product_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 상세 페이지 고정 텍스트 스키마
상세 파싱은 쿠팡 상세 페이지의 한글 원문이 안정적으로 수집된다는 전제로 아래 순서를 우선한다.

- `주문상세` 다음에 나오는 날짜/주문번호 포함 라인에서 주문 날짜와 주문번호를 뽑는다.
  - 예: `2026. 6. 30 주문주문번호 20101310316083`
- 주문번호 헤더 바로 다음 유효 라인을 배송/주문 상태로 본다.
  - 예: `배송완료`
- 상품명은 상품 금액 라인 바로 위의 유효 텍스트로 본다.
  - 예: `상품명` 다음 줄 `23,900 원`
- `받는사람` 라벨의 값은 수령인 이름으로 본다.
- `받는주소` 라벨의 값은 배송지로 본다.
- `연락처`는 현재 저장하지 않는다.
- `총 결제금액` 또는 `총 결제 금액` 다음 금액을 최종 결제 금액으로 본다.

# 상태 설정 파일
배송/주문 상태는 `config/order-statuses.json`에서 관리한다.

- `positiveAmountStatuses`: 구매/배송/완료처럼 `+` 금액으로 볼 상태
- `negativeAmountStatuses`: 취소/환불/반품처럼 `-` 금액으로 볼 상태

새 상태 문구를 발견하면 이 JSON 배열에 추가한다.

# 실행 설정
크롤링 기간과 디버그 여부는 `config/crawl-config.json`에서 기본값을 관리한다.

```json
{
  "debug": false,
  "headless": false,
  "maxPages": 10,
  "database": {
    "enabled": true,
    "type": "sqlite",
    "path": "./data/orders.sqlite"
  },
  "dateRange": {
    "cutoffDate": null,
    "daysAgo": 30,
    "toDate": null
  },
  "notifications": {
    "enabled": false,
    "provider": "ntfy",
    "priority": "high",
    "ntfy": {
      "serverUrl": "https://ntfy.sh",
      "topic": "",
      "token": ""
    },
    "pushover": {
      "apiUrl": "https://api.pushover.net/1/messages.json",
      "token": "",
      "user": ""
    }
  }
}
```

- `cutoffDate`: `YYYY-MM-DD` 형식. 이 날짜보다 오래된 주문을 만나면 종료한다.
- `daysAgo`: `cutoffDate`가 없을 때 오늘 기준 며칠 전까지 볼지 정한다.
- `toDate`: `YYYY-MM-DD` 형식. 없으면 현재 시각까지 본다.
- `debug`: `true`면 디버그 로그를 더 출력한다. 주문 상세 원문은 debug 여부와 관계없이 실행당 1회 `debug.YYYY-MM-DD.log`에 저장한다.
- `headless`: `true`면 브라우저 창 없이 실행한다. 로그인 전용 모드는 사람이 직접 로그인해야 하므로 항상 headed로 실행한다.
- `logs/crawler.log`: 실행 시작 시 5MB 이상이면 rotate한다. 기본 보관 파일은 5개다.
- `maxPages`: 자동 페이지 이동 안전장치. 기본 10페이지.
- `database.enabled`: SQLite 저장 여부.
- `database.path`: SQLite DB 파일 경로.
- `notifications.enabled`: 비정상 중단 시 알림 전송 여부.
- `notifications.provider`: `ntfy` 또는 `pushover`.
- `notifications.priority`: 알림 중요도. `silent`, `low`, `normal`, `high`, `urgent` 중 하나. 기본값은 `high`.
  - ntfy: `silent -> min`, `low -> low`, `normal -> default`, `high -> high`, `urgent -> urgent`
  - Pushover: `silent -> -2`, `low -> -1`, `normal -> 0`, `high/urgent -> 1`
  - Pushover의 emergency priority `2`는 반복 재전송용 `retry/expire`가 필요하므로 현재 공통 중요도 설정에서는 사용하지 않는다.
- `notifications.ntfy.topic`: ntfy 구독 토픽.
- `notifications.pushover.token/user`: Pushover 앱 토큰 및 사용자 키.

실행 인자는 config보다 우선한다.

```bash
node crawler.js --days-ago=7
node crawler.js --cutoff-date=2026-06-24
node crawler.js --debug --days-ago=7
node crawler.js --no-debug --cutoff-date=2026-06-24 --to-date=2026-07-01
node crawler.js --headless
node crawler.js --headed
node crawler.js --days-ago=60 --max-pages=10
node crawler.js --login
node crawler.js --notify --notify-provider=ntfy
node crawler.js --notify-priority=urgent
node crawler.js --db-path=./data/orders.sqlite
node crawler.js --no-db
```

GUI 서버:

```bash
pnpm serve
```

Playwright 브라우저/실행 의존성 설치:

```bash
pnpm run browser:install
pnpm run browser:install-deps
```

로그인 세션 준비:

```bash
pnpm run crawl -- --login
```

알림 secret은 config에 직접 적어도 되지만, 환경변수를 우선 추천한다.

```bash
CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=ntfy NTFY_TOPIC=my-secret-topic node crawler.js
CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=pushover PUSHOVER_TOKEN=xxx PUSHOVER_USER=yyy node crawler.js
CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=ntfy CRAWL_NOTIFY_PRIORITY=urgent NTFY_TOPIC=my-secret-topic node crawler.js
```

알림 확인용 실제 실패 환경:

1. DB 경로를 기존 파일 아래로 지정한다. 브라우저를 띄우기 전에 실패하므로 가장 빠르고, 쿠팡 세션이나 주문 데이터에 손대지 않는다.

   ```bash
   CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=ntfy NTFY_TOPIC=my-secret-topic node crawler.js --db --db-path ./README.md/orders.sqlite
   ```

   예상 실패: SQLite DB 폴더를 만들다가 `EEXIST: file already exists, mkdir './README.md'`로 중단된다.

2. Playwright 브라우저 캐시를 빈 디렉터리로 돌린다. 브라우저 실행 단계에서 실패하며, DB를 끄면 저장 데이터에 손대지 않는다.

   ```bash
   mkdir -p /tmp/pw-empty-coupang-test
   CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=ntfy NTFY_TOPIC=my-secret-topic PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-empty-coupang-test node crawler.js --no-db
   ```

   예상 실패: `Executable doesn't exist`로 Chromium 실행 전에 중단된다.

3. 로그인 세션을 임시로 빼서 로그인 풀림 상황을 만든다. 실제 구매내역 페이지 파싱 실패 경로를 확인할 수 있다.

   ```bash
   mv .local-session .local-session.notify-test.bak
   CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=ntfy NTFY_TOPIC=my-secret-topic node crawler.js --no-db
   rm -rf .local-session
   mv .local-session.notify-test.bak .local-session
   ```

   예상 실패: 로그인 화면이나 비정상 페이지라서 `주문 상세보기 버튼과 주문 블록이 모두 없습니다...`로 중단된다.

4. 페이지 안전장치를 일부러 작게 잡는다. 구매내역이 2페이지 이상 있고 다음 페이지 버튼이 활성화되어 있을 때만 실패한다.

   ```bash
   CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=ntfy NTFY_TOPIC=my-secret-topic node crawler.js --no-db --days-ago=3650 --max-pages=1
   ```

   예상 실패: 2페이지로 넘어가려는 순간 `1페이지를 초과하려고 해서...`로 중단된다.

주의: `--cutoff-date=bad`, `--days-ago=bad`, 깨진 JSON 설정 파일처럼 런타임 설정을 읽는 단계에서 나는 오류는 현재 `notifyFailure()`가 있는 `try/catch` 밖에서 발생한다. 따라서 알림 전송 테스트용 실패 케이스로는 적합하지 않다. 로그 파일 생성 실패도 로거 설치 단계에서 나므로 같은 이유로 피한다.

비정상 중단으로 보는 상황:

- 구매내역에서 `주문 상세보기`와 주문 블록이 모두 없는 경우
- 주문 블록 날짜를 파싱하지 못한 경우
- 상세보기 버튼을 찾지 못한 경우
- 저장용 JSON 필드 중 하나라도 비어 있는 경우
- `maxPages`를 초과하려는 경우

# 장애 대응 루틴
파싱이 깨졌거나 저장 필드가 비어 중단되면 아래 순서로 확인한다.

1. `logs/crawler.log`에서 마지막으로 처리한 페이지/주문 블록/날짜 앵커를 확인한다.
2. 같은 날짜의 `debug.YYYY-MM-DD.log`에서 첫 상세 페이지 원문을 확인한다.
3. 쿠팡 상세 페이지의 고정 텍스트 순서가 바뀌었는지 확인한다.
4. 상태 문구만 새로 생긴 경우 `config/order-statuses.json`에 추가한다.
5. 상세 페이지 구조가 바뀐 경우 `src/order-detail-parser.js`와 `src/order-parser.test.js`의 샘플을 함께 수정한다.
6. 목록 분리 방식이 바뀐 경우 `src/order-parser.js`와 목록 관련 테스트를 수정한다.
7. 수정 후 `pnpm test`를 먼저 통과시키고 실제 크롤링을 짧은 기간으로 다시 실행한다.

상세 원문은 파싱 전에 저장한다. 따라서 상세 페이지 진입 이후 파서가 실패해도 최소 1건의 복구용 원문은 남아야 한다. 단, 로그인 풀림이나 타겟 기간 주문 없음처럼 상세 페이지에 한 번도 진입하지 못한 경우에는 상세 원문 파일이 생기지 않을 수 있다.

# GitHub 업로드 주의사항
이 프로젝트는 개인 주문/주소/로그인 세션을 다룬다. 저장소를 private로 쓰더라도 아래 파일은 커밋하지 않는다.

- `.local-session/`: 쿠팡 로그인 쿠키와 브라우저 프로필
- `data/orders.json`: 주문 데이터
- `data/orders.sqlite`: 주문 DB
- `data/orders.sqlite-wal`, `data/orders.sqlite-shm`: SQLite 보조 파일
- `logs/crawler.log`: 주문 목록 로그
- `debug.*.log`: 상세 페이지 원문
- `.env*`: 알림 토큰 등 secret

현재 `.gitignore`는 위 파일을 기본적으로 차단한다. Git 초기화 후 첫 커밋 전에는 `git status --short`로 민감 파일이 보이지 않는지 확인한다.

# 주요 파일
- `README.md`: GitHub 첫 화면용 사용 설명
- `docs/project.md`: 구현 상세 문서와 운영 메모
- `crawler.js`: Playwright 실행, 목록 순회, 상세 진입/복귀
- `server.js`: 월별 주문 내역 GUI/API 서버
- `public/index.html`: 월별 필터 테이블 UI
- `src/date-utils.js`: 날짜 범위 계산, 유연한 날짜 파싱
- `src/order-parser.js`: 구매내역 목록 텍스트를 주문 블록으로 분리
- `src/order-detail-parser.js`: 주문 상세 페이지 텍스트에서 구조화 데이터 파싱
- `src/order-record-store.js`: 저장용 주문 레코드 변환 및 `data/orders.json` upsert
- `src/order-db.js`: SQLite DB 연결, 테이블 생성, 주문 upsert
- `src/runtime-config.js`: config 및 CLI 실행 인자 해석
- `src/notifier.js`: ntfy/Pushover 실패 알림 전송
- `src/logger.js`: 콘솔 출력과 `logs/crawler.log` 파일 출력을 동시에 처리
- `config/order-statuses.json`: 상태 문구별 `+`/`-` 금액 분류
- `config/crawl-config.json`: 크롤링 기간 및 디버그 기본 설정
- `data/orders.json`: 저장용 주문 JSON
- `data/orders.sqlite`: SQLite 주문 DB
- `src/order-parser.test.js`: 목록/상세 파서 단위 테스트

# 검증 명령
```bash
node --check crawler.js
node --check server.js
pnpm test
```
