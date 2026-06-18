# spt_provisioning_transaction 분석 도구

SailPoint IdentityIQ 8.4p2의 `spt_provisioning_transaction` 테이블을 분석하는 단일 스크립트 도구입니다.

## 출력 보고서

### 1단계 — SQL 집계 (XML 비접근)
| 보고서 | 집계 키 |
|--------|---------|
| Application / Source별 트랜잭션 건수 | `integration`, `source` |
| Application별 소계 | `integration` |
| Source별 소계 | `source` |

### 2단계 — XML 파싱 집계
| 보고서 | 집계 키 |
|--------|---------|
| 트랜잭션 건수 | `application`, `월`, `source`, `planResult` |
| planResult 전체 소계 | `planResult` |
| Entitlement 건수 (요청/필터링) | `application`, `월`, `source`, `op`, `planResult` |
| op 소계 | `op` (Add / Remove / Set 등) |

## 요구사항

- Python 3.8+
- pyodbc
- SQL Server ODBC 드라이버 (13 / 17 / 18 중 하나)

```bash
pip install pyodbc
```

## DB 설정

`analyze_provisioning_transactions.py` 상단 상수를 환경에 맞게 수정합니다.

```python
SERVER   = "localhost"
PORT     = 1433
DATABASE = "identityiq"
USERNAME = "sa"
PASSWORD = "yourpassword"   # 반드시 변경
```

ODBC 드라이버는 `DRIVER_CANDIDATES` 목록에서 설치된 것을 자동 선택합니다.

## 실행 방법

날짜, 날짜+시각, Unix millisecond 타임스탬프 세 가지 형식을 지원합니다.

```bash
# 날짜 형식 (해당 날짜 00:00:00 기준)
python analyze_provisioning_transactions.py --start 2024-01-01 --end 2024-12-31

# 날짜+시각 형식
python analyze_provisioning_transactions.py --start "2024-01-01 00:00:00" --end "2024-12-31 23:59:59"

# Unix ms 타임스탬프 형식
python analyze_provisioning_transactions.py --start 1704034800000 --end 1735570799999
```

`created` 컬럼은 Unix ms BIGINT로 저장되므로 `BETWEEN` 필터로 기간을 처리합니다.

## 동작 방식

```
[1/3] DB 연결
       └─ find_driver() 로 사용 가능한 ODBC 드라이버 자동 탐색
[2/3] SQL 집계 (SUMMARY_SQL)
       └─ GROUP BY integration, source → 건수 집계
[3/3] XML 파싱 (DETAIL_SQL)
       └─ attributes 컬럼을 500건 단위 청크로 fetch
       └─ parse_attributes(): request / filtered / planResult 추출
       └─ get_entitlements_by_op(): AttributeRequest.op별 value 건수 집계
```

### XML 파싱 대상 구조

```xml
<Attributes><Map>
  <entry key="request">
    <value><ProvisioningPlan>...</ProvisioningPlan></value>
  </entry>
  <entry key="filtered">
    <value><ProvisioningPlan>...</ProvisioningPlan></value>
  </entry>
  <entry key="planResult">
    <value><ProvisioningResult status="Committed"/></value>
  </entry>
</Map></Attributes>
```

### AttributeRequest value 카운트 규칙

| 직렬화 형태 | 예시 | 카운트 |
|------------|------|--------|
| 인라인 속성 | `<AttributeRequest value="CN=..." />` | 1 |
| 단일 엘리먼트 | `<AttributeRequest><Value>CN=...</Value>` | 1 |
| List | `<Value><List><String>…</String><String>…</String>` | String 개수 |
| value 없음 (Unlock 등) | `<AttributeRequest op="Unlock" />` | 1 |

## 출력 예시

```
══════════════════════════════════════════════════════════════════
  SailPoint IdentityIQ 8.4p2 — spt_provisioning_transaction 분석
  대상  : localhost:1433 / identityiq
  기간  : 2024-01-01 00:00:00  ~  2024-12-31 23:59:59
══════════════════════════════════════════════════════════════════

[1/3] DB 연결 중...
      연결 성공

[2/3] Application / Source별 건수 조회 (SQL)...

  ■ Application별 / Source별 트랜잭션 건수  [SQL 집계]
  Application                                   Source                               Count
  ──────────────────────────────────────────────────────────────────────────────
  ActiveDirectory                               LCM                                  1,234
  ...

[3/3] XML attributes 파싱 (청크 단위: 500건)...
  fetch 완료: 1,234건  (처리: 1,200  파싱오류: 2  attributes없음: 32)

  ■ XML 분석 — Application / 월 / Source / planResult별 트랜잭션 건수
  ...
```

## 파일 구성

```
.
└── analyze_provisioning_transactions.py   # 단일 실행 스크립트
```
