#!/usr/bin/env python3
"""
SailPoint IdentityIQ 8.4p2
spt_provisioning_transaction 분석 스크립트

집계 차원
  [SQL 집계]  application / month / source → 트랜잭션 건수
  [XML 분석]  application / month / source / planResult → 트랜잭션 건수
              application / month / source / AttributeRequest.op → entitlement 건수
                (request plan: 요청된 entitlement 수)
                (filtered plan: 필터링된 entitlement 수)

created 컬럼은 Unix timestamp(ms, BIGINT) → BETWEEN으로 기간 필터

사용법:
  python analyze_provisioning_transactions.py --start <ms> --end <ms>
  python analyze_provisioning_transactions.py --start 2024-01-01 --end 2024-12-31
  python analyze_provisioning_transactions.py --start "2024-01-01 00:00:00" --end "2024-12-31 23:59:59"
"""

import sys
import re
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import xml.etree.ElementTree as ET

try:
    import pyodbc
except ImportError:
    sys.exit("[오류] pyodbc 패키지가 필요합니다: pip install pyodbc")

# ─── DB 설정 ──────────────────────────────────────────────────────────────────
SERVER   = "localhost"
PORT     = 1433
DATABASE = "identityiq"
USERNAME = "sa"
PASSWORD = "yourpassword"   # 환경에 맞게 수정

DRIVER_CANDIDATES = [
    "{ODBC Driver 18 for SQL Server}",
    "{ODBC Driver 17 for SQL Server}",
    "{ODBC Driver 13 for SQL Server}",
    "{SQL Server}",
]

FETCH_CHUNK_SIZE = 500   # fetchmany 단위


# ─── 인자 파싱 ────────────────────────────────────────────────────────────────
def _parse_ts(s: str) -> int:
    """Unix ms 정수 문자열 또는 날짜 문자열을 ms timestamp로 변환."""
    try:
        return int(s)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(s, fmt).timestamp() * 1000)
        except ValueError:
            continue
    raise argparse.ArgumentTypeError(
        f"인식할 수 없는 형식: {s!r}  (Unix ms 정수 또는 YYYY-MM-DD[HH:MM:SS])"
    )


def parse_args():
    p = argparse.ArgumentParser(
        description="spt_provisioning_transaction 분석",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "예시:\n"
            "  --start 1704034800000 --end 1735570799999\n"
            "  --start 2024-01-01   --end 2024-12-31\n"
            "  --start '2024-01-01 00:00:00' --end '2024-12-31 23:59:59'"
        ),
    )
    p.add_argument("--start", required=True, type=_parse_ts,
                   metavar="TS_OR_DATE", help="조회 시작 (Unix ms 또는 YYYY-MM-DD)")
    p.add_argument("--end",   required=True, type=_parse_ts,
                   metavar="TS_OR_DATE", help="조회 종료 (Unix ms 또는 YYYY-MM-DD)")
    return p.parse_args()


# ─── 연결 ─────────────────────────────────────────────────────────────────────
def find_driver() -> str:
    available = pyodbc.drivers()
    for candidate in DRIVER_CANDIDATES:
        if candidate.strip("{}") in available:
            return candidate
    if available:
        print(f"[경고] 알려진 드라이버 없음. 첫 번째 드라이버 사용: {available[0]}")
        return "{" + available[0] + "}"
    raise RuntimeError("ODBC 드라이버를 찾을 수 없습니다.")


def get_connection():
    driver = find_driver()
    conn_str = (
        f"DRIVER={driver};"
        f"SERVER={SERVER},{PORT};"
        f"DATABASE={DATABASE};"
        f"UID={USERNAME};"
        f"PWD={PASSWORD};"
        f"Encrypt=no;"
        f"TrustServerCertificate=yes;"
    )
    return pyodbc.connect(conn_str, timeout=15)


# ─── SQL ──────────────────────────────────────────────────────────────────────
# created는 Unix ms(BIGINT) → BETWEEN 필터, month는 Python에서 변환
# SUMMARY_SQL: 순수 SQL 집계 (op 없음 — op는 XML 내부에 있어 Python 파싱 필요)
SUMMARY_SQL = """
SELECT
    ISNULL(integration, '(null)')   AS application,
    ISNULL(source, '(null)')        AS source,
    COUNT(*)                        AS cnt
FROM identityiq.spt_provisioning_transaction
WHERE created BETWEEN ? AND ?
GROUP BY
    integration,
    source
ORDER BY
    integration,
    source
"""

# DETAIL_SQL: created 포함 — Python에서 month 변환 후 XML 파싱
DETAIL_SQL = """
SELECT
    id,
    ISNULL(integration, '(null)')      AS application,
    ISNULL(source, '(null)')           AS source,
    created,
    CONVERT(NVARCHAR(MAX), attributes) AS attributes
FROM identityiq.spt_provisioning_transaction
WHERE created BETWEEN ? AND ?
ORDER BY created DESC
"""


# ─── XML 파싱 헬퍼 ────────────────────────────────────────────────────────────
_DOCTYPE_RE = re.compile(r"<!DOCTYPE[^>]*>", re.IGNORECASE)


def _strip_doctype(xml_str: str) -> str:
    return _DOCTYPE_RE.sub("", xml_str or "")


def parse_attributes(xml_str: str) -> dict:
    """
    SailPoint Attributes XML → {request, filtered, planResult, parse_error}

    <Attributes><Map>
      <entry key="request">   <value><ProvisioningPlan>...</ProvisioningPlan></value></entry>
      <entry key="filtered">  <value><ProvisioningPlan>...</ProvisioningPlan></value></entry>
      <entry key="planResult"><value><ProvisioningResult status="..."/></value></entry>
    </Map></Attributes>

    Map entry 내부의 <value> 태그는 소문자.
    """
    result: dict = {"request": None, "filtered": None, "planResult": None, "parse_error": None}
    if not xml_str or not xml_str.strip():
        return result
    try:
        root = ET.fromstring(_strip_doctype(xml_str))
        for entry in root.findall(".//entry"):
            key = entry.get("key", "")
            if key in ("request", "filtered", "planResult"):
                val_elem = entry.find("value")   # Map entry의 <value>는 소문자
                if val_elem is not None:
                    children = list(val_elem)
                    if children:
                        result[key] = children[0]
    except ET.ParseError as exc:
        result["parse_error"] = str(exc)
    return result


def plan_result_status(pr_elem) -> str:
    if pr_elem is None:
        return "N/A"
    return pr_elem.get("status", "unknown")


def _count_attr_request_values(ar_elem) -> int:
    """
    AttributeRequest 하나의 value 건수.

    SailPoint IIQ XML 직렬화 형태:
      1) 인라인 속성  → <AttributeRequest value="CN=..." .../>           → 1
      2) 단일 엘리먼트 → <AttributeRequest><Value>CN=...</Value>...       → 1
      3) List        → <AttributeRequest>
                         <Value><List>
                           <String>CN=G1,...</String>
                           <String>CN=G2,...</String>
                         </List></Value>                                  → String 개수

    ※ 인라인은 소문자 'value' 속성, XML 엘리먼트는 대문자 'Value' 태그
    """
    # 형태 1: 인라인 속성 (소문자 value)
    if ar_elem.get("value") is not None:
        return 1

    # 형태 2·3: <Value> 엘리먼트 (대문자 V)
    val_elem = ar_elem.find("Value")
    if val_elem is None:
        # value 자체가 없는 op (Unlock, Enable 등) → 요청 1건으로 계산
        return 1

    list_elem = val_elem.find("List")
    if list_elem is not None:
        strings = list_elem.findall("String")
        return len(strings) if strings else 1

    return 1


def get_entitlements_by_op(plan_elem) -> dict:
    """
    ProvisioningPlan에서 AttributeRequest.op별 entitlement value 건수 반환.

    Returns: {op: count}
      op 예시: 'Add', 'Remove', 'Set', 'Retain' 등
      multi-value List는 String 개수로 개별 카운트.
    """
    result: dict = defaultdict(int)
    if plan_elem is None:
        return result
    for attr_req in plan_elem.findall(".//AttributeRequest"):
        op = attr_req.get("op", "unknown")
        result[op] += _count_attr_request_values(attr_req)
    return result


# ─── 출력 헬퍼 ────────────────────────────────────────────────────────────────
W = 130

def sep(char="─"):
    print(char * W)

def header(title: str):
    print()
    sep("═")
    print(f"  {title}")
    sep("═")

def fmt(n) -> str:
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return str(n)

def ts_to_str(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S")


# ─── 출력 섹션 ────────────────────────────────────────────────────────────────
def print_summary(rows: list):
    header("■ Application별 / Source별 트랜잭션 건수  [SQL 집계]")
    print(f"  {'Application':<45} {'Source':<35} {'Count':>10}")
    sep()
    for app, src, cnt in rows:
        print(f"  {str(app):<45} {str(src):<35} {fmt(cnt):>10}")
    sep()
    total = sum(r[2] for r in rows)
    print(f"  {'TOTAL':<82} {fmt(total):>10}")


def print_subtotals_by_application(rows: list):
    header("■ Application별 소계")
    totals: dict = defaultdict(int)
    for app, _, cnt in rows:
        totals[app] += cnt
    print(f"  {'Application':<55} {'Count':>10}")
    sep()
    for app, cnt in sorted(totals.items(), key=lambda x: -x[1]):
        print(f"  {str(app):<55} {fmt(cnt):>10}")
    sep()


def print_subtotals_by_source(rows: list):
    header("■ Source별 소계")
    totals: dict = defaultdict(int)
    for _, src, cnt in rows:
        totals[src] += cnt
    print(f"  {'Source':<50} {'Count':>10}")
    sep()
    for src, cnt in sorted(totals.items(), key=lambda x: -x[1]):
        print(f"  {str(src):<50} {fmt(cnt):>10}")
    sep()


# ─── XML 집계 ─────────────────────────────────────────────────────────────────
def accumulate_xml_stats(chunk,
                         tx_agg:          dict,
                         req_ent_agg:     dict,
                         filtered_ent_agg: dict,
                         counters:        dict):
    """
    fetchmany() 청크를 받아 집계 dict에 누적.

    tx_agg           : {(app, month, src, planResult_status): tx_count}
    req_ent_agg      : {(app, month, src, attr_op): entitlement_count}
    filtered_ent_agg : {(app, month, src, attr_op): entitlement_count}
    counters         : processed / parse_errors / no_attr
    """
    for row in chunk:
        _, app, src, created_ts, attr_xml = row

        # created(Unix ms) → 'YYYY-MM'
        try:
            month = datetime.fromtimestamp(int(created_ts) / 1000).strftime("%Y-%m")
        except (TypeError, ValueError, OSError):
            month = "unknown"

        dim3 = (str(app), month, str(src))

        if not attr_xml or not attr_xml.strip():
            counters["no_attr"] += 1
            continue

        parsed = parse_attributes(attr_xml)
        if parsed["parse_error"]:
            counters["parse_errors"] += 1
            continue

        # 트랜잭션 건수: (app, month, src, planResult)
        ps = plan_result_status(parsed["planResult"])
        tx_agg[(*dim3, ps)] += 1

        # request plan: AttributeRequest.op별 entitlement 건수
        for op, cnt in get_entitlements_by_op(parsed["request"]).items():
            req_ent_agg[(*dim3, op, ps)] += cnt

        # filtered plan: AttributeRequest.op별 entitlement 건수
        for op, cnt in get_entitlements_by_op(parsed["filtered"]).items():
            filtered_ent_agg[(*dim3, op, ps)] += cnt

        counters["processed"] += 1


# ─── XML 출력 ─────────────────────────────────────────────────────────────────
def print_xml_results(tx_agg:          dict,
                      req_ent_agg:     dict,
                      filtered_ent_agg: dict,
                      counters:        dict,
                      total_fetched:   int):

    col_app   = 30
    col_month = 9
    col_src   = 25
    col_op    = 12
    col_num   = 12

    header("■ XML 분석 — Application / 월 / Source / planResult별 트랜잭션 건수")
    print(
        f"  fetch: {fmt(total_fetched)}건  "
        f"처리: {fmt(counters['processed'])}건  "
        f"파싱오류: {fmt(counters['parse_errors'])}건  "
        f"attributes없음: {fmt(counters['no_attr'])}건\n"
    )

    # ── 트랜잭션 건수표 (app / month / src / planResult) ──────────────────────
    print(
        f"  {'Application':<{col_app}} {'Month':<{col_month}} {'Source':<{col_src}}"
        f" {'planResult':<{col_op}} {'Tx Count':>{col_num}}"
    )
    sep()

    grand_tx = 0
    for key in sorted(tx_agg.keys()):
        app, month, src, ps = key
        cnt = tx_agg[key]
        grand_tx += cnt
        print(
            f"  {app:<{col_app}} {month:<{col_month}} {src:<{col_src}}"
            f" {ps:<{col_op}} {fmt(cnt):>{col_num}}"
        )
    sep()
    lw = col_app + col_month + col_src + col_op + 3
    print(f"  {'TOTAL':<{lw}} {fmt(grand_tx):>{col_num}}")
    sep()

    # ── planResult 소계 ──────────────────────────────────────────────────────
    pr_totals: dict = defaultdict(int)
    for (_, _, _, ps), cnt in tx_agg.items():
        pr_totals[ps] += cnt

    header("■ planResult 전체 소계")
    print(f"  {'planResult':<{col_op}} {'Tx Count':>{col_num}}")
    sep()
    for ps, cnt in sorted(pr_totals.items(), key=lambda x: -x[1]):
        print(f"  {ps:<{col_op}} {fmt(cnt):>{col_num}}")
    sep()
    print(f"  {'TOTAL':<{col_op}} {fmt(grand_tx):>{col_num}}")
    sep()

    # ── request plan: AttributeRequest.op별 entitlement 건수 ─────────────────
    col_pr         = 12
    req_total      = sum(req_ent_agg.values())
    filtered_total = sum(filtered_ent_agg.values())

    if req_total > 0 or filtered_total > 0:
        all_ent_keys = sorted(set(req_ent_agg.keys()) | set(filtered_ent_agg.keys()))
        header("■ Entitlement 건수  (Application / 월 / Source / op / planResult)")
        print(
            f"  {'Application':<{col_app}} {'Month':<{col_month}} {'Source':<{col_src}}"
            f" {'op':<{col_op}} {'planResult':<{col_pr}} {'Request':>{col_num}} {'Filtered':>{col_num}}"
        )
        sep()
        for key in all_ent_keys:
            app, month, src, op, ps = key
            req_cnt = req_ent_agg.get(key, 0)
            fil_cnt = filtered_ent_agg.get(key, 0)
            print(
                f"  {app:<{col_app}} {month:<{col_month}} {src:<{col_src}}"
                f" {op:<{col_op}} {ps:<{col_pr}} {fmt(req_cnt):>{col_num}} {fmt(fil_cnt):>{col_num}}"
            )
        sep()
        elw = col_app + col_month + col_src + col_op + col_pr + 4
        print(f"  {'TOTAL':<{elw}} {fmt(req_total):>{col_num}} {fmt(filtered_total):>{col_num}}")
        sep()

        # op 소계
        op_req: dict = defaultdict(int)
        op_fil: dict = defaultdict(int)
        for (_, _, _, op, _), cnt in req_ent_agg.items():
            op_req[op] += cnt
        for (_, _, _, op, _), cnt in filtered_ent_agg.items():
            op_fil[op] += cnt
        all_ops = sorted(set(op_req.keys()) | set(op_fil.keys()))

        print(f"\n  [op 소계]")
        print(f"  {'op':<{col_op}} {'Request':>{col_num}} {'Filtered':>{col_num}}")
        sep()
        for op in all_ops:
            print(f"  {op:<{col_op}} {fmt(op_req.get(op, 0)):>{col_num}} {fmt(op_fil.get(op, 0)):>{col_num}}")
        sep()
        print(f"  {'TOTAL':<{col_op}} {fmt(req_total):>{col_num}} {fmt(filtered_total):>{col_num}}")
        sep()


# ─── 메인 ─────────────────────────────────────────────────────────────────────
def main():
    args = parse_args()
    start_ts, end_ts = args.start, args.end

    sep("═")
    print("  SailPoint IdentityIQ 8.4p2 — spt_provisioning_transaction 분석")
    print(f"  대상  : {SERVER}:{PORT} / {DATABASE}")
    print(f"  기간  : {ts_to_str(start_ts)}  ~  {ts_to_str(end_ts)}")
    print(f"         ({start_ts}  ~  {end_ts}  ms)")
    print(f"  실행  : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    sep("═")

    # ── 1. DB 연결 ────────────────────────────────────────────────────────────
    print("\n[1/3] DB 연결 중...")
    try:
        conn = get_connection()
    except Exception as exc:
        sys.exit(f"[오류] DB 연결 실패: {exc}")
    cursor = conn.cursor()
    print("      연결 성공")

    # ── 2. SQL 집계 쿼리 (별도 커서) ────────────────────────────────────────
    print("\n[2/3] Application / Source별 건수 조회 (SQL)...")
    cur_summary = conn.cursor()
    try:
        cur_summary.execute(SUMMARY_SQL, (start_ts, end_ts))
        summary_rows = cur_summary.fetchall()
    except Exception as exc:
        conn.close()
        sys.exit(f"[오류] 집계 쿼리 실패: {exc}")
    finally:
        cur_summary.close()

    if not summary_rows:
        print("  → 데이터 없음")
    else:
        print_summary(summary_rows)
        print_subtotals_by_application(summary_rows)
        print_subtotals_by_source(summary_rows)

    # ── 3. XML 파싱 (별도 커서, 청크 fetch) ──────────────────────────────────
    print(f"\n[3/3] XML attributes 파싱 (청크 단위: {FETCH_CHUNK_SIZE:,}건)...")
    cur_detail = conn.cursor()
    try:
        cur_detail.execute(DETAIL_SQL, (start_ts, end_ts))
    except Exception as exc:
        conn.close()
        sys.exit(f"[오류] 상세 쿼리 실패: {exc}")

    tx_agg:           dict = defaultdict(int)
    req_ent_agg:      dict = defaultdict(int)
    filtered_ent_agg: dict = defaultdict(int)
    counters = {"processed": 0, "parse_errors": 0, "no_attr": 0}
    total_fetched = 0

    while True:
        try:
            chunk = cur_detail.fetchmany(FETCH_CHUNK_SIZE)
        except Exception as exc:
            conn.close()
            sys.exit(f"[오류] fetchmany 실패: {exc}")

        if not chunk:
            break

        total_fetched += len(chunk)
        print(f"\r  fetch 중... {total_fetched:,}건", end="", flush=True)
        accumulate_xml_stats(chunk, tx_agg, req_ent_agg, filtered_ent_agg, counters)

    print(f"\r  fetch 완료: {total_fetched:,}건  "
          f"(처리: {counters['processed']}  "
          f"파싱오류: {counters['parse_errors']}  "
          f"attributes없음: {counters['no_attr']})")

    cur_detail.close()
    conn.close()

    if total_fetched == 0:
        print("  → 데이터 없음")
    else:
        print_xml_results(tx_agg, req_ent_agg, filtered_ent_agg, counters, total_fetched)

    print("\n완료.")


if __name__ == "__main__":
    main()
