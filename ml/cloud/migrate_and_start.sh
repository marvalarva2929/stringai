#!/usr/bin/env bash
# Cycles through candidate zones trying to migrate stringai-trainer's disk
# and boot an L4 instance there, until one succeeds. Safe to leave running:
# each failed zone's disk is deleted before moving to the next. The original
# disk/instance in us-east1-b is untouched throughout (never deleted).
set -uo pipefail

SNAPSHOT=stringai-trainer-migrate-snap
NAME=stringai-trainer
LOG=/Users/joshv/Projects/stringai/ml/cloud/migrate_and_start.log

ZONES=(
  us-central1-b us-central1-c
  us-west1-b us-west1-c
  us-west4-a us-west4-c
  northamerica-northeast1-b northamerica-northeast1-c
  northamerica-northeast2-a northamerica-northeast2-b
  asia-northeast1-a asia-northeast1-b asia-northeast1-c
  asia-east1-a asia-east1-b asia-east1-c
  asia-southeast1-a asia-southeast1-b asia-southeast1-c
  asia-south1-a asia-south1-b asia-south1-c
  asia-northeast3-a asia-northeast3-b
  europe-west4-a europe-west4-b europe-west4-c
  europe-west1-b europe-west1-c
  europe-west2-a europe-west2-b
  europe-west3-a europe-west3-b
  europe-west6-b europe-west6-c
  me-central2-a me-central2-c
)

echo "$(date) starting migration sweep across ${#ZONES[@]} zones" >> "$LOG"

while true; do
  for ZONE in "${ZONES[@]}"; do
    echo "$(date) trying $ZONE ..." >> "$LOG"
    if ! gcloud compute disks create "$NAME" --zone="$ZONE" \
        --source-snapshot="$SNAPSHOT" --type=pd-balanced >> "$LOG" 2>&1; then
      echo "$(date) $ZONE: disk create failed, skipping" >> "$LOG"
      continue
    fi
    if gcloud compute instances create "$NAME" --zone="$ZONE" \
        --machine-type=g2-standard-8 \
        --accelerator=type=nvidia-l4,count=1 \
        --disk=name="$NAME",boot=yes,auto-delete=yes \
        --maintenance-policy=TERMINATE \
        --provisioning-model=STANDARD >> "$LOG" 2>&1; then
      echo "$(date) SUCCESS in $ZONE" >> "$LOG"
      echo "SUCCESS_ZONE=$ZONE" >> "$LOG"
      exit 0
    fi
    echo "$(date) $ZONE: instance create failed, cleaning up disk" >> "$LOG"
    gcloud compute disks delete "$NAME" --zone="$ZONE" --quiet >> "$LOG" 2>&1
  done
  echo "$(date) full sweep exhausted, sleeping 5m before retrying from the top" >> "$LOG"
  sleep 300
done
