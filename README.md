# Order Ledger

쿠팡 구매내역을 내 컴퓨터에서 크롤링해 월별 정산용으로 확인하는 개인 주문 장부입니다.

이 문서는 **처음 쓰는 사람을 위한 사용설명서**입니다. 설치 → 최초 로그인 → 크롤링 → 화면으로 확인 순서로 따라 하면 됩니다.
코드 구조나 파싱 규칙 같은 내부 구현은 [docs/project.md](docs/project.md)에 있습니다.

> ⚠️ 이 도구는 내 쿠팡 로그인 세션과 개인 주문/주소 데이터를 다룹니다. GitHub에 올릴 때는 `.local-session/`, `data/`, `*.log`, `.env*`가 절대 커밋되지 않도록 확인하세요. (아래 [민감 파일](#민감-파일) 참고)

---

## 1. 준비물

- **Node.js 24 이상**
- **pnpm** (`npm i -g pnpm`으로 설치)
- **Playwright용 Chromium** (아래에서 설치)

먼저 프로젝트 의존성을 설치합니다.

```bash
pnpm install
```

### Playwright 브라우저 설치

크롤링은 Playwright가 띄우는 Chromium으로 동작합니다. 브라우저가 없으면 크롤링 시작 시
`Executable doesn't exist ...` 같은 오류가 납니다. 그럴 때는 아래 명령으로 한 번만 설치하세요.

```bash
pnpm exec playwright install chromium
```

> 리눅스/WSL에서 실행 라이브러리가 없다고 나오면 `pnpm exec playwright install-deps chromium`도 함께 실행하세요.

---

## 2. 최초 로그인 (딱 한 번)

이 프로젝트에는 아이디/비밀번호를 넣는 로그인 코드가 **없습니다.**
대신 브라우저 창을 실제로 띄우고, 거기서 **사람이 직접 한 번 쿠팡에 로그인**합니다.
로그인하면 쿠키/세션이 `.local-session/` 폴더에 저장돼서, 다음부터는 자동 로그인 상태로 크롤링됩니다.

처음 한 번은 이렇게 합니다.

1. 크롤러를 실행합니다.

   ```bash
   pnpm crawl
   ```

2. 잠시 후 **Chromium 창이 자동으로 뜨고** 쿠팡 구매내역 페이지로 이동합니다.
   아직 로그인 전이라 로그인 화면이 보일 겁니다.
3. 그 창에서 **평소처럼 쿠팡에 로그인**합니다. (아이디/비밀번호, 필요하면 문자 인증까지)
4. 로그인해서 구매내역이 보이는 상태가 되면 세션이 `.local-session/`에 저장됩니다.
   - 이 첫 실행은 로그인하느라 크롤링이 중간에 멈추거나(주문 목록을 못 찾음) 실패할 수 있는데 정상입니다.
5. 창을 닫고 **다시 `pnpm crawl`을 실행**하면, 이제 로그인된 상태로 주문 수집이 진행됩니다.

> 💡 브라우저 창은 일부러 눈에 보이게(`headless: false`) 띄웁니다. 로그인 상태를 눈으로 확인하고 봇 탐지를 피하기 위해서입니다.

### 로그인이 다시 풀렸을 때

쿠팡 세션은 시간이 지나면 만료됩니다. 크롤링 중
`로그인이 풀렸거나 페이지 구조가 바뀐 것으로 판단합니다` 같은 메시지로 멈추면,
위 **2. 최초 로그인**을 그대로 다시 하면 됩니다. (창이 뜨면 다시 로그인 → 창 닫고 재실행)

세션을 완전히 초기화하고 싶으면 `.local-session/` 폴더를 통째로 지운 뒤 다시 로그인하세요.

---

## 3. 크롤링하기

로그인이 끝났다면 이후에는 이 명령 하나면 됩니다.

```bash
pnpm crawl
```

기본적으로 최근 며칠치 주문을 수집합니다. 기간을 바꾸고 싶으면 아래 [설정](#5-설정)을 보세요.

수집이 끝나면 주문 데이터가 `data/orders.json`과 `data/orders.sqlite`에 저장됩니다.
같은 주문번호는 덮어쓰기(upsert)되므로, 배송완료였던 주문이 나중에 취소/반품으로 바뀌어도 다시 돌리면 최신 상태로 갱신됩니다.

---

## 4. 화면으로 확인하기 (GUI)

수집한 주문을 월별 정산 화면으로 봅니다.

```bash
pnpm serve
```

브라우저에서 **http://localhost:3000** 으로 접속하면 됩니다.

화면에서 할 수 있는 것:

- 월별 또는 직접 날짜 범위로 필터
- 받는 사람 여러 명 동시 선택(칩 토글)
- 주문별로 합계에 포함/제외 체크 후 금액 재계산
- 취소/환불 등 음수 금액은 0원으로 표시하고 합계에서도 0원 처리
- 모바일에서는 카드 형태로 표시

---

## 5. 설정

크롤링 기간 등 기본값은 [config/crawl-config.json](config/crawl-config.json)에서 바꿉니다.

```json
{
  "debug": false,
  "dateRange": {
    "cutoffDate": null,
    "daysAgo": 7,
    "toDate": null
  },
  "maxPages": 10
}
```

- `daysAgo`: 오늘 기준 며칠 전까지 수집할지
- `cutoffDate`: `YYYY-MM-DD`. 이 날짜보다 오래된 주문을 만나면 멈춤 (설정하면 `daysAgo`보다 우선)
- `toDate`: 언제까지 볼지. 비우면 현재까지
- `maxPages`: 자동 페이지 넘김 안전장치

실행할 때 인자로 주면 config보다 우선합니다. 이번만 다른 기간을 볼 때 편합니다.

```bash
node crawler.js --days-ago=7
node crawler.js --cutoff-date=2026-06-24
node crawler.js --to-date=2026-07-01
node crawler.js --debug --days-ago=7
```

더 자세한 옵션(알림, DB 경로 등)은 [docs/project.md](docs/project.md#실행-설정)에 있습니다.

---

## 6. 문제가 생기면

| 증상 | 확인 |
| --- | --- |
| `Executable doesn't exist` 로 시작 못 함 | Chromium 미설치. `pnpm exec playwright install chromium` |
| `로그인이 풀렸거나 ...` 로 멈춤 | 세션 만료. [최초 로그인](#2-최초-로그인-딱-한-번)을 다시 진행 |
| 주문이 하나도 안 수집됨 | 기간 설정 확인(`daysAgo`/`cutoffDate`), 또는 로그인 상태 확인 |
| 파싱이 깨져서 중단됨 | 쿠팡 페이지 구조 변경 가능성. 아래 로그 확인 후 [docs/project.md](docs/project.md#장애-대응-루틴) 참고 |

로그 위치:

- `logs/crawler.log`: 실행 로그 (콘솔에 나온 것과 동일)
- `debug.YYYY-MM-DD.log`: 실행마다 첫 주문 상세 페이지 원문 1건 (파서 복구용)

---

## 7. 알림 (선택)

크롤링이 비정상으로 멈췄을 때 ntfy 또는 Pushover로 알림을 받을 수 있습니다.
토큰은 config에 직접 적을 수도 있지만, 공개 저장소 가능성을 생각하면 환경변수를 추천합니다.

```bash
CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=ntfy NTFY_TOPIC=my-topic node crawler.js
CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=pushover PUSHOVER_TOKEN=xxx PUSHOVER_USER=yyy node crawler.js
CRAWL_NOTIFY_ENABLED=true CRAWL_NOTIFY_PROVIDER=ntfy CRAWL_NOTIFY_PRIORITY=urgent NTFY_TOPIC=my-topic node crawler.js
```

중요도는 `notifications.priority` 또는 `CRAWL_NOTIFY_PRIORITY`로 설정합니다. 값은 `silent`, `low`, `normal`, `high`, `urgent`를 지원하며 기본값은 `high`입니다.

---

## 민감 파일

다음은 Git에 올리면 안 됩니다. 현재 [.gitignore](.gitignore)에 기본 차단 규칙이 들어 있고,
첫 커밋 전에 `git status --short`로 이 파일들이 보이지 않는지 확인하세요.

- `.local-session/` — 쿠팡 로그인 세션/쿠키
- `data/orders.json`, `data/orders.sqlite` — 주문 데이터
- `logs/crawler.log`, `debug.*.log` — 로그와 상세 원문
- `.env*` — 알림 토큰 등

---

## 개발자용 문서

내부 구현, 파싱 규칙, 데이터 스키마, 장애 대응 절차는 [docs/project.md](docs/project.md)를 보세요.

테스트:

```bash
node --check crawler.js
node --check server.js
pnpm test
```
