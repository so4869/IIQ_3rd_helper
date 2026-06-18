# IIQ_3rd_helper

SailPoint IdentityIQ / ISC 운영 지원 유틸리티 모음입니다.

## 도구 목록

### 1. ShinNormalizer (`ShinNormalizer/`)

대용량 USER_ID 목록을 지정한 파티션 수에 균등 분배하고 각 파티션에 대한 SQL `WHERE` 절을 자동 생성하는 Node.js 유틸리티입니다 (V10 DualBalance).

```bash
# input.txt에 USER_ID를 한 줄씩 작성 후 실행
cd ShinNormalizer
node main_shin.js
# → 콘솔 출력 + output.txt (탭 구분) 생성
```

**주요 옵션:** `numPartitions`, `allowMixing`, `balanceTarget` (`row` / `user`), `granularity`, `maxDepth`

자세한 내용 → [`ShinNormalizer/README.md`](ShinNormalizer/README.md)

---

### 2. SPT Provisioning Transaction 분석 (`Summary-SPT_PROVISIONING_TRANSACTION/`)

SailPoint IdentityIQ 8.4p2의 `spt_provisioning_transaction` 테이블을 SQL 집계 + XML 파싱으로 분석하는 Python 스크립트입니다.

```bash
pip install pyodbc
cd Summary-SPT_PROVISIONING_TRANSACTION
python analyze_provisioning_transactions.py --start 2024-01-01 --end 2024-12-31
```

**출력:** Application / Source / planResult / AttributeRequest op별 트랜잭션 건수

자세한 내용 → [`Summary-SPT_PROVISIONING_TRANSACTION/README.md`](Summary-SPT_PROVISIONING_TRANSACTION/README.md)

---

## 공통 사항

- 각 도구는 독립적이며 공유 빌드 시스템이나 패키지 매니저가 없습니다.
- 소스 내 주석은 한국어로 작성되어 있습니다.
