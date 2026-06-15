import csv
import glob
import json
import math
import os
import re
import statistics
from collections import Counter, defaultdict

OUTDIR = "analysis/window_shift_regression"
os.makedirs(OUTDIR, exist_ok=True)

LOG_GLOBS = ["logs.*.log", "logs.*.json"]

# Cohort split for extraction-era comparison in available corpus.
# This can be adjusted as needed.
CHANGE_DATE = "2026-06-01"
PRE_SAMPLE_TARGET = 30
POST_SAMPLE_TARGET = 30


def percentile(values, p):
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] * (c - k) + s[c] * (k - f)


def stats(values):
    if not values:
        return {
            "n": 0,
            "min": None,
            "median": None,
            "mean": None,
            "p75": None,
            "p90": None,
            "p95": None,
            "max": None,
        }
    return {
        "n": len(values),
        "min": min(values),
        "median": statistics.median(values),
        "mean": statistics.mean(values),
        "p75": percentile(values, 0.75),
        "p90": percentile(values, 0.90),
        "p95": percentile(values, 0.95),
        "max": max(values),
    }


def fmt(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.3f}"
    return str(v)


def to_float_or_none(v):
    try:
        return float(v)
    except Exception:
        return None


def parse_json_suffix(line):
    i = line.find("{")
    if i < 0:
        return None
    try:
        return json.loads(line[i:])
    except Exception:
        return None


files = []
for pattern in LOG_GLOBS:
    files.extend(glob.glob(pattern))
files = sorted(set(files))

job = defaultdict(
    lambda: {
        "jobId": None,
        "first_ts": None,
        "source_file": None,
        "baseline_mode": None,
        "baseline_count": None,
        "candidate_count": None,
        "opening_resize_pct": None,
        "opening_visibility_reduction_pct": None,
        "opening_relocated_count": 0,
        "opening_issue_types": set(),
        "opening_hardFail": None,
        "unified_score": None,
        "unified_verdict": None,
        "unified_hardFail": None,
        "final_outcome": None,
        "room_type": None,
        "processing_mode": None,
        "retry_attempt": None,
    }
)

job_id_re = re.compile(r"\b(job_[0-9a-f\-]{8,})\b")
ts_re = re.compile(r"^(\d{4}-\d{2}-\d{2}T[^ ]+)")
score_re = re.compile(r"verdict=(PASS|FAIL) score=([0-9.]+) jobId=(job_[0-9a-f\-]+)")
room_re = re.compile(r"\bRoom:\s*([a-zA-Z_ ]+)")
resize_re = re.compile(r"opening_size_reduction_ge_[0-9.]+:([0-9.]+)|opening_resized_minor:([0-9.]+)")
vis_re = re.compile(r"opening_visibility_reduction:([0-9.]+)")


def ensure(jid, ts=None, src=None):
    d = job[jid]
    d["jobId"] = jid
    if ts and d["first_ts"] is None:
        d["first_ts"] = ts
    if src and d["source_file"] is None:
        d["source_file"] = src
    return d


for fp in files:
    if fp.endswith(".json"):
        try:
            with open(fp, "r", errors="ignore") as f:
                payload = json.load(f)
            if isinstance(payload, list):
                lines = []
                for item in payload:
                    if not isinstance(item, dict):
                        continue
                    ts = item.get("timestamp", "")
                    msg = item.get("message", "")
                    if msg:
                        lines.append(f"{ts} [inf] {msg}")
            else:
                with open(fp, "r", errors="ignore") as f:
                    lines = f.readlines()
        except Exception:
            with open(fp, "r", errors="ignore") as f:
                lines = f.readlines()
    else:
        with open(fp, "r", errors="ignore") as f:
            lines = f.readlines()

    current_job = None
    for raw in lines:
        line = raw.rstrip("\n")
        tm = ts_re.match(line)
        ts = tm.group(1) if tm else None

        m = score_re.search(line)
        if m:
            verdict, score, jid = m.groups()
            d = ensure(jid, ts, fp)
            d["unified_verdict"] = verdict.lower()
            d["unified_score"] = float(score)
            current_job = jid

        ids = job_id_re.findall(line)
        if ids:
            current_job = ids[-1]
            ensure(current_job, ts, fp)

        if not current_job:
            continue

        d = ensure(current_job, ts, fp)

        if "Room:" in line:
            rm = room_re.search(line)
            if rm:
                d["room_type"] = rm.group(1).strip().lower().replace(" ", "_")

        if "stage2-only retry" in line or "stage2_only_retry" in line:
            d["processing_mode"] = "retry_stage2_only"
        elif "refresh" in line.lower() and d["processing_mode"] is None:
            d["processing_mode"] = "refresh"
        elif "sourceStage: 'original'" in line and d["processing_mode"] is None:
            d["processing_mode"] = "from_empty_or_initial"

        am = re.search(r"\battempt\s*[:=]\s*([0-9]+)", line, re.I)
        if am:
            d["retry_attempt"] = int(am.group(1))

        if "[OPENING_BASELINE_MODE]" in line:
            obj = parse_json_suffix(line)
            if isinstance(obj, dict):
                jid = obj.get("jobId") or current_job
                dd = ensure(jid, ts, fp)
                mode = obj.get("mode")
                if isinstance(mode, str):
                    dd["baseline_mode"] = mode

        if "[OPENING_RECONCILIATION_TRACE]" in line:
            obj = parse_json_suffix(line)
            if isinstance(obj, dict):
                jid = obj.get("jobId") or current_job
                dd = ensure(jid, ts, fp)
                if isinstance(obj.get("baselineOpeningCount"), int):
                    dd["baseline_count"] = obj["baselineOpeningCount"]
                if isinstance(obj.get("detectedOpeningCount"), int):
                    dd["candidate_count"] = obj["detectedOpeningCount"]

        if "[OPENING_VALIDATION]" in line:
            if "wall_index_changed" in line or "opening_relocated" in line or "horizontal_band_changed" in line:
                d["opening_relocated_count"] += 1

        rz = resize_re.search(line)
        if rz:
            v = rz.group(1) or rz.group(2)
            fv = to_float_or_none(v)
            if fv is not None:
                pct = fv * 100.0
                if d["opening_resize_pct"] is None or pct > d["opening_resize_pct"]:
                    d["opening_resize_pct"] = pct

        vs = vis_re.search(line)
        if vs:
            fv = to_float_or_none(vs.group(1))
            if fv is not None:
                pct = fv * 100.0
                if d["opening_visibility_reduction_pct"] is None or pct > d["opening_visibility_reduction_pct"]:
                    d["opening_visibility_reduction_pct"] = pct

        for token in [
            "opening_occlusion",
            "opening_relocated",
            "opening_removed",
            "opening_resized_major",
            "opening_resized_minor",
            "opening_resized",
        ]:
            if token in line:
                d["opening_issue_types"].add(token)

        if "[SPECIALIST_REVIEW][OPENING]" in line and "hardFail" in line:
            if "hardFail: true" in line or '"hardFail":true' in line:
                d["opening_hardFail"] = True
            elif "hardFail: false" in line or '"hardFail":false' in line:
                d["opening_hardFail"] = False

        if "[UNIFIED_ENFORCEMENT]" in line:
            if "passed: true" in line or '"passed":true' in line:
                d["unified_verdict"] = "pass"
            elif "passed: false" in line or '"passed":false' in line:
                d["unified_verdict"] = "fail"
            if "hardFail: true" in line or '"hardFail":true' in line:
                d["unified_hardFail"] = True
            elif "hardFail: false" in line or '"hardFail":false' in line:
                d["unified_hardFail"] = False

        if "status=complete" in line or "newStatus: 'complete'" in line or "[JOB_FINAL]" in line and "status=complete" in line:
            d["final_outcome"] = "complete"
        if "status=failed" in line or "newStatus: 'failed'" in line or "[JOB_FINAL]" in line and "status=failed" in line:
            d["final_outcome"] = "failed"


rows = []
for jid, d in job.items():
    if not jid:
        continue
    if d["unified_verdict"] is None and d["unified_score"] is None:
        continue

    reloc_pct = None
    if d["baseline_count"] and d["baseline_count"] > 0:
        reloc_pct = (d["opening_relocated_count"] / d["baseline_count"]) * 100.0

    rows.append(
        {
            "jobId": jid,
            "date": (d["first_ts"] or "")[:10],
            "timestamp": d["first_ts"] or "",
            "baseline_mode": d["baseline_mode"] or "unknown",
            "room_type": d["room_type"] or "unknown",
            "processing_mode": d["processing_mode"] or "unknown",
            "retry_attempt": d["retry_attempt"] if d["retry_attempt"] is not None else "",
            "final_outcome": d["final_outcome"] or "unknown",
            "opening_count_baseline": d["baseline_count"] if d["baseline_count"] is not None else "",
            "opening_count_candidate": d["candidate_count"] if d["candidate_count"] is not None else "",
            "opening_resize_pct": round(d["opening_resize_pct"], 3) if d["opening_resize_pct"] is not None else "",
            "opening_visibility_reduction_pct": round(d["opening_visibility_reduction_pct"], 3)
            if d["opening_visibility_reduction_pct"] is not None
            else "",
            "opening_relocation_pct_proxy": round(reloc_pct, 3) if reloc_pct is not None else "",
            "opening_issue_types": "|".join(sorted(d["opening_issue_types"])),
            "opening_hardFail": d["opening_hardFail"] if d["opening_hardFail"] is not None else "",
            "opening_pass": "" if d["opening_hardFail"] is None else (not d["opening_hardFail"]),
            "unified_score": d["unified_score"] if d["unified_score"] is not None else "",
            "unified_verdict": d["unified_verdict"] or "",
            "unified_hardFail": d["unified_hardFail"] if d["unified_hardFail"] is not None else "",
            "source_file": d["source_file"] or "",
        }
    )

rows.sort(key=lambda x: (x["date"], x["timestamp"], x["jobId"]))

# Persist master dataset
master_path = os.path.join(OUTDIR, "opening_distribution_all_rows.csv")
with open(master_path, "w", newline="") as f:
    if rows:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

# Success cohorts for pre/post comparison
success = [r for r in rows if r["unified_verdict"] == "pass" and r["final_outcome"] != "failed"]
pre_all = [r for r in success if r["date"] and r["date"] < CHANGE_DATE]
post_all = [r for r in success if r["date"] and r["date"] >= CHANGE_DATE]

# Deterministic sample with room/mode spread: first by room, then mode, then date

def stratified_sample(items, target):
    if len(items) <= target:
        return items
    by_key = defaultdict(list)
    for r in items:
        key = (r["room_type"], r["processing_mode"])
        by_key[key].append(r)
    keys = sorted(by_key.keys())
    out = []
    idx = 0
    while len(out) < target:
        progressed = False
        for k in keys:
            bucket = by_key[k]
            if idx < len(bucket):
                out.append(bucket[idx])
                progressed = True
                if len(out) >= target:
                    break
        if not progressed:
            break
        idx += 1
    return out


pre_sample = stratified_sample(pre_all, PRE_SAMPLE_TARGET)
post_sample = stratified_sample(post_all, POST_SAMPLE_TARGET)

with open(os.path.join(OUTDIR, "opening_distribution_pre_sample.csv"), "w", newline="") as f:
    if pre_sample:
        writer = csv.DictWriter(f, fieldnames=list(pre_sample[0].keys()))
        writer.writeheader()
        writer.writerows(pre_sample)

with open(os.path.join(OUTDIR, "opening_distribution_post_sample.csv"), "w", newline="") as f:
    if post_sample:
        writer = csv.DictWriter(f, fieldnames=list(post_sample[0].keys()))
        writer.writeheader()
        writer.writerows(post_sample)


# Failed cohort
failed = [r for r in rows if r["final_outcome"] == "failed" or r["unified_verdict"] == "fail"]
with open(os.path.join(OUTDIR, "opening_distribution_failed_cohort.csv"), "w", newline="") as f:
    if failed:
        writer = csv.DictWriter(f, fieldnames=list(failed[0].keys()))
        writer.writeheader()
        writer.writerows(failed)


def collect_numeric(items, key):
    out = []
    for r in items:
        v = r.get(key, "")
        if v == "" or v is None:
            continue
        try:
            out.append(float(v))
        except Exception:
            pass
    return out


pre_resize = collect_numeric(pre_sample, "opening_resize_pct")
post_resize = collect_numeric(post_sample, "opening_resize_pct")
failed_resize = collect_numeric(failed, "opening_resize_pct")

pre_reloc = collect_numeric(pre_sample, "opening_relocation_pct_proxy")
post_reloc = collect_numeric(post_sample, "opening_relocation_pct_proxy")
failed_reloc = collect_numeric(failed, "opening_relocation_pct_proxy")

# Outliers in success cohort
outliers = []
for r in pre_sample + post_sample:
    flags = []
    rz = to_float_or_none(r["opening_resize_pct"])
    rl = to_float_or_none(r["opening_relocation_pct_proxy"])
    if rz is not None:
        for t in [20, 30, 40, 50]:
            if rz > t:
                flags.append(f"resize>{t}")
    if rl is not None:
        for t in [20, 30, 40, 50]:
            if rl > t:
                flags.append(f"relocation>{t}(proxy)")
    if flags:
        out = dict(r)
        out["flags"] = "|".join(flags)
        outliers.append(out)

outlier_path = os.path.join(OUTDIR, "opening_distribution_outliers.csv")
with open(outlier_path, "w", newline="") as f:
    if outliers:
        writer = csv.DictWriter(f, fieldnames=list(outliers[0].keys()))
        writer.writeheader()
        writer.writerows(outliers)


def separation(success_vals, failed_vals):
    if not success_vals or not failed_vals:
        return {"overlap": None, "failed_above_success_p95": None}
    s95 = percentile(success_vals, 0.95)
    overlap_count = sum(1 for v in failed_vals if v <= s95)
    return {
        "overlap": overlap_count / len(failed_vals),
        "failed_above_success_p95": sum(1 for v in failed_vals if v > s95) / len(failed_vals),
        "success_p95": s95,
    }


success_resize = collect_numeric(pre_sample + post_sample, "opening_resize_pct")
success_reloc = collect_numeric(pre_sample + post_sample, "opening_relocation_pct_proxy")

resize_sep = separation(success_resize, failed_resize)
reloc_sep = separation(success_reloc, failed_reloc)

mode_counts_pre = Counter((r["processing_mode"] for r in pre_sample))
mode_counts_post = Counter((r["processing_mode"] for r in post_sample))
room_counts_pre = Counter((r["room_type"] for r in pre_sample))
room_counts_post = Counter((r["room_type"] for r in post_sample))

summary = {
    "source_files": files,
    "total_rows_parsed": len(rows),
    "success_total": len(success),
    "failed_total": len(failed),
    "change_date": CHANGE_DATE,
    "pre_total": len(pre_all),
    "post_total": len(post_all),
    "pre_sample_size": len(pre_sample),
    "post_sample_size": len(post_sample),
    "stats": {
        "pre_resize": stats(pre_resize),
        "post_resize": stats(post_resize),
        "failed_resize": stats(failed_resize),
        "pre_relocation_proxy": stats(pre_reloc),
        "post_relocation_proxy": stats(post_reloc),
        "failed_relocation_proxy": stats(failed_reloc),
    },
    "separation": {
        "resize": resize_sep,
        "relocation_proxy": reloc_sep,
    },
    "mode_mix": {
        "pre": dict(mode_counts_pre),
        "post": dict(mode_counts_post),
    },
    "room_mix": {
        "pre": dict(room_counts_pre),
        "post": dict(room_counts_post),
    },
    "outlier_count": len(outliers),
    "notes": [
        "opening_relocation_pct_proxy is derived from relocation-like OPENING_VALIDATION reasons over baseline opening count",
        "pre/post split is date-based using CHANGE_DATE in this script",
    ],
}

summary_path = os.path.join(OUTDIR, "opening_distribution_summary.json")
with open(summary_path, "w") as f:
    json.dump(summary, f, indent=2)


def threshold_option_block(name, resize_thr, reloc_thr, rationale):
    return {
        "name": name,
        "resize_threshold_pct": resize_thr,
        "relocation_threshold_pct_proxy": reloc_thr,
        "rationale": rationale,
    }


resize_success_p90 = percentile(success_resize, 0.90) if success_resize else None
resize_success_p95 = percentile(success_resize, 0.95) if success_resize else None
resize_failed_p50 = percentile(failed_resize, 0.50) if failed_resize else None

reloc_success_p90 = percentile(success_reloc, 0.90) if success_reloc else None
reloc_success_p95 = percentile(success_reloc, 0.95) if success_reloc else None
reloc_failed_p50 = percentile(failed_reloc, 0.50) if failed_reloc else None

thresholds = [
    threshold_option_block(
        "Option A (Conservative)",
        round(resize_success_p95, 3) if resize_success_p95 is not None else None,
        round(reloc_success_p95, 3) if reloc_success_p95 is not None else None,
        "Set threshold at successful p95 to minimize false positives; will miss moderate anomalies.",
    ),
    threshold_option_block(
        "Option B (Balanced)",
        round(resize_success_p90, 3) if resize_success_p90 is not None else None,
        round(reloc_success_p90, 3) if reloc_success_p90 is not None else None,
        "Set threshold at successful p90 to improve sensitivity while keeping most successful edits unflagged.",
    ),
    threshold_option_block(
        "Option C (Aggressive)",
        round(resize_failed_p50, 3) if resize_failed_p50 is not None else None,
        round(reloc_failed_p50, 3) if reloc_failed_p50 is not None else None,
        "Set threshold near failed median to catch more likely failures, with higher false-positive risk.",
    ),
]

thresholds_path = os.path.join(OUTDIR, "opening_distribution_threshold_options.json")
with open(thresholds_path, "w") as f:
    json.dump(thresholds, f, indent=2)

report_path = os.path.join(OUTDIR, "opening_distribution_report.md")
with open(report_path, "w") as f:
    f.write("# Opening Validator Distribution and Threshold Analysis\n\n")
    f.write("## Cohort Definition\n")
    f.write(f"- Change date split: {CHANGE_DATE}\n")
    f.write(f"- Pre successful sample size: {len(pre_sample)} (from {len(pre_all)} successful jobs)\n")
    f.write(f"- Post successful sample size: {len(post_sample)} (from {len(post_all)} successful jobs)\n")
    f.write(f"- Failed cohort size: {len(failed)}\n\n")

    f.write("## Resize Distribution (pct)\n")
    f.write("| Cohort | n | min | median | mean | p75 | p90 | p95 | max |\n")
    f.write("|---|---:|---:|---:|---:|---:|---:|---:|---:|\n")
    for label, values in [
        ("Pre success", stats(pre_resize)),
        ("Post success", stats(post_resize)),
        ("Failed", stats(failed_resize)),
    ]:
        f.write(
            f"| {label} | {fmt(values['n'])} | {fmt(values['min'])} | {fmt(values['median'])} | {fmt(values['mean'])} | {fmt(values['p75'])} | {fmt(values['p90'])} | {fmt(values['p95'])} | {fmt(values['max'])} |\n"
        )
    f.write("\n")

    f.write("## Relocation Proxy Distribution (pct)\n")
    f.write("| Cohort | n | min | median | mean | p75 | p90 | p95 | max |\n")
    f.write("|---|---:|---:|---:|---:|---:|---:|---:|---:|\n")
    for label, values in [
        ("Pre success", stats(pre_reloc)),
        ("Post success", stats(post_reloc)),
        ("Failed", stats(failed_reloc)),
    ]:
        f.write(
            f"| {label} | {fmt(values['n'])} | {fmt(values['min'])} | {fmt(values['median'])} | {fmt(values['mean'])} | {fmt(values['p75'])} | {fmt(values['p90'])} | {fmt(values['p95'])} | {fmt(values['max'])} |\n"
        )
    f.write("\n")

    f.write("## Outliers\n")
    f.write("- Outliers counted when resize or relocation proxy exceeds >20, >30, >40, >50.\n")
    f.write(f"- Outlier rows in sampled success cohorts: {len(outliers)}\n\n")

    f.write("## Failure Separation\n")
    f.write(f"- Resize success p95: {fmt(resize_sep.get('success_p95'))}\n")
    f.write(f"- Fraction of failed resize <= success p95 (overlap): {fmt(resize_sep.get('overlap'))}\n")
    f.write(f"- Fraction of failed resize > success p95: {fmt(resize_sep.get('failed_above_success_p95'))}\n")
    f.write(f"- Relocation success p95: {fmt(reloc_sep.get('success_p95'))}\n")
    f.write(f"- Fraction of failed relocation <= success p95 (overlap): {fmt(reloc_sep.get('overlap'))}\n")
    f.write(f"- Fraction of failed relocation > success p95: {fmt(reloc_sep.get('failed_above_success_p95'))}\n\n")

    f.write("## Threshold Options\n")
    for t in thresholds:
        f.write(f"### {t['name']}\n")
        f.write(f"- Resize threshold: {fmt(t['resize_threshold_pct'])}\n")
        f.write(f"- Relocation proxy threshold: {fmt(t['relocation_threshold_pct_proxy'])}\n")
        f.write(f"- Rationale: {t['rationale']}\n\n")

    f.write("## Caveats\n")
    f.write("- Relocation value is a proxy from reason-token counts, not direct geometric displacement.\n")
    f.write("- Some logs emit limited structured opening metrics; samples are restricted to observed values.\n")

print(json.dumps(summary, indent=2))