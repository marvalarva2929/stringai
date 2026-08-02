#!/usr/bin/env bash
# remote_pipeline.sh — runs ON THE POD, in one of two stages selected by $1:
#
#   label   autolabel -> auto_keeplist -> apply_keeplist. Filtering runs here,
#           not in `train`, so the preview orchestrate.py pulls back shows the
#           frames that actually survived filtering (via sample_annotated.py
#           --keeplist) — the same set train_detect.py will train on, not the
#           raw unfiltered labels. Leaves /workspace/LABEL_DONE ("OK" or
#           "FAILED: ...") + label_summary.json + keeplist.json.
#   train   train_detect only (assumes a prior `label` run already built
#           dataset_clean/). Leaves /workspace/PIPELINE_DONE +
#           pipeline_summary.json.
#
# Launched by orchestrate.py via:
#   nohup bash /workspace/remote_pipeline.sh <label|train> > <log> 2>&1 & disown
# stdout/stderr are already redirected by that launch command, so this script
# doesn't manage its own log file.

set -uo pipefail
cd /workspace || exit 1
export HF_HOME=/workspace/hf
# nvidia/LocateAnything-3B is stored on HF's Xet backend, whose client hung
# indefinitely on a fresh download in practice (see orchestrate.py's
# ensure_pod_ready) — the model cache should already be warmed by then, but
# set this defensively in case anything ever triggers a re-fetch here too.
export HF_HUB_DISABLE_XET=1

STAGE_ARG="${1:?usage: remote_pipeline.sh <label|train>}"
case "$STAGE_ARG" in
  label) DONE=/workspace/LABEL_DONE;    SUMMARY_FILE=label_summary.json ;;
  train) DONE=/workspace/PIPELINE_DONE; SUMMARY_FILE=pipeline_summary.json ;;
  *) echo "unknown stage: $STAGE_ARG" >&2; exit 1 ;;
esac
STAGE="init"

rm -f "$DONE"

write_summary() {
  python3 - "$STAGE" "$SUMMARY_FILE" <<'PYEOF'
import csv
import json
import sys
from pathlib import Path

stage, summary_file = sys.argv[1], sys.argv[2]
summary = {"stage_reached": stage}

stats_path = Path("dataset/stats.json")
if stats_path.exists():
    summary["autolabel_stats"] = json.loads(stats_path.read_text())

keeplist_path = Path("keeplist.json")
if keeplist_path.exists():
    kl = json.loads(keeplist_path.read_text())
    summary["keeplist_stats"] = kl.get("stats")
    summary["keeplist_thresholds"] = kl.get("thresholds")

train_dir_file = Path("train_output_dir.txt")
results_path = (
    Path(train_dir_file.read_text().strip()) / "results.csv"
    if train_dir_file.exists()
    else Path("runs/bow_detect/train/results.csv")  # fallback guess if train_detect.py didn't run/finish
)
if results_path.exists():
    with open(results_path) as f:
        rows = list(csv.DictReader(f))
    if rows:
        last = rows[-1]
        summary["final_epoch"] = {
            k.strip(): v.strip() for k, v in last.items()
            if "mAP50" in k or k.strip() == "epoch"
        }

Path(summary_file).write_text(json.dumps(summary, indent=2))
PYEOF
}

run_stage() {
  STAGE="$1"
  shift
  echo "===== [$STAGE] $* ====="
  "$@"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAILED: $STAGE (exit $rc) — $*" > "$DONE"
    write_summary
    exit "$rc"
  fi
}

if [ "$STAGE_ARG" = "label" ]; then
  run_stage "autolabel"      python3 autolabel.py --input raw_frames/ --output dataset/
  run_stage "auto_keeplist"  python3 auto_keeplist.py --dataset dataset/ --out keeplist.json
  run_stage "apply_keeplist" python3 apply_keeplist.py --dataset dataset/ --out dataset_clean
  echo "OK" > "$DONE"
  write_summary
  echo "===== label stage complete ====="
  exit 0
fi

# train
run_stage "train_detect" python3 train_detect.py --data dataset_clean/data.yaml --device 0

echo "OK" > "$DONE"
write_summary
echo "===== train stage complete ====="
