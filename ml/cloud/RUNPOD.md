# Deploying LocateAnything-3B on RunPod

Goal: run `ml/cloud/app.py` (Gradio web app) on a rented GPU so bow + bridge
detection takes ~1–2 s/image instead of minutes on the Mac.

Everything the pod needs is in this directory: `app.py` + `requirements.txt`.

---

## 1. Create the pod

1. Sign in at [runpod.io](https://runpod.io) → add credits ($10 is plenty to start).
2. **Pods → Deploy**.
3. **GPU**: pick an **RTX 4090 (24 GB)**. The 3B model in bf16 only needs ~8 GB,
   so anything with 16 GB+ works (A4000/A5000 are cheaper, 4090 is fastest per
   dollar). *Community Cloud* is roughly half the price of *Secure Cloud* and
   fine for this.
4. **Template**: the official **RunPod PyTorch** template (e.g. "RunPod PyTorch 2.4",
   CUDA 12.x). Torch comes preinstalled — don't pick a bare Ubuntu image.
5. Click **Edit Template / Customize deployment** and set:
   - **Expose HTTP Ports**: add `7860` (this is what the RunPod proxy forwards).
   - **Container disk**: 20 GB.
   - **Volume disk**: 30 GB, mounted at `/workspace` (default). The model cache
     (~6–7 GB) lives here so a stopped/restarted pod doesn't re-download it.
6. Deploy and wait until the pod shows **Running**.

## 2. Get the files onto the pod

Open the pod's **Connect** menu. Pick whichever is easiest:

**Option A — scp (from your Mac).** Copy the SSH command RunPod shows
(something like `ssh root@<ip> -p <port> -i ~/.ssh/id_ed25519`), then:

```bash
cd ~/Projects/stringai
scp -P <port> -i ~/.ssh/id_ed25519 ml/cloud/app.py ml/cloud/requirements.txt root@<ip>:/workspace/
```

**Option B — runpodctl.** On your Mac (`brew install runpod/runpodctl/runpodctl`):

```bash
cd ~/Projects/stringai/ml/cloud
runpodctl send app.py requirements.txt   # prints a one-time code
```

Then in the pod's **Web Terminal**: `cd /workspace && runpodctl receive <code>`.

**Option C — git.** If you push this folder to the repo first, clone it on the
pod (the repo is private, so you'd need a GitHub token — A or B is simpler).

## 3. Install and run

In the pod's Web Terminal (or SSH):

```bash
cd /workspace
export HF_HOME=/workspace/hf        # cache model on the persistent volume
pip install -r requirements.txt

python app.py --auth josh:PICK_A_PASSWORD
```

- First launch downloads the ~6 GB model — takes a few minutes, watch the log.
  On later launches it loads from `/workspace/hf` in ~30 s.
- `--auth` matters: the proxy URL is guessable-public, and this app runs
  arbitrary uploads through your billed GPU.

To keep it running after you close the terminal:

```bash
nohup python app.py --auth josh:PICK_A_PASSWORD > app.log 2>&1 &
tail -f app.log
```

## 4. Open the app

RunPod proxies exposed HTTP ports at:

```
https://<POD_ID>-7860.proxy.runpod.net
```

The pod's **Connect** menu shows this as "Connect to HTTP Service [Port 7860]".
Log in with the `--auth` credentials, upload a frame, and you should see the
amber (bow) and cyan (violin) boxes in ~1–2 s each, plus a magenta circle
where the box-diagonal intersection estimates the bow/string contact point.

## 5. Mass-training: auto-label + train on the same pod

Once the prompts are validated in the web app, the full pipeline is:

**a. Extract frames on the Mac** (dedup keeps the dataset varied):

```bash
cd ~/Projects/stringai/ml
python extract_frames.py --input videos/ --output data/raw_frames/ --fps 10
```

**b. Upload frames + scripts to the pod:**

```bash
cd ~/Projects/stringai/ml
tar czf frames.tgz -C data raw_frames
scp -P <port> -i ~/.ssh/id_ed25519 frames.tgz \
    cloud/autolabel.py cloud/train_detect.py cloud/data_detect.yaml root@<ip>:/workspace/
# on the pod:  cd /workspace && tar xzf frames.tgz
```

**c. Auto-label (long-running — use nohup):**

```bash
cd /workspace
export HF_HOME=/workspace/hf
nohup python autolabel.py --input raw_frames/ --output dataset/ > autolabel.log 2>&1 &
tail -f autolabel.log
```

Two prompts per frame ≈ 3–4 s/frame on a 4090 → ~3,000 frames ≈ 2.5–3.5 h.
Resumable: rerunning skips frames that already have labels. Frames where no
bow is found are dropped automatically.

**d. Review.** Pull `dataset/annotated/` down (or browse via Jupyter on the
pod) and delete bad frames — a bad box teaches the small model the wrong
thing. Delete both `dataset/images/<split>/NAME.jpg` and
`dataset/labels/<split>/NAME.txt`.

**e. Train the on-device model (minutes on the pod GPU):**

```bash
pip install ultralytics
python train_detect.py --device 0
```

**f. Bring weights home and export CoreML on the Mac:**

```bash
# Mac:
scp -P <port> -i ~/.ssh/id_ed25519 root@<ip>:/workspace/runs/bow_detect/train/weights/best.pt ~/Projects/stringai/ml/
cd ~/Projects/stringai/ml
python export_coreml.py --weights best.pt
```

Then **stop the pod**.

## 6. Cost control

- **Stop the pod when you're done.** Billing is per-minute while running
  (~$0.30–0.70/hr for a 4090 depending on Community vs Secure). A stopped pod
  only bills volume storage (pennies/day), and the model cache survives.
- **Terminate** deletes the volume too — you'd re-download the model next time.
- There is no auto-stop by default; set one under the pod's settings if you
  tend to forget.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Proxy URL shows 502 / "not ready" | App not listening yet (model still loading) or port not exposed as **HTTP** in the template. Check `app.log`; confirm 7860 under Expose HTTP Ports. |
| `CUDA out of memory` | Shouldn't happen at 3B on 16 GB+; make sure nothing else runs on the GPU (`nvidia-smi`). |
| Model re-downloads every start | `HF_HOME` not set or not on `/workspace`. Export it before `python app.py` (add to `~/.bashrc`). |
| `trust_remote_code` import errors | `pip install -r requirements.txt` again — the model's remote code needs `transformers>=4.57.1` and torchvision (preinstalled on the PyTorch template). |
