"""Run the Snowflake SQL suite locally on DuckDB and export the results.

There is no Snowflake account in this project, so the SAME .sql files are executed
on DuckDB. The Snowflake files stay the source of truth; this runner only applies
three mechanical, documented rewrites for syntax DuckDB does not have:

  1. TRY_PARSE_JSON(col):key::STRING  ->  CASE WHEN json_valid(col) THEN json_extract_string(col, '$.key') END
  2. TIMESTAMP_NTZ                    ->  TIMESTAMP
  3. NUMBER(p, s)                     ->  DECIMAL(p, s)

Statements marked `-- @snowflake-only` (CREATE DATABASE/WAREHOUSE, stages, COPY INTO)
are skipped and listed. Data is loaded from CSV instead.

Usage:
  python snowflake/verify/run_local.py                 # generated data -> snowflake/output/
  python snowflake/verify/run_local.py --data DIR --no-export   (used by the tests)
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
SQL_DIR = ROOT / "sql"
TABLES = [
    "query_history",
    "query_attribution_history",
    "warehouse_metering_history",
    "report_registry",
    "report_usage_monthly",
    "monitoring_reference",
    "cost_config",
]

_JSON_PATH = re.compile(r"TRY_PARSE_JSON\((\w+(?:\.\w+)?)\):(\w+)::STRING", re.IGNORECASE)


def to_duckdb(sql: str) -> str:
    sql = _JSON_PATH.sub(r"CASE WHEN json_valid(\1) THEN json_extract_string(\1, '$.\2') END", sql)
    sql = re.sub(r"\bTIMESTAMP_NTZ\b", "TIMESTAMP", sql, flags=re.IGNORECASE)
    sql = re.sub(r"\bNUMBER\s*\(", "DECIMAL(", sql, flags=re.IGNORECASE)
    return sql


def split_statements(text: str) -> list[str]:
    """Split on semicolons outside quotes and comments; keep comments with their statement."""
    out, buf, i, in_str = [], [], 0, False
    while i < len(text):
        ch = text[i]
        if in_str:
            buf.append(ch)
            if ch == "'":
                if i + 1 < len(text) and text[i + 1] == "'":
                    buf.append("'")
                    i += 1
                else:
                    in_str = False
        elif ch == "'":
            in_str = True
            buf.append(ch)
        elif text.startswith("--", i):
            end = text.find("\n", i)
            end = len(text) if end == -1 else end
            buf.append(text[i:end])
            i = end - 1
        elif ch == ";":
            out.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    if "".join(buf).strip():
        out.append("".join(buf))
    return [s for s in out if re.sub(r"--[^\n]*", "", s).strip()]


def run_suite(data_dir: Path) -> tuple[duckdb.DuckDBPyConnection, list[str]]:
    con = duckdb.connect()
    skipped: list[str] = []
    for path in sorted(SQL_DIR.glob("*.sql")):
        for stmt in split_statements(path.read_text(encoding="utf-8")):
            first_line = next(l.strip() for l in re.sub(r"--[^\n]*", "", stmt).splitlines() if l.strip())
            if "@snowflake-only" in stmt:
                skipped.append(f"{path.name}: {first_line[:70]}")
                continue
            con.execute(to_duckdb(stmt))
        if path.name == "01_ddl.sql":  # tables exist now: load the CSVs
            for table in TABLES:
                csv_path = data_dir / f"{table}.csv"
                con.execute(f"COPY {table} FROM '{csv_path.as_posix()}' (HEADER true, NULLSTR '')")
    return con, skipped


def rows(con: duckdb.DuckDBPyConnection, sql: str) -> list[dict]:
    cur = con.execute(sql)
    cols = [d[0].lower() for d in cur.description]
    return [dict(zip(cols, (_plain(v) for v in r))) for r in cur.fetchall()]


def _plain(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return v


def export(con: duckdb.DuckDBPyConnection, skipped: list[str], out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    config = rows(con, "SELECT * FROM cost_config")[0]
    reconciliation = rows(con, "SELECT * FROM reconciliation ORDER BY warehouse_name = 'TOTAL', warehouse_name")
    total = next(r for r in reconciliation if r["warehouse_name"] == "TOTAL")
    per_report = rows(
        con,
        """SELECT u.*, x.monitoring_credits, x.diff_pct AS cross_check_diff_pct, x.result AS cross_check_result
           FROM report_unit_cost u LEFT JOIN cross_check x USING (report_id)
           ORDER BY u.cost_per_view_rank, u.report_id""",
    )
    unattributed = rows(con, "SELECT * FROM unattributed_spend ORDER BY compute_credits DESC")
    concentration = rows(con, "SELECT * FROM spend_concentration")[0]
    orphaned = rows(con, "SELECT * FROM orphaned_spend")[0]
    findings = rows(con, "SELECT * FROM dq_findings")
    waste = rows(con, "SELECT * FROM waste_candidates ORDER BY cost_usd DESC")
    trend = rows(con, "SELECT * FROM daily_cost_trend ORDER BY usage_day")
    cross = rows(con, "SELECT result, COUNT(*) AS reports FROM cross_check GROUP BY result ORDER BY result")
    price = config["credit_price_usd"]
    total_credits = rows(con, "SELECT SUM(total_credits) AS t, SUM(cloud_services_credits) AS c FROM report_credit_attribution")[0]

    result = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "period": {"start": config["period_start"], "end": config["period_end"]},
        "engine": "DuckDB (local verification of the Snowflake SQL suite)",
        "assumptions": {
            "credit_price_usd": price,
            "allocation_rule": "Each warehouse-hour's metered compute credits split across its queries by execution time (method A, fully loaded)",
            "idle_policy": "Idle time inside an hour follows the work in that hour; idle-only hours are shared by monthly execution share per warehouse",
            "query_to_report_link": "QUERY_TAG JSON set by the portal: {\"app\":\"pure-insights\",\"report_id\":...}",
            "cross_check": "Method B = QUERY_ATTRIBUTION_HISTORY (active compute only, no idle)",
        },
        "summary": {
            "metered_compute_credits": total["metered_compute"],
            "attributed_to_reports_credits": total["attributed_to_reports"],
            "unattributed_credits": total["unattributed"],
            "active_compute_credits": total["active_compute"],
            "idle_compute_credits": total["idle_compute"],
            "utilisation_pct": total["utilisation_pct"],
            "negative_rows_excluded": total["negative_rows_excluded"],
            "negative_credits_excluded": total["negative_credits_excluded"],
            "reconciliation_difference": total["difference"],
            "report_cloud_services_credits": round(total_credits["c"], 6),
            "report_total_credits": round(total_credits["t"], 6),
            "report_total_cost_usd": round(total_credits["t"] * price, 2),
            "unattributed_cost_usd": round(total["unattributed"] * price, 2),
        },
        "warehouses": [r for r in reconciliation if r["warehouse_name"] != "TOTAL"],
        "unattributed": unattributed,
        "per_report": per_report,
        "data_quality_findings": findings,
        "insights": {
            "spend_concentration": concentration,
            "orphaned_spend": orphaned,
            "waste_candidates": waste,
            "cross_check": cross,
        },
        "daily_trend": trend,
        "skipped_snowflake_only_statements": skipped,
    }
    (out_dir / "attribution_results.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    for name, data in [("report_unit_cost.csv", per_report), ("reconciliation.csv", reconciliation), ("data_quality_findings.csv", findings)]:
        with (out_dir / name).open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys()), lineterminator="\n")
            w.writeheader()
            w.writerows(data)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    parser.add_argument("--out", type=Path, default=ROOT / "output")
    parser.add_argument("--no-export", action="store_true")
    args = parser.parse_args()

    con, skipped = run_suite(args.data)
    print(f"Ran every file in {SQL_DIR.relative_to(ROOT.parent)} on DuckDB {duckdb.__version__}.")
    print(f"Skipped {len(skipped)} Snowflake-only statements (setup, stage, COPY INTO).")
    recon = rows(con, "SELECT * FROM reconciliation WHERE warehouse_name = 'TOTAL'")[0]
    print(
        f"Metered {recon['metered_compute']:.2f} credits = reports {recon['attributed_to_reports']:.2f} "
        f"+ unattributed {recon['unattributed']:.2f} (difference {recon['difference']}). "
        f"Active {recon['active_compute']:.2f}, idle {recon['idle_compute']:.2f}, utilisation {recon['utilisation_pct']}%."
    )
    for f in rows(con, "SELECT check_name, affected_rows FROM dq_findings"):
        print(f"  {f['check_name']:<26} {f['affected_rows']}")
    if not args.no_export:
        export(con, skipped, args.out)
        print(f"Wrote {args.out.relative_to(ROOT.parent)}/attribution_results.json and CSVs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
