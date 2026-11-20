# TANK

배틀 시티(1985)를 현대화한 웹 게임(PWA). 기획은 `../proposal/`, 구현 계획은 `../docs/plan.md`, 컨셉 아트는 `../concept/index.html`.

## 실행

이 `src/` 폴더가 앱 루트이고 **GitHub Pages 에 그대로 올라간다**. 빌드 없이 정적 파일로 동작하며, 서비스 워커와 ES 모듈 때문에 HTTP 로 서빙해야 한다.

```sh
cd src
npm run serve          # http://localhost:8080 (같은 Wi-Fi 의 태블릿용 주소도 출력, no-cache)
npm run serve:https    # https://<IP>:8443 자체 서명 인증서 (태블릿에서 컨트롤러·오프라인 시험)
npm test               # 순수 로직 테스트 (node --test)
npm run build:sprites  # tools/art 로 themes/*/ 스프라이트·theme.json·아이콘·concept/index.html 재생성
npm run build:sfx      # 효과음 합성 → sfx/*.wav
npm run dist           # ../dest/tank-v<N>.zip (배포본, tools/tests 제외)
```

버전은 `js/version.js` 의 `APP_VERSION` 하나다. 올리면 `sw.js` 의 `CACHE` 도 같이 올린다(테스트가 두 값을 비교한다). 타이틀 화면에 `v<N>` 으로 표시된다.

## 구조

- 규칙(`grid`, `units`, `projectile`, `world`, `enemy`, `stages`, `editor`)은 Phaser 와 무관한 순수 JS. `tests/` 가 검증한다.
- `stage.js` 가 Phaser 4(`vendor/`) 로 그리고 파티클·카메라·사운드를 더한다. `editorscene.js` 는 편집기 화면.
- `layout.js`/`input.js`/`menu.js` 는 versus 에서 이식: 가상 패드 배치(사이드/하단, 75% 규칙), 게임패드 배정, 메뉴 탐색.
- 테마는 `themes/<id>/theme.json` + `sheets/*.svg`. 로직은 지형 id·유닛 역할·아이템 id 만 알고, 테마가 그림·이름·탄 규칙(`rules`)·적 특성(`traits`)·효과음을 붙인다. 새 테마는 폴더 하나와 같은 구조의 JSON 만 추가하면 된다. 유닛 그림은 위를 보는 2프레임이고 렌더러가 회전한다.

## 테마별 규칙

| 테마 | 탄 | 특성 |
|---|---|---|
| 클래식 | 직선, 탄끼리 상쇄 | 얼음 미끄럼 |
| 고대 투석기전 | 포물선(표적 착지: 첫 적 → 첫 벽 → 사거리 끝), 착지 2×2 파괴, 비행 중 무충돌 | 공성탑이 벽돌을 뭉갬, 진흙 감속 |
| 우주 함대전 | 즉시 닿는 레이저(3.5타일), 과열 0.5초, 요새 밖 강철에서 시계 방향 1회 반사 | 요격기 회피, 무중력 관성 |
| 할로윈 유령전 | 도깨비불 유도 10°/s, 사거리 5타일 | 유령 2초 주기 투명(벽돌 통과·무적·발사 불가), 요새 구역에서 실체화 |

본진 둘레 3×3 타일(요새 구역)에서는 테마 특수 규칙이 꺼진다.

## 조작

| 행동 | 게임패드 | 가상 패드 | 키보드 P1 / P2 |
|---|---|---|---|
| 이동 | D-패드, 왼쪽 스틱 | 십자키 | WASD / 방향키 |
| 발사 | A, B (누르고 있으면 연사) | 발사 | F / K |
| 일시정지 | Start | ❚❚ | Esc |
| 편집기 | D-패드 커서, A 배치, B 지우기, Y 지형, X 붓 | 터치로 칠하기 + 아래 도구 막대 | 방향키, Space, Backspace, Tab, Q |

게임패드가 연결되면 그 플레이어의 가상 패드는 사라지고 메인 뷰가 그 자리를 차지한다. Safari 는 패드 버튼을 한 번 눌러야 인식하고, 패드·서비스 워커는 HTTPS 또는 localhost 에서만 열린다.

## 맵 편집

타이틀 → 맵 편집. 협동(13×13)·대전(19×13) 규격을 고르고 반타일 단위로 칠한다. 본진·적 등장 3곳·플레이어 시작 2곳은 보호된다. `localStorage["tank.maps.v1"]` 에 최대 50장 저장되며, 내보내기/가져오기는 JSON 텍스트를 복사·붙여넣기한다. "시험 플레이" 는 저장 후 그 맵으로 바로 시작한다.

## 배포

`npm run dist` 가 `../dest/tank-v<N>.zip` 을 만든다. zip 루트에 `index.html` 이 있으므로 압축을 풀어 GitHub Pages 브랜치/폴더에 그대로 넣으면 된다(`tools/`, `tests/`, `package.json` 제외).
