"""Generate one simulated month (September 2026) of Snowflake ACCOUNT_USAGE logs.

The brief asks for SQL "against simulated Snowflake ACCOUNT_USAGE logs" but gives no
logs, so this script builds them, tied to the case-study monitoring CSV so the
attribution results can be cross-checked against it.

Deterministic: a fixed seed, so every run writes identical files.

Calibration (per report, from the monitoring CSV):
  reference credits = the report's most recent NON-negative snowflake_credits_consumed
  active views      = monthly_active_views of that same snapshot
  queries           = query_count_last_30d of that snapshot / QUERY_SCALE (min 20)
On one warehouse, credits follow execution time, so each warehouse has one rate
(credits per ms of execution) and a report's total execution time is proportional to
its reference credits. Per-query credits become QUERY_ATTRIBUTION_HISTORY (which
excludes idle time). Warehouse
metering per hour = the active credits in that hour plus idle time, so that the
fully loaded attribution per report lands close to the reference value.

Injected log anomalies (the SQL suite must find them):
  untagged queries, malformed tag JSON, tags pointing at an unknown report,
  duplicate query rows, negative metering rows (mirrors the CSV defect).

Usage: python snowflake/generate_data.py   (writes snowflake/data/*.csv)
"""

from __future__ import annotations

import csv
import json
import random
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

SEED = 20260930
QUERY_SCALE = 50  # 1 simulated query represents 50 real ones (keeps the files small)
MONTH_START = datetime(2026, 9, 1)
DAYS = 30
CREDIT_PRICE_USD = 3.00  # same assumption as the dashboard

# Warehouses: reports are assigned by size of their credit usage.
WAREHOUSES = {
    "BI_WH_S": "SMALL",
    "BI_WH_M": "MEDIUM",
    "BI_WH_L": "LARGE",
    "ADHOC_WH": "XSMALL",  # analysts' ad hoc queries (untagged)
}

ROOT = Path(__file__).resolve().parent
CSV_IN = ROOT.parent / "data" / "Case_Study_3_Pure_Insights_Monitoring.csv"
OUT = ROOT / "data"

INJECT = {
    "untagged": 300,
    "malformed_tag": 25,
    "unknown_report": 15,
    "duplicate_rows": 30,
    "negative_metering_rows": 6,
}


def load_reports() -> list[dict]:
    rows = list(csv.DictReader(CSV_IN.open(encoding="utf-8")))
    latest: dict[str, dict] = {}
    for row in rows:  # file order = time order (20 round-robin snapshots)
        if float(row["snowflake_credits_consumed"]) >= 0:
            latest[row["report_id"]] = row
    reports = []
    for rid in sorted(latest):
        r = latest[rid]
        owner = r["owner_email"].strip()
        reports.append(
            {
                "report_id": rid,
                "report_name": r["report_name"],
                "owner_email": None if owner.lower() in ("", "nan", "orphaned_report") else owner,
                "reference_credits": float(r["snowflake_credits_consumed"]),
                "active_views": int(r["monthly_active_views"]),
                "queries": max(20, round(int(r["query_count_last_30d"]) / QUERY_SCALE)),
            }
        )
    # Bigger consumers run on bigger warehouses
    by_credits = sorted(reports, key=lambda x: x["reference_credits"])
    for i, r in enumerate(by_credits):
        r["warehouse_name"] = "BI_WH_S" if i < 40 else "BI_WH_M" if i < 80 else "BI_WH_L"
    return reports


def business_time(rng: random.Random) -> datetime:
    """A start time weighted towards working hours, guaranteed to leave room before the hour ends."""
    day = rng.randrange(DAYS)
    hour = int(min(23, max(0, rng.gauss(13, 3.5))))
    minute = rng.randrange(0, 55)
    second = rng.randrange(60)
    return MONTH_START + timedelta(days=day, hours=hour, minutes=minute, seconds=second)


def main() -> None:
    rng = random.Random(SEED)
    reports = load_reports()
    OUT.mkdir(parents=True, exist_ok=True)

    queries: list[dict] = []
    attribution: list[dict] = []
    active_by_hour: dict[tuple[str, datetime], float] = defaultdict(float)
    qid = 0

    def add_query(report_id: str | None, tag: str | None, warehouse: str, exec_ms: int, start: datetime, credits: float, user: str) -> dict:
        nonlocal qid
        qid += 1
        # Queries never cross an hour boundary (start minute < 55, exec < 5 min).
        end = start + timedelta(milliseconds=exec_ms + rng.randrange(50, 400))
        status = "FAILED" if rng.random() < 0.02 else "SUCCESS"
        q = {
            "query_id": f"01b{qid:07d}",
            "query_text": f"SELECT ... /* {report_id or 'ad hoc'} */",
            "query_tag": tag,
            "user_name": user,
            "role_name": "PORTAL_SVC" if user == "PORTAL_SVC" else "ANALYST",
            "warehouse_name": warehouse,
            "warehouse_size": WAREHOUSES[warehouse],
            "execution_status": status,
            "start_time": start.isoformat(sep=" "),
            "end_time": end.isoformat(sep=" ", timespec="milliseconds"),
            "total_elapsed_time": int((end - start).total_seconds() * 1000),
            "execution_time": exec_ms,
            "bytes_scanned": rng.randrange(10_000, 900_000_000),
            "credits_used_cloud_services": round(credits * rng.uniform(0.02, 0.06), 6),
        }
        queries.append(q)
        attribution.append(
            {
                "query_id": q["query_id"],
                "warehouse_name": warehouse,
                "start_time": q["start_time"],
                "end_time": q["end_time"],
                "credits_attributed_compute": round(credits, 6),
            }
        )
        active_by_hour[(warehouse, start.replace(minute=0, second=0, microsecond=0))] += credits
        return q

    # Portal queries, tagged with the report id.
    # On one warehouse, credits follow execution time (that is how a warehouse bills),
    # so each warehouse gets one rate: credits per millisecond of execution. Each
    # report's execution times are drawn, then scaled so its total execution time is
    # proportional to its reference credits. 85% of a report's credits are active
    # compute; the warehouse idle time added below brings it back to about 100%.
    rate_ms: dict[str, float] = {"ADHOC_WH": 1 / 3_600_000}  # XSMALL: 1 credit per hour of execution
    for wh in ("BI_WH_S", "BI_WH_M", "BI_WH_L"):
        group = [r for r in reports if r["warehouse_name"] == wh and r["reference_credits"] > 0]
        # ms of execution per credit, chosen so no report needs queries longer than 150 s on average
        ms_per_credit = min(150_000 * r["queries"] / r["reference_credits"] for r in group)
        rate_ms[wh] = 1 / ms_per_credit
    for r in reports:
        target_ms = r["reference_credits"] / rate_ms[r["warehouse_name"]]
        raw = [rng.lognormvariate(0, 0.8) for _ in range(r["queries"])]
        execs = [x * target_ms / sum(raw) for x in raw]
        for _ in range(5):  # keep queries between 50 ms and 290 s while preserving the total
            execs = [min(290_000, max(50, e)) for e in execs]
            execs = [e * target_ms / sum(execs) for e in execs]
        execs = [max(50, min(290_000, int(round(e)))) for e in execs]
        total = sum(execs)
        active = r["reference_credits"] * 0.85
        for e in execs:
            tag = json.dumps({"app": "pure-insights", "report_id": r["report_id"]})
            add_query(r["report_id"], tag, r["warehouse_name"], e, business_time(rng), active * e / total, "PORTAL_SVC")

    def adhoc_credits(warehouse: str, exec_ms: int) -> float:
        return 0.85 * exec_ms * rate_ms[warehouse]

    # Ad hoc analyst queries without a tag (mostly on ADHOC_WH, some on BI warehouses)
    for i in range(INJECT["untagged"]):
        wh = "ADHOC_WH" if i % 3 else rng.choice(["BI_WH_S", "BI_WH_M", "BI_WH_L"])
        e = rng.randint(2_000, 200_000)
        add_query(None, None if i % 2 else "", wh, e, business_time(rng), adhoc_credits(wh, e), f"ANALYST_{i % 7 + 1}")

    # Portal bug: truncated tag JSON
    for i in range(INJECT["malformed_tag"]):
        r = rng.choice(reports)
        broken = json.dumps({"app": "pure-insights", "report_id": r["report_id"]})[:-9]
        e = rng.randint(1_000, 60_000)
        add_query(None, broken, r["warehouse_name"], e, business_time(rng), adhoc_credits(r["warehouse_name"], e), "PORTAL_SVC")

    # Tag points at a report that is not in the registry (deleted report)
    for _ in range(INJECT["unknown_report"]):
        e = rng.randint(1_000, 60_000)
        add_query(None, json.dumps({"app": "pure-insights", "report_id": "RPT_999"}), "BI_WH_S", e, business_time(rng), adhoc_credits("BI_WH_S", e), "PORTAL_SVC")

    # Metering: every hour with queries gets active credits plus 5-25% idle on top.
    metering: list[dict] = []
    for (wh, hour), active in sorted(active_by_hour.items()):
        idle_fraction = rng.uniform(0.05, 0.25)
        compute = active / (1 - idle_fraction)
        metering.append(
            {
                "start_time": hour.isoformat(sep=" "),
                "end_time": (hour + timedelta(hours=1)).isoformat(sep=" "),
                "warehouse_name": wh,
                "credits_used_compute": round(compute, 6),
                "credits_used_cloud_services": 0.0,
                "credits_used": round(compute, 6),
            }
        )
    # Idle-only hours: the warehouse stayed up after its last query (auto-suspend lag)
    used_hours = set(active_by_hour)
    for wh in ("BI_WH_S", "BI_WH_M", "BI_WH_L"):
        added = 0
        while added < 12:
            hour = MONTH_START + timedelta(days=rng.randrange(DAYS), hours=rng.choice([0, 1, 2, 3, 4, 22, 23]))
            if (wh, hour) in used_hours:
                continue
            used_hours.add((wh, hour))
            credits = round(rng.uniform(0.2, 1.5), 6)
            metering.append(
                {
                    "start_time": hour.isoformat(sep=" "),
                    "end_time": (hour + timedelta(hours=1)).isoformat(sep=" "),
                    "warehouse_name": wh,
                    "credits_used_compute": credits,
                    "credits_used_cloud_services": 0.0,
                    "credits_used": credits,
                }
            )
            added += 1
    # Negative metering rows (billing adjustment / ingestion error), on existing hours
    for m in rng.sample([m for m in metering if m["warehouse_name"] != "ADHOC_WH"], INJECT["negative_metering_rows"]):
        value = -round(rng.uniform(1.0, 13.6), 6)
        metering.append({**m, "credits_used_compute": value, "credits_used": value})
    metering.sort(key=lambda m: (m["start_time"], m["warehouse_name"], m["credits_used"]))

    # Duplicate rows (the same query loaded twice by an ETL retry)
    for q in rng.sample(queries[: len(queries) - 400], INJECT["duplicate_rows"]):
        queries.append(dict(q))
    queries.sort(key=lambda q: (q["start_time"], q["query_id"]))

    def write(name: str, rows: list[dict]) -> None:
        with (OUT / name).open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
            w.writeheader()
            for row in rows:
                w.writerow({k: ("" if v is None else v) for k, v in row.items()})

    write("query_history.csv", queries)
    write("query_attribution_history.csv", sorted(attribution, key=lambda a: a["query_id"]))
    write("warehouse_metering_history.csv", metering)
    write(
        "report_registry.csv",
        [{k: r[k] for k in ("report_id", "report_name", "owner_email", "warehouse_name")} for r in reports],
    )
    write("report_usage_monthly.csv", [{"report_id": r["report_id"], "month": "2026-09-01", "active_views": r["active_views"]} for r in reports])
    write("monitoring_reference.csv", [{"report_id": r["report_id"], "reference_credits": r["reference_credits"]} for r in reports])
    write("cost_config.csv", [{"credit_price_usd": CREDIT_PRICE_USD, "period_start": "2026-09-01", "period_end": "2026-10-01"}])

    print(f"queries={len(queries)} (incl. {INJECT['duplicate_rows']} duplicates)  metering_rows={len(metering)}  reports={len(reports)}")


if __name__ == "__main__":
    main()
