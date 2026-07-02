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

## 5. Bulk auto-labeling (once the prompts look good)

The same pod can run the batch script for dataset generation. Copy
`ml/locate_anything_test.py` and a frames directory up (Option A/B above), then:

```bash
python locate_anything_test.py --input raw_frames/ --limit 0 --export-labels
```

At ~2 s/frame/prompt on a 4090, ~3,000 frames is a couple of GPU-hours —
run it under `nohup`, then `runpodctl send` the `auto_labels/` output back down.

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
