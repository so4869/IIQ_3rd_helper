# 정상화의 신 V10 — ShinNormalizer

대용량 USER_ID 목록을 지정한 파티션 수에 균등하게 분배하고, 각 파티션에 대한 SQL `WHERE` 절을 자동 생성하는 Node.js 유틸리티입니다.

---

## 사용 방법

1. `input.txt` 파일에 USER_ID를 한 줄에 하나씩 작성합니다.
2. 실행합니다.

```bash
node main_shin.js
```

3. 결과는 콘솔과 `output.txt`(탭 구분) 두 곳에 출력됩니다.

`output.txt` 컬럼 구성:

| Partition Name | Estimated Accounts | Estimated Rows | Query |
|---|---|---|---|
| PARTITION_1 (Owner: C) | 1200 | 45000 | `(USER_ID LIKE 'C1%' OR ...)` |

---

## 주요 옵션

`main_shin.js`에서 `normalizePartitions()` 호출 시 아래 옵션을 조정합니다.

```js
const result = PartitionNormalizer.normalizePartitions(rawData, 48, majorCategory, {
    includeNotAll: true,   // 미분류 ID를 PARTITION_CATCH_ALL로 묶을지 여부
    maxDepth: 5,           // 프리픽스 최대 세분화 깊이
    allowMixing: true,     // true: 카테고리 혼합 허용 / false: 카테고리별 파티션 독립
    granularity: 0.1,      // 세분화 민감도 (낮을수록 더 잘게 쪼갬)
    balanceTarget: 'user'  // 'row': 총 로그 건수 기준 / 'user': 고유 사용자 수 기준 균등분배
});
```

### `balanceTarget` 선택 기준

| 값 | 언제 사용 | 효과 |
|---|---|---|
| `'row'` | 파티션별 쿼리 처리량을 고르게 하고 싶을 때 | 헤비 유저의 로그가 많은 파티션에 집중됨을 방지 |
| `'user'` | 헤비 유저의 데이터 편중을 무시하고 사용자 수만 균등하게 맞추고 싶을 때 | 특정 사용자의 로그가 폭발적으로 많아도 파티션 수가 기준이 됨 |

### `allowMixing` 선택 기준

| 값 | 효과 |
|---|---|
| `false` (기본) | 각 `majorCategory`가 전용 파티션을 가짐. 카테고리 간 쿼리 격리 보장. |
| `true` | 모든 카테고리를 통합 정렬 후 파티션에 순차 배분. 파티션 수가 적을 때 균형이 더 좋음. |

---

## 출력 파티션 종류

| 파티션명 | 내용 |
|---|---|
| `PARTITION_N (Owner: X)` | 정상 분류된 파티션. `allowMixing=false`일 때 Owner 태그 포함. |
| `PARTITION_CATCH_ALL` | `majorCategory`에 해당하지 않는 모든 ID. `includeNotAll=true`일 때 생성. |
| `PARTITION_EXCEPTION` | `USER_ID`가 null, 빈 문자열, 공백인 행. |

---

## 알고리즘 개요

1. **전처리** — 중복 ID를 `userStats` Map으로 압축하고 null/빈값 카운트를 별도 추적
2. **초기 그룹핑** — 각 ID를 `majorCategory` 프리픽스 기준으로 분류, 미해당 시 `CatchAll`
3. **드릴다운** — 가중치가 임계값(`targetCap × granularity`)을 초과하는 그룹을 BFS로 한 글자씩 세분화; 프리픽스 길이와 ID 길이가 같으면 `EXACT_` 마커로 정확 일치 처리
4. **순차 패킹** — 동적 목표치(`남은 가중치 / 남은 파티션 수`)를 기준으로 청크를 파티션에 순서대로 배분
5. **쿼리 압축** — 다른 파티션과 충돌하지 않는 범위에서 프리픽스를 최대한 단축
6. **갭 캐처** — 카테고리가 여러 파티션으로 분할된 경우, 마지막 파티션에 `NOT LIKE` 절을 추가해 누락 ID를 방지
7. **최종 포맷** — `LIKE`, `=`, 복합 NOT 절을 조합한 SQL 출력

---

## 파일 구조

```
ShinNormalizer/
├── main_shin.js                    # 진입점: input.txt 읽기, 옵션 설정, output.txt 출력
└── ShinNormalizer_V10_DualBalance.js  # 핵심 알고리즘 (normalizePartitions 함수 export)
```

의존성 없음. Node.js만 있으면 바로 실행 가능합니다.
