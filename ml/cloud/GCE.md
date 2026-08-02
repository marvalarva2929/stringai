# Deploying LocateAnything-3B on Google Compute Engine

Goal: run `ml/cloud/app.py` (Gradio web app) on a rented GPU so bow + bridge
detection takes ~1–2 s/image instead of minutes on the Mac.

Everything the instance needs is in this directory: `app.py` + `requirements.txt`.

---

## 1. Create the instance

One-time GCP setup, some of which can take real time (the GPU quota step) —
do this first, independent of anything else:

1. Create a GCP project at [console.cloud.google.com](https://console.cloud.google.com/projectcreate), enable billing.
2. Install the `gcloud` CLI: `brew install --cask google-cloud-sdk`, then
   `gcloud init` and `gcloud auth login` (opens a browser).
3. Enable the Compute Engine API:
   `gcloud services enable compute.googleapis.com`.
4. **Request GPU quota — there are two separate gates, request BOTH:**
   - **Per-region/per-type**: In the console, **IAM & Admin → Quotas**,
     filter for `NVIDIA L4 GPUs`, request an increase to at least 1 in your
     target region (e.g. `us-central1`). Repeat for any other region you
     want available.
   - **Global, all regions combined**: filter for `GPUs (All Regions)`
     (metric `compute.googleapis.com/gpus_all_regions`) and request an
     increase to at least 1 *here too* — this is a separate cap on total
     GPUs across every region combined, defaults to 0 independent of the
     per-region approval above, and blocks instance creation identically in
     every zone/region until it's raised (shows up as
     `Quota 'GPUS_ALL_REGIONS' exceeded` if missed).

   Both are the one step that can genuinely block waiting on Google (usually
   fast, occasionally ~1-2 days) — kick them off before anything else.

   Note: this project started with T4 (cheapest common GCE GPU), but T4 hit
   *widespread* `ZONE_RESOURCE_POOL_EXHAUSTED` across every quota'd region
   tried, so the default switched to L4, which has had noticeably better
   availability. NVIDIA T4 and NVIDIA L4 GPU quota are tracked/requested
   separately — request the one that matches whatever `GPU_ACCELERATOR_TYPE`
   is currently set to in `orchestrate.py`.

Then create the instance:

```bash
gcloud compute instances create stringai-trainer \
  --project=<YOUR_PROJECT_ID> --zone=us-central1-a \
  --machine-type=g2-standard-8 \
  --accelerator=type=nvidia-l4,count=1 \
  --image-family=pytorch-2-9-cu129-ubuntu-2204-nvidia-580 --image-project=deeplearning-platform-release \
  --maintenance-policy=TERMINATE \
  --metadata=install-nvidia-driver=True \
  --boot-disk-size=200GB
```

- **GPU**: L4 (24 GB) on a `g2-standard-8` instance (32GB RAM). L4 only
  attaches to the G2 machine family, unlike T4 which attaches to N1 — only
  vCPU/RAM scale with G2 size, not GPU count, so this is still exactly 1 L4.
  `g2-standard-4` (16GB RAM) is NOT enough — confirmed via the OOM killer
  directly while loading `nvidia/LocateAnything-3B`'s second checkpoint
  shard (`dmesg`: "Out of memory: Killed process ... python3"); the model's
  raw ~6GB of bf16 weights needs meaningfully more headroom than that
  during `from_pretrained`. If you have quota, `nvidia-tesla-a100` (on an
  `a2-highgpu-1g` instance) is faster still.
- **If a zone is out of capacity** (`ZONE_RESOURCE_POOL_EXHAUSTED`, common for
  contended GPU types in busy zones): try a different zone. GPU capacity
  varies a lot zone-to-zone and hour-to-hour — `orchestrate.py`'s wizard
  queries which zones actually offer your accelerator type across all your
  quota'd regions and cycles through them automatically rather than trying
  just one.
- **Image**: Google's official Deep Learning VM — CUDA + PyTorch
  preinstalled, the direct GCE equivalent of RunPod's "PyTorch template."
  Google renames/versions these image families periodically (this exact
  name has already changed once since this doc was written) — if this
  command fails with a "resource ... was not found" error, list current
  options with `gcloud compute images list --project=deeplearning-platform-release
  --filter="name~pytorch" --format="value(family)"` (`orchestrate.py`'s
  wizard does this automatically and lets you retry with a different name).
- `--metadata=install-nvidia-driver=True` triggers an automatic driver
  install on **first boot only** — expect ~5-10 extra minutes the very
  first time you start it.
- `--maintenance-policy=TERMINATE` is required for GPU instances (they
  can't live-migrate).
- 200 GB boot disk comfortably covers the ~6-7 GB model cache plus dataset
  and training runs (100 GB works too, but GCE warns about I/O performance
  below that size).

`orchestrate.py --setup` (§6 below) can run all of this for you interactively
instead — this section is the manual/reference version.

## 2. Get the files onto the instance

`gcloud compute scp` manages the SSH keypair and the instance's current IP
automatically — no connect string to copy from a console, and it stays
correct across stop/start cycles (unlike a RunPod pod's SSH port):

```bash
cd ~/Projects/stringai
gcloud compute scp --zone=us-central1-a ml/cloud/app.py ml/cloud/requirements.txt \
    stringai-trainer:/workspace/
```

(First, create `/workspace` on the instance — a fresh Deep Learning VM
doesn't have it by default: `gcloud compute ssh stringai-trainer --zone=us-central1-a --command="sudo mkdir -p /workspace && sudo chown \$(whoami):\$(whoami) /workspace"`.)

## 3. Install and run

SSH in (`gcloud compute ssh stringai-trainer --zone=us-central1-a`) and:

```bash
cd /workspace
export HF_HOME=/workspace/hf        # cache model on the persistent disk
pip install -r requirements.txt

python app.py --auth josh:PICK_A_PASSWORD
```

- First launch downloads the ~6 GB model — takes a few minutes, watch the log.
  On later launches it loads from `/workspace/hf` in ~30 s.
- `--auth` matters if you expose this beyond an SSH tunnel.

To keep it running after you close the terminal:

```bash
nohup python app.py --auth josh:PICK_A_PASSWORD > app.log 2>&1 &
tail -f app.log
```

## 4. Open the app

GCE instances don't have RunPod's HTTP-proxy-per-exposed-port model — reach
port 7860 with an SSH tunnel instead:

```bash
gcloud compute ssh stringai-trainer --zone=us-central1-a -- -L 7860:localhost:7860
```

Leave that running, then open `http://localhost:7860` in your browser. Log
in with the `--auth` credentials, upload a frame, and you should see the
amber (bow) and cyan (violin) boxes in ~1–2 s each, plus a magenta circle
where the box-diagonal intersection estimates the bow/string contact point.

## 5. Mass-training: auto-label + train on the same instance

Once the prompts are validated in the web app, the full pipeline is:

**a. Extract frames on the Mac** (dedup keeps the dataset varied):

```bash
cd ~/Projects/stringai/ml
python extract_frames.py --input videos/ --output data/raw_frames/ --fps 10
```

**b. Upload frames + scripts to the instance:**

```bash
cd ~/Projects/stringai/ml
tar czf frames.tgz -C data raw_frames
gcloud compute scp --zone=us-central1-a frames.tgz \
    cloud/autolabel.py cloud/train_detect.py cloud/data_detect.yaml stringai-trainer:/workspace/
# on the instance:  cd /workspace && tar xzf frames.tgz
```

**c. Auto-label (long-running — use nohup):**

```bash
cd /workspace
export HF_HOME=/workspace/hf
nohup python autolabel.py --input raw_frames/ --output dataset/ > autolabel.log 2>&1 &
tail -f autolabel.log
```

Two prompts per frame ≈ 2-4 s/frame on an L4 → ~3,000 frames ≈ 2-3.5 h.
Resumable: rerunning skips frames that already have labels. Frames where no
bow is found are dropped automatically.

**d. Review.** Pull `dataset/annotated/` down (`gcloud compute scp --recurse`)
and delete bad frames — a bad box teaches the small model the wrong thing.
Delete both `dataset/images/<split>/NAME.jpg` and
`dataset/labels/<split>/NAME.txt`.

**e. Train the on-device model (minutes on the instance GPU):**

```bash
pip install ultralytics
python train_detect.py --device 0
```

**f. Bring weights home and export CoreML on the Mac:**

```bash
# Mac — check train_detect.py's own printed "Best weights:" line for the
# actual path (ultralytics' project/name resolution doesn't always land
# exactly where requested — see train_output_dir.txt on the instance):
gcloud compute scp --zone=us-central1-a stringai-trainer:/workspace/<actual-path>/best.pt ~/Projects/stringai/ml/
cd ~/Projects/stringai/ml
python export_coreml.py --weights best.pt
```

Then **stop the instance**.

## 6. Automated runs (recommended for routine use)

Steps 5a–5f above are now wrapped into [`orchestrate.py`](orchestrate.py),
split into two steps with a checkpoint in between — auto-labeling and
filtering are the least-tested parts of this pipeline (a VLM guessing boxes,
then heuristic outlier rules with no human review), so it's worth looking at
what actually survived before the instance burns GPU-hours training on it:

```bash
cd ml/cloud
python orchestrate.py            # extract + auto-label + filter new videos,
                                  # stop the instance, notify with a preview
                                  # of what was kept (post-filter, boxes drawn)
#  ...review ml/cloud/label_preview/...
python orchestrate.py --continue # train + export CoreML, notify
```

The instance stops between the two steps (cost control) and starts back up
for `--continue`, so there's no rush to review — take however long you need.

First run walks you through a short interactive setup (`gcloud` install
check, `gcloud auth login`, GCP project/zone, creating the instance if it
doesn't exist yet — it'll even offer to bootstrap the instance's Python deps
+ model cache for you over SSH) and saves the answers to `ml/cloud/.env`.
Every run after that just works — `gcloud compute ssh`/`scp` resolve the
instance's current connection details themselves on every call, so unlike
RunPod there's no stale host/port state to re-paste. Dependencies on the
instance are also re-checked (and silently repaired if missing) before
every run, not just during setup.

What it does *not* do, on purpose:
- **Filtering is fully automatic**, runs as part of the label step (not
  `--continue`), using the thresholds already validated in step 5d
  (`full_frame_area=0.85`, `violin_ratio=2.0`, `baseline=min`) plus a
  violin-width outlier check (`violin_width_low=0.75`, i.e. drop frames
  where the violin box is narrower than 75% or wider than 1/0.75 ≈ 133% of
  the group's median width — see `auto_keeplist.py`) — no browser review, no
  ★ references, no group splits. The preview you're notified about is
  exactly what survived this, so it doubles as a check on the filter itself,
  not just the labels. If a trained model looks off, run `review.py` by hand
  afterward to see which frames slipped through.
- **It won't overwrite the app's model.** `export_coreml.py` runs without
  `--copy`, so the new `.mlpackage` lands in `runs/bow_detect/train/weights/`
  for you to review before copying it into
  `modules/pose-camera/ios/bow_detector.mlpackage` yourself.
- **Instance creation is offered, not forced automatically the first time**
  — the wizard asks for confirmation before running
  `gcloud compute instances create`, since GPU quota not being approved yet
  is a common first-run blocker worth surfacing rather than silently retrying.

For long runs, launch either step under `nohup` so it survives closing the
terminal:

```bash
nohup python orchestrate.py > orchestrate.log 2>&1 &
tail -f orchestrate.log
```

Steps 5a–5f remain here as the manual fallback — useful for debugging a
failed automated run, or if you want to actually eyeball `review.py` and
tune thresholds for a particularly tricky batch of footage.

## 7. Cost control

- **Stop the instance when you're done.** Billing is per-second while
  running (an L4 + g2-standard-8 runs roughly $0.75-1.00/hr depending on
  region — more than T4, but T4's capacity problems made it unusable in
  practice). A stopped instance only bills the persistent disk (a 200 GB
  standard disk is still just cents/day), and the model cache on it survives.
- **Deleting** the instance deletes the boot disk too — you'd re-download
  the model and re-run the dependency bootstrap next time. Prefer stop over
  delete for an instance you'll reuse.
- There is no auto-stop by default; GCE supports scheduling instance
  start/stop via Cloud Scheduler if you tend to forget, though
  `orchestrate.py` already stops it for you at the end of every run.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gcloud compute ssh` hangs or times out right after creating the instance | First boot is installing the NVIDIA driver (`install-nvidia-driver=True` metadata) — can take several extra minutes. Just retry. |
| `Permission denied` writing to `/` or `/workspace` | The default SSH user isn't root — use `sudo` for anything outside your home directory, e.g. `sudo mkdir -p /workspace && sudo chown $(whoami):$(whoami) /workspace` (`orchestrate.py` does this automatically). |
| `CUDA out of memory` | Shouldn't happen at 3B on a 24 GB L4; make sure nothing else runs on the GPU (`nvidia-smi`). |
| Model re-downloads every start | `HF_HOME` not set or not on `/workspace`. Export it before `python app.py` (add to `~/.bashrc`). |
| Stuck at `Fetching 2 files: 0%` forever, zero bytes moving (`du -sh $HF_HOME` flat over minutes) | `nvidia/LocateAnything-3B` is stored on HF's Xet backend, whose client hangs indefinitely on some networks — confirmed reproducible across multiple instances/zones/regions, not a local networking issue. `orchestrate.py`/`remote_pipeline.sh` already set `HF_HUB_DISABLE_XET=1`; if running something by hand, set it yourself first. |
| `Auth failed: SignatureError: invalid key pair id` / `403 Forbidden` on a `.../xet-bridge-.../...` URL, partway through a download | A signed-URL glitch on HuggingFace's Xet-bridge CDN (their infrastructure, not yours) — happened once mid-download in practice. Just retry; `hf_hub_download` resumes from cache rather than restarting, and it succeeded on the next attempt. |
| Process silently disappears while loading checkpoint shards (no traceback, `nvidia-smi` shows 0% / 0 MiB) | Check `sudo dmesg \| grep -i oom` — likely the kernel OOM-killer. `g2-standard-4` (16GB RAM) is NOT enough to load this 3B model via `from_pretrained`; use `g2-standard-8` (32GB) or larger (`orchestrate.py`'s default). |
| `trust_remote_code` import errors | `pip install -r requirements.txt` again — the model's remote code needs `transformers>=4.57.1`, plus `decord`/`lmdb`/`peft`/`requests` (all pinned in `requirements.txt` — verified against the actual model source, not guessed). |
| `ZONE_RESOURCE_POOL_EXHAUSTED` | That zone is temporarily out of capacity for the accelerator type — common for contended GPU types in busy zones like `us-central1-a` (this is why the default moved from T4 to L4). `orchestrate.py`'s wizard queries which zones actually offer the accelerator across all your quota'd regions and cycles through them automatically rather than trying just one. |
| `resource ... acceleratorTypes/... was not found` | That specific zone doesn't offer the accelerator type at all (different from capacity exhaustion) — the wizard's zone list is queried directly from `gcloud compute accelerator-types list` to avoid this, but if you're constructing a manual command, double check the accelerator is actually offered in that zone first. |
| `Quota 'GPUS_ALL_REGIONS' exceeded. Limit: 0.0 globally` | The separate *global* GPU quota (§1) is still 0 — this fails identically in every zone/region regardless of your per-region quota, so `orchestrate.py`'s zone-cycling correctly stops after one attempt instead of retrying. Request an increase for `GPUs (All Regions)`, not just the per-type one. |
| Instance creation fails with some other quota error | The per-region/per-type GPU quota isn't approved yet for that region — see §1. |
| Instance creation fails with `resource ... was not found` for the image family | Google renamed/versioned the Deep Learning VM image family (has happened before) — list current options with `gcloud compute images list --project=deeplearning-platform-release --filter="name~pytorch" --format="value(family)"`; the wizard offers to retry with a different name. |
