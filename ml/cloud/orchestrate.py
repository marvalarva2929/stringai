#!/usr/bin/env python3
"""
orchestrate.py — new videos in ml/videos/ -> extracted frames -> auto-labeled
+ auto-filtered on a GCE instance -> notification with a preview of the KEPT
(post-filter) frames to eyeball -> (you review, then) -> trained -> CoreML
export -> notification. Chains extract_frames.py, autolabel.py,
auto_keeplist.py, apply_keeplist.py, train_detect.py and export_coreml.py —
see GCE.md for what each does on its own; this just removes the babysitting
between them.

Two-step by design: auto-labeling and filtering are the least-tested parts
of the pipeline (a VLM guessing bow/violin boxes, then heuristic outlier
rules with no human review), so this stops after both and lets you look at
what actually survived before the instance burns GPU-hours training on it.

    python orchestrate.py                # extract + auto-label + filter new
                                          # videos, stop the instance, notify
                                          # with a preview of what was kept
    ...review ml/cloud/label_preview/...
    python orchestrate.py --continue     # train + export CoreML

First run: walks you through a short interactive setup (gcloud auth, GCP
project/zone, creating the GPU instance if it doesn't exist yet) and saves
it to ml/cloud/.env. Every run after that is silent — `gcloud compute ssh`/
`scp` resolve the instance's current connection details themselves every
time, so there's no stale connection info to re-confirm the way RunPod
required.

For a run you can walk away from (hours):
    nohup python orchestrate.py > orchestrate.log 2>&1 &
    tail -f orchestrate.log
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

CLOUD = Path(__file__).resolve().parent           # ml/cloud/
ROOT = CLOUD.parent                                # ml/
sys.path.insert(0, str(ROOT))
from extract_frames import video_id_from_path      # noqa: E402  (needs sys.path set first)

ENV_PATH = CLOUD / ".env"
VIDEOS_DIR = ROOT / "videos"
RAW_FRAMES_DIR = ROOT / "data" / "raw_frames"
STATE_PATH = ROOT / "data" / ".extracted_videos.json"
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".m4v", ".mkv"}

REQUIRED_KEYS = ["GCP_PROJECT", "GCP_ZONE", "GCE_INSTANCE_NAME"]

WALL_CLOCK_CAP_S = 6 * 3600
POLL_INTERVAL_S = 5 * 60

# Google renames/versions Deep Learning VM image families periodically (this
# project has already seen "pytorch-latest-gpu" go away in favor of an
# explicit CUDA/OS/driver-versioned name) — if instance creation fails, the
# wizard offers to list current options and retry with a different one.
DLVM_IMAGE_FAMILY_DEFAULT = "pytorch-2-9-cu129-ubuntu-2204-nvidia-580"

# L4 (not T4 — switched after widespread T4 ZONE_RESOURCE_POOL_EXHAUSTED
# across every quota'd region tried). L4 only attaches to the G2 machine
# family, unlike T4 which attaches to N1. L4 GPU quota is requested/tracked
# separately from T4 quota.
#
# g2-standard-4 (16GB RAM) is NOT enough — confirmed via the OOM killer
# directly (dmesg: "Out of memory: Killed process ... python3") while
# loading nvidia/LocateAnything-3B's second checkpoint shard, which needs
# meaningfully more headroom than the model's raw ~6GB of bf16 weights
# during `from_pretrained`. g2-standard-8 doubles RAM to 32GB for the same
# single L4 GPU (only the vCPU/RAM scales with G2 size, not GPU count).
GPU_MACHINE_TYPE = "g2-standard-8"
GPU_ACCELERATOR_TYPE = "nvidia-l4"

# GPU capacity gets exhausted in individual zones fairly often (especially
# heavily-used ones like us-central1-a) — the wizard cycles zones within
# whichever regions you have quota in automatically. US first (usually
# closest/most relevant), then everywhere else, alphabetically within that.
GPU_REGION_PRIORITY = [
    "us-central1", "us-east1", "us-east4", "us-east5", "us-south1",
    "us-west1", "us-west2", "us-west3", "us-west4",
    "northamerica-northeast1", "northamerica-northeast2", "northamerica-south1",
    "southamerica-east1", "southamerica-west1",
    "europe-west1", "europe-west2", "europe-west3", "europe-west4",
    "europe-west6", "europe-west8", "europe-west9", "europe-west10", "europe-west12",
    "europe-north1", "europe-north2", "europe-central2", "europe-southwest1",
    "me-central1", "me-central2", "me-west1",
    "asia-east1", "asia-east2", "asia-northeast1", "asia-northeast2", "asia-northeast3",
    "asia-south1", "asia-south2", "asia-southeast1", "asia-southeast2", "asia-southeast3",
    "australia-southeast1", "australia-southeast2",
    "africa-south1",
]
MAX_ZONE_ATTEMPTS = 25  # safety cap in case every zone is genuinely out of capacity


# ── .env ─────────────────────────────────────────────────────────────────────

def load_env() -> dict:
    env = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    return env


def save_env(env: dict) -> None:
    ENV_PATH.write_text("".join(f"{k}={v}\n" for k, v in env.items()))
    ENV_PATH.chmod(0o600)


# ── small interactive helpers ───────────────────────────────────────────────

def prompt(msg: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    val = input(f"{msg}{suffix}: ").strip()
    return val or (default or "")


def confirm(msg: str, default_yes: bool = True) -> bool:
    suffix = "[Y/n]" if default_yes else "[y/N]"
    val = input(f"{msg} {suffix}: ").strip().lower()
    if not val:
        return default_yes
    return val.startswith("y")


# ── gcloud / SSH plumbing ────────────────────────────────────────────────────
#
# gcloud compute ssh/scp resolve the instance's current external IP and
# manage their own SSH keypair (~/.ssh/google_compute_engine) automatically
# on every invocation — unlike RunPod's SSH proxy, there's no host/port
# state that can go stale across a stop/start cycle, so there's nothing to
# re-paste here (contrast the old parse_ssh_command wizard step, gone).

def gcloud_installed() -> bool:
    return shutil.which("gcloud") is not None


def gcloud_cmd(args: list[str], **kw) -> subprocess.CompletedProcess:
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    return subprocess.run(["gcloud", *args], **kw)


def gce_ssh_base(env: dict) -> list[str]:
    return [
        "gcloud", "compute", "ssh", env["GCE_INSTANCE_NAME"],
        "--project", env["GCP_PROJECT"],
        "--zone", env["GCP_ZONE"],
        "--quiet",  # suppress interactive prompts (e.g. first-run SSH key setup)
    ]


def gce_scp_base(env: dict) -> list[str]:
    return [
        "gcloud", "compute", "scp",
        "--project", env["GCP_PROJECT"],
        "--zone", env["GCP_ZONE"],
        "--quiet",
    ]


def gce_instance_base(env: dict) -> list[str]:
    """Common flags for `gcloud compute instances <verb>` calls — always
    explicit about project/zone rather than relying on the user's ambient
    `gcloud config`, which other terminal sessions/projects could change."""
    return ["--project", env["GCP_PROJECT"], "--zone", env["GCP_ZONE"]]


def ssh_run(env: dict, remote_cmd: str, timeout: float | None = None, capture: bool = True):
    # Run as a login shell on the remote end: a bare `--command "cmd"` opens
    # a non-login shell that skips ~/.bashrc, which is where a conda env
    # might get activated on the Deep Learning VM image — without this,
    # python3/pip here can silently resolve to a different (bare) interpreter
    # than an interactive SSH session uses, so a dependency check or
    # `pip install` can appear to succeed against the wrong environment
    # entirely. Cheap precaution regardless of which cloud this runs on.
    wrapped = f"bash -lc {shlex.quote(remote_cmd)}"
    cmd = gce_ssh_base(env) + ["--command", wrapped]
    if capture:
        return subprocess.run(cmd, timeout=timeout, capture_output=True, text=True)
    return subprocess.run(cmd, timeout=timeout)


def ssh_probe(env: dict) -> tuple[bool, str]:
    """Like ssh_ok but also returns *why* on failure, so retry loops can
    show a real reason instead of a silent "not reachable yet"."""
    try:
        # A bit more generous than a bare `ssh` probe would need — gcloud's
        # own startup/auth-refresh overhead adds a second or two on top of
        # the actual SSH connection.
        r = ssh_run(env, "echo ok", timeout=20)
    except subprocess.TimeoutExpired:
        return False, "connection attempt timed out after 20s"
    except Exception as e:
        return False, str(e)
    if r.returncode == 0 and "ok" in (r.stdout or ""):
        return True, ""
    return False, (r.stderr or r.stdout or f"ssh exited {r.returncode}").strip()


def ssh_ok(env: dict) -> bool:
    return ssh_probe(env)[0]


def scp_to_pod(env: dict, local_path: Path, remote_dir: str = "/workspace") -> None:
    """Mac -> instance file transfer via `gcloud compute scp`."""
    print(f"Copying {local_path.name} to the instance via gcloud compute scp…")
    dest = f"{env['GCE_INSTANCE_NAME']}:{remote_dir}/"
    r = subprocess.run(gce_scp_base(env) + [str(local_path), dest])
    if r.returncode != 0:
        raise RuntimeError(f"gcloud compute scp failed sending {local_path} to the instance")
    print(f"  ✓ {local_path.name} landed in {remote_dir} on the instance")


def scp_from_pod(env: dict, remote_path: str, local_dir: Path) -> None:
    local_dir.mkdir(parents=True, exist_ok=True)
    print(f"Copying {remote_path} from the instance via gcloud compute scp…")
    src = f"{env['GCE_INSTANCE_NAME']}:{remote_path}"
    r = subprocess.run(gce_scp_base(env) + [src, f"{local_dir}/"])
    if r.returncode != 0:
        raise RuntimeError(f"gcloud compute scp failed pulling {remote_path} from the instance")
    print(f"  ✓ pulled {remote_path} into {local_dir}")


# ── pod dependency check / bootstrap ────────────────────────────────────────

def _check(env: dict, cmd: str) -> bool:
    return ssh_run(env, cmd).returncode == 0


# Checks every package LocateAnything-3B's trust_remote_code files actually
# import (verified against the real source on HF — see requirements.txt),
# not just the ones that happened to be missing last time. cv2 is the import
# name for opencv-python-headless.
DEPS_CHECK_CMD = "python3 -c 'import torch, transformers, ultralytics, decord, lmdb, peft, requests, cv2'"
# Not just "directory is non-empty" — a stalled/partial download (observed in
# practice, see the IPv6 fix below) leaves /workspace/hf non-empty without
# the model actually being usable, which let ensure_pod_ready falsely report
# "already warmed". Require at least one real (>100MB) safetensors shard.
# `find -L` (not plain `find`) is required: HF's cache stores the actual
# blobs under blobs/<hash> and the *.safetensors names under snapshots/ are
# symlinks to them — without -L, `-size` checks the symlink's own tiny size
# (the length of the link target path), not the real file, so this silently
# always failed to match anything at all until caught in practice.
CACHE_CHECK_CMD = (
    'find -L /workspace/hf -name "*.safetensors" -size +100M 2>/dev/null | grep -q .'
)


def ensure_pod_ready(env: dict, interactive: bool) -> None:
    """Verify (and if needed, install) Python deps + the warmed model cache
    on the instance. Runs before *every* remote pipeline launch, not just
    during --setup: an earlier bootstrap can silently target the wrong
    Python (e.g. a stray `pip` on PATH resolving to a different interpreter
    than `python3`, or a conda env that only activates in ~/.bashrc), and
    there was previously no way to detect that drift short of rerunning
    --setup by hand. Cheap to re-check every time. Raises on unrecoverable
    failure so callers don't push a bundle and launch a pipeline that's
    doomed to fail again in the first few seconds."""
    # Unlike a RunPod pod (whose template mounts a persistent volume at
    # /workspace by convention), a fresh GCE instance has no /workspace at
    # all — everything downstream (`cd /workspace && ...`) assumes it
    # exists, so guarantee it unconditionally rather than relying on it as
    # an incidental side effect of the deps-install branch below. sudo is
    # required (the default gcloud compute ssh user isn't root and can't
    # create a top-level dir), then hand ownership to that user so nothing
    # downstream needs sudo again — GCE instances grant the default user
    # passwordless sudo, so this doesn't hang waiting for a password prompt.
    ssh_run(env, "sudo mkdir -p /workspace && sudo chown \"$(whoami)\":\"$(whoami)\" /workspace")

    # Observed in practice: some GCE instances have broken IPv6 (routes
    # nowhere) while still advertising AAAA records for normal internet
    # hosts (e.g. huggingface.co). Python's networking stack tries
    # getaddrinfo() results in order, so if IPv6 sorts first, large
    # multi-file downloads (the model weights) can hang for a very long
    # time cycling through dead IPv6 candidates before ever reaching a
    # working IPv4 one — small single-file requests are more likely to get
    # lucky and land on IPv4 first, which is why this can look like "small
    # downloads work, the big one hangs forever". Fix: tell glibc's resolver
    # to prefer IPv4 (doesn't disable IPv6, just reorders it lower).
    # Idempotent — checks first so reruns don't pile up duplicate lines.
    ssh_run(
        env,
        'grep -q "^precedence ::ffff:0:0/96" /etc/gai.conf 2>/dev/null || '
        'echo "precedence ::ffff:0:0/96  100" | sudo tee -a /etc/gai.conf > /dev/null',
    )

    print("\nChecking the instance's setup…")
    checks = {"python deps": DEPS_CHECK_CMD, "model cache": CACHE_CHECK_CMD}
    missing = [name for name, cmd in checks.items() if not _check(env, cmd)]
    for name in checks:
        print(f"  [{'ok' if name not in missing else 'missing'}] {name}")

    if not missing:
        print("  instance is already fully set up.")
        return

    if interactive and not confirm(
        f"\n{', '.join(missing)} missing on the instance. Bootstrap now over SSH? "
        "(installs pip deps + downloads the 6GB model — several minutes)"
    ):
        print("Skipping — rerun with --setup later, or bootstrap manually per GCE.md.")
        return
    if not interactive:
        print(f"  {', '.join(missing)} missing on the instance — repairing automatically…")

    if "python deps" in missing:
        print("  sending requirements.txt and installing Python deps (a few minutes)…")
        req = (CLOUD / "requirements.txt").read_text()
        ssh_run(env, f"mkdir -p /workspace && cat > /workspace/requirements.txt << 'REQEOF'\n{req}\nREQEOF", capture=False)
        # `python3 -m pip` (not a bare `pip` on PATH) guarantees installing
        # into the exact interpreter DEPS_CHECK_CMD just tested — a
        # standalone `pip` binary can silently resolve to a different
        # Python. Plain install first; --break-system-packages only as a
        # fallback, since newer Debian/Ubuntu-based images refuse to let pip
        # touch the system Python (PEP 668) without it, but older pip
        # versions don't recognize the flag at all.
        r = ssh_run(env, "cd /workspace && python3 -m pip install -r requirements.txt",
                    capture=False, timeout=1800)
        if r.returncode != 0:
            print("  plain pip install failed, retrying with --break-system-packages…")
            r = ssh_run(env, "cd /workspace && python3 -m pip install --break-system-packages -r requirements.txt",
                        capture=False, timeout=1800)

        # ultralytics declares a plain `opencv-python` dependency (needs
        # libGL, absent on a headless server) that can land alongside the
        # opencv-python-headless we explicitly pinned — both provide the
        # same `cv2` import name, pip doesn't dedupe across different
        # package names for that, and whichever's files end up on top
        # decides whether `import cv2`/ultralytics blows up with
        # "libGL.so.1: cannot open shared object file". Force headless to win.
        print("  forcing opencv-python-headless to win over any plain opencv-python…")
        ssh_run(env, "python3 -m pip uninstall -y opencv-python", capture=False, timeout=120)
        ssh_run(env, "python3 -m pip install --force-reinstall --no-deps opencv-python-headless",
                capture=False, timeout=300)

        if r.returncode != 0 or not _check(env, DEPS_CHECK_CMD):
            raise RuntimeError(
                "Installing Python deps on the instance failed (see output above). "
                "SSH in and run `python3 -m pip install -r requirements.txt` "
                "by hand to see the real error."
            )

    if "model cache" in missing:
        print("  warming the model cache (downloads ~6GB — several minutes)…")
        # HF_HUB_DISABLE_XET=1: nvidia/LocateAnything-3B is stored on HF's
        # newer Xet backend, whose client hung indefinitely at "Fetching 2
        # files: 0%" in practice (confirmed: zero bytes moved over 90s+,
        # reproduced across two different instances/zones/regions, so not a
        # zone- or IPv6-specific issue) — disabling it falls back to plain
        # HTTPS downloads, which worked immediately and fast.
        r = ssh_run(
            env,
            "mkdir -p /workspace/hf && export HF_HOME=/workspace/hf && "
            "export HF_HUB_DISABLE_XET=1 && "
            "python3 -c \"from transformers import AutoModel, AutoProcessor, AutoTokenizer; "
            "m='nvidia/LocateAnything-3B'; "
            "AutoTokenizer.from_pretrained(m, trust_remote_code=True); "
            "AutoProcessor.from_pretrained(m, trust_remote_code=True); "
            "AutoModel.from_pretrained(m, trust_remote_code=True)\"",
            capture=False, timeout=1800,
        )
        if r.returncode != 0 or not _check(env, CACHE_CHECK_CMD):
            raise RuntimeError(
                "Warming the model cache on the instance failed (see output above)."
            )

    print("  bootstrap complete.")


def candidate_zones(project: str) -> list[str]:
    """Zones that actually offer the GPU_ACCELERATOR_TYPE (queried directly —
    it isn't offered in every zone within a region, so listing zones by
    region membership alone wastes attempts on zones that were never going
    to work), restricted to GPU_REGION_PRIORITY's regions and ordered by
    that priority, alphabetically within a region."""
    r = gcloud_cmd([
        "compute", "accelerator-types", "list", "--project", project,
        f"--filter=name={GPU_ACCELERATOR_TYPE}", "--format=value(zone)",
    ])
    by_region: dict[str, list[str]] = {}
    for line in (r.stdout or "").splitlines():
        zone = line.strip().rsplit("/", 1)[-1]  # zone field may be a full URL or bare name
        if not zone:
            continue
        region = zone.rsplit("-", 1)[0]  # "us-central1-a" -> "us-central1"
        by_region.setdefault(region, []).append(zone)
    zones = []
    for region in GPU_REGION_PRIORITY:
        zones.extend(sorted(by_region.get(region, [])))
    return zones


def create_instance_gpu(env: dict, zone: str, image_family: str) -> subprocess.CompletedProcess:
    return gcloud_cmd([
        "compute", "instances", "create", env["GCE_INSTANCE_NAME"],
        "--project", env["GCP_PROJECT"], "--zone", zone,
        f"--machine-type={GPU_MACHINE_TYPE}",
        f"--accelerator=type={GPU_ACCELERATOR_TYPE},count=1",
        f"--image-family={image_family}",
        "--image-project=deeplearning-platform-release",
        "--maintenance-policy=TERMINATE",  # required for GPU instances (no live migration)
        "--metadata=install-nvidia-driver=True",
        "--boot-disk-size=200GB",  # 100GB triggers a (non-fatal) I/O perf warning
    ])


def start_instance(env: dict) -> None:
    """`gcloud compute instances start` — raises with the real gcloud error
    on failure instead of silently leaving the instance stopped and letting
    the caller wait forever for SSH on an instance that never started (GCE
    re-checks GPU quota/capacity on start, not just create, so this can fail
    for the same reasons creation can)."""
    r = gcloud_cmd(["compute", "instances", "start", env["GCE_INSTANCE_NAME"], *gce_instance_base(env)])
    if r.returncode != 0:
        raise RuntimeError(f"Starting the instance failed:\n{(r.stderr or r.stdout or '').strip()}")


def run_setup_wizard(env: dict) -> dict:
    print("=" * 70)
    print("StringAI training pipeline — setup")
    print("=" * 70)
    print(
        "\nThis needs a GCP project with billing enabled and (usually) a GPU "
        "quota request approved — see ml/cloud/GCE.md §1 if you haven't done "
        "that yet. Everything below gets saved to ml/cloud/.env so this only "
        "happens once.\n"
    )

    if not gcloud_installed():
        print("gcloud is not on your PATH.")
        if confirm("Install it now via Homebrew (brew install --cask google-cloud-sdk)?"):
            subprocess.run(["brew", "install", "--cask", "google-cloud-sdk"], check=True)
        else:
            sys.exit("Install the gcloud CLI and rerun: brew install --cask google-cloud-sdk")

    r = gcloud_cmd(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"])
    if not (r.stdout or "").strip():
        print("\nNot logged in — opening a browser for `gcloud auth login`…")
        if subprocess.run(["gcloud", "auth", "login"]).returncode != 0:
            sys.exit("gcloud auth login failed — rerun --setup once you can authenticate.")

    print("\nLooking up your GCP projects…")
    r = gcloud_cmd(["projects", "list", "--format=value(projectId)"])
    print(r.stdout or r.stderr or "  (none found — create one at https://console.cloud.google.com/projectcreate)")
    project = ""
    while not project:
        project = prompt("GCP project ID", env.get("GCP_PROJECT"))
    env["GCP_PROJECT"] = project
    gcloud_cmd(["config", "set", "project", project])

    print("\nChecking the Compute Engine API…")
    r = gcloud_cmd(["services", "list", "--enabled", "--project", project,
                     "--filter=config.name:compute.googleapis.com", "--format=value(config.name)"])
    if not (r.stdout or "").strip():
        print("  enabling compute.googleapis.com (can take a minute)…")
        r = gcloud_cmd(["services", "enable", "compute.googleapis.com", "--project", project])
        if r.returncode != 0:
            sys.exit(f"Could not enable the Compute Engine API:\n{r.stderr}")
    else:
        print("  already enabled.")

    preferred_zone = prompt(
        "GCP zone (tried first; the wizard falls back to other zones in your "
        "quota'd regions automatically if this one's out of GPU capacity)",
        env.get("GCP_ZONE", "us-central1-a"),
    )
    env["GCP_ZONE"] = preferred_zone
    env["GCE_INSTANCE_NAME"] = prompt("GCE instance name", env.get("GCE_INSTANCE_NAME", "stringai-trainer"))

    print(f"\nChecking whether instance '{env['GCE_INSTANCE_NAME']}' already exists in {preferred_zone}…")
    exists = gcloud_cmd(
        ["compute", "instances", "describe", env["GCE_INSTANCE_NAME"], *gce_instance_base(env),
         "--format=value(name)"]
    ).returncode == 0

    if not exists:
        print(
            "  not found. Creating it now — RTX-4090-equivalent isn't a GCE SKU, so "
            "this defaults to an NVIDIA L4 (better current availability than the "
            "cheaper T4 tier, which was seeing widespread capacity exhaustion) on "
            f"a {GPU_MACHINE_TYPE} instance running Google's Deep Learning VM image "
            "(CUDA/PyTorch preinstalled, same idea as RunPod's PyTorch template)."
        )
        if not confirm("Create it now?"):
            sys.exit(
                "Create the instance yourself (see ml/cloud/GCE.md §1 for the exact "
                "gcloud command) and rerun --setup, or rerun --setup again once ready."
            )

        image_family = DLVM_IMAGE_FAMILY_DEFAULT
        print("\nLooking up real zone names for your quota'd regions (GPU capacity gets "
              "exhausted per-zone often enough that trying just one isn't reliable)…")
        zones = [preferred_zone] + [z for z in candidate_zones(env["GCP_PROJECT"]) if z != preferred_zone]
        zones = zones[:MAX_ZONE_ATTEMPTS]
        print(f"  will try up to {len(zones)} zone(s), starting with {preferred_zone}.")

        succeeded = False
        last_stderr = ""
        attempted = 0
        for i, zone in enumerate(zones, 1):
            print(f"  [{i}/{len(zones)}] trying {zone}…")
            attempted = i
            r = create_instance_gpu(env, zone, image_family)
            if r.returncode == 0:
                env["GCP_ZONE"] = zone
                succeeded = True
                print(f"  ✓ created in {zone}")
                break
            stderr = (r.stderr or "").strip()
            last_stderr = stderr
            # Zone/GPU-availability errors — worth trying the next zone:
            #  - ZONE_RESOURCE_POOL_EXHAUSTED / "not have enough resources": real
            #    capacity exhaustion right now.
            #  - "acceleratorTypes/... was not found": GPU_ACCELERATOR_TYPE isn't
            #    offered in this zone at all (candidate_zones() queries this
            #    directly now, but keep this as defense-in-depth against a
            #    stale/racy result).
            #  - "was not found"/"does not exist" for the zone itself: bad name.
            if ("ZONE_RESOURCE_POOL_EXHAUSTED" in stderr or "not have enough resources" in stderr
                    or "acceleratorTypes" in stderr
                    or "does not exist" in stderr.lower()
                    or ("zones/" in stderr and "was not found" in stderr)):
                reason = stderr.splitlines()[-1][:150] if stderr else "no capacity"
                print(f"      unavailable ({reason}) — trying next…")
                continue
            # A quota error is project-wide, not zone-specific (most often
            # GPUS_ALL_REGIONS — a *separate*, global quota gate on top of
            # whatever per-region/per-type quota is approved) — cycling
            # zones can't fix this, so stop immediately rather than burning
            # through the whole candidate list on a guaranteed-repeat error.
            if "quota" in stderr.lower() or "exceeded" in stderr.lower():
                print(f"\n  Quota error (not zone-specific — cycling zones won't help), "
                      f"stopping the sweep after {attempted} attempt(s):\n{stderr}")
                break
            # Any other error (bad image family, malformed request) will also
            # recur in every zone — stop and surface it rather than cycling.
            print(f"\n  Non-capacity error, stopping the automatic sweep after "
                  f"{attempted} attempt(s):\n{stderr}")
            break

        if not succeeded:
            quota_hint = ""
            if "gpus_all_regions" in last_stderr.lower() or "gpus (all regions)" in last_stderr.lower():
                quota_hint = (
                    "\nThis looks like the GLOBAL 'GPUs (All Regions)' quota (metric "
                    "compute.googleapis.com/gpus_all_regions), which is SEPARATE from "
                    "the per-region/per-type quota you already requested — both need to "
                    "be > 0. Console → IAM & Admin → Quotas → filter for "
                    "\"GPUs (All Regions)\" → request an increase.\n"
                )
            print(
                f"\nCouldn't create the instance after {attempted} attempt(s) "
                f"(out of {len(zones)} candidate zone(s)). Last error:\n"
                f"{last_stderr}\n"
                f"{quota_hint}\n"
                "If that looks like an image-family problem, list current options with:\n"
                "  gcloud compute images list --project=deeplearning-platform-release "
                '--filter="name~pytorch" --format="value(family)"\n'
                f"Otherwise every zone you have quota in may genuinely be out of "
                f"{GPU_ACCELERATOR_TYPE} capacity right now — try again shortly, or retry "
                "once more here with a specific zone/image family."
            )
            if not confirm("Retry once more with a specific zone/image family?"):
                sys.exit("Rerun --setup once ready to try again.")
            zone = prompt("Zone", zones[-1] if zones else preferred_zone)
            image_family = prompt("Image family", image_family)
            r = create_instance_gpu(env, zone, image_family)
            if r.returncode != 0:
                sys.exit(f"Still failing:\n{r.stderr}\nFix the issue and rerun --setup.")
            env["GCP_ZONE"] = zone

        print("  created. First boot installs the NVIDIA driver — expect ~5-10 extra "
              "minutes versus later starts.")
    else:
        print("  found — reusing it.")

    print(f"\nStarting instance {env['GCE_INSTANCE_NAME']}…")
    try:
        start_instance(env)
    except RuntimeError as e:
        sys.exit(f"{e}\n\nFix the issue above (likely the same GPU quota/capacity class of "
                  "problem as instance creation — GCE re-checks on start too) and rerun --setup.")

    # A freshly-created instance's first boot installs the NVIDIA driver
    # (install-nvidia-driver=True metadata), which genuinely can take 5-10+
    # minutes — a resumed *existing* instance is back in well under a
    # minute, so only wait the long way when we just created one.
    ssh_wait_attempts = 40 if not exists else 12
    ssh_wait_minutes = ssh_wait_attempts * 15 // 60
    print(f"\nTesting SSH connectivity (gcloud manages the keypair/IP itself — nothing to "
          f"paste). {'First boot — this can take several minutes.' if not exists else ''}")
    for _ in range(ssh_wait_attempts):
        ok, detail = ssh_probe(env)
        if ok:
            print("  ✓ connected")
            break
        print(f"  not reachable yet ({detail or 'no response'}), retrying in 15s…")
        time.sleep(15)
    else:
        sys.exit(
            f"Could not reach the instance over SSH after {ssh_wait_minutes} minutes. "
            + ("The NVIDIA driver install can occasionally take even longer than that on "
               "first boot — just rerun `python orchestrate.py --setup` again; it'll skip "
               "straight to this SSH check since the instance already exists now. "
               if not exists else
               "Check the instance is RUNNING (not stuck STOPPING/PROVISIONING) in the "
               "GCP console. ")
            + "If it looks stuck for a very long time, check the serial port output in "
              "the console for boot errors."
        )

    try:
        ensure_pod_ready(env, interactive=True)
    except RuntimeError as e:
        print(f"\n[WARN] {e}")
        print("Saving connection details anyway — fix the instance-side issue above, "
              "then just rerun `python orchestrate.py` (it re-checks deps every run).")

    save_env(env)
    print(f"\nSaved config to {ENV_PATH}. Future runs won't ask again.\n")
    return env


# ── video discovery / state ──────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {"processed": []}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2))


def discover_new_videos() -> list[Path]:
    if not VIDEOS_DIR.exists():
        return []
    processed = set(load_state().get("processed", []))
    vids = sorted(p for p in VIDEOS_DIR.iterdir() if p.suffix.lower() in VIDEO_EXTS)
    return [p for p in vids if p.name not in processed]


def mark_processed(videos: list[Path]) -> None:
    state = load_state()
    state.setdefault("processed", [])
    state["processed"] = sorted(set(state["processed"]) | {p.name for p in videos})
    save_state(state)


def load_extracted() -> set[str]:
    """Videos whose frames are already on local disk — tracked separately
    from "processed" (which only gets set once the *entire* remote pipeline
    succeeds), so a retry after a later failure (e.g. the instance failing
    to start) doesn't redo local frame extraction for videos already done,
    which is otherwise wasted CPU time (and, before this, duplicate rows
    appended to manifest.csv on every retry)."""
    return set(load_state().get("extracted", []))


def mark_extracted(videos: list[Path]) -> None:
    state = load_state()
    state.setdefault("extracted", [])
    state["extracted"] = sorted(set(state["extracted"]) | {p.name for p in videos})
    save_state(state)


# ── pipeline steps ───────────────────────────────────────────────────────────

def run_extract(new_videos: list[Path]) -> None:
    cmd = [
        sys.executable, str(ROOT / "extract_frames.py"),
        "--input", *[str(p) for p in new_videos],
        "--output", str(RAW_FRAMES_DIR),
        "--append-manifest",
    ]
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        raise RuntimeError("extract_frames.py failed")


def push_bundle_to_pod(env: dict, video_ids: list[str]) -> None:
    bundle = CLOUD / "_send_bundle.tgz"
    if bundle.exists():
        bundle.unlink()
    with tarfile.open(bundle, "w:gz") as tf:
        for vid in video_ids:
            d = RAW_FRAMES_DIR / vid
            if d.is_dir():
                tf.add(d, arcname=f"raw_frames/{vid}")
        for py in sorted(CLOUD.glob("*.py")):
            tf.add(py, arcname=py.name)
        tf.add(CLOUD / "remote_pipeline.sh", arcname="remote_pipeline.sh")
        tf.add(CLOUD / "data_detect.yaml", arcname="data_detect.yaml")
        tf.add(CLOUD / "requirements.txt", arcname="requirements.txt")
    try:
        scp_to_pod(env, bundle)
    finally:
        bundle.unlink(missing_ok=True)
    ssh_run(
        env,
        # --no-same-owner: the tarball carries the Mac's uid/gid, which don't
        # mean anything on the instance — skip trying to preserve them.
        "cd /workspace && mkdir -p raw_frames && tar xzf _send_bundle.tgz --no-same-owner && "
        "chmod +x remote_pipeline.sh && rm -f _send_bundle.tgz",
        capture=False,
    )


def wait_for_ssh(env: dict, timeout: float = 300, interval: float = 10) -> None:
    deadline = time.time() + timeout
    last_detail = ""
    while time.time() < deadline:
        ok, detail = ssh_probe(env)
        if ok:
            print("  instance is reachable over SSH")
            return
        if detail != last_detail:
            print(f"  not reachable yet ({detail or 'no response'})…")
            last_detail = detail
        time.sleep(interval)
    raise RuntimeError(
        f"Instance did not become reachable over SSH in time (last error: "
        f"{last_detail or 'none'}) — check it's RUNNING in the GCP console, or "
        "rerun `orchestrate.py --setup` if something looks misconfigured."
    )


def launch_remote_pipeline(env: dict, stage: str, log_name: str) -> None:
    """Launch remote_pipeline.sh <stage> via nohup+disown, then verify it
    actually started before the caller commits to a multi-hour poll loop.
    Seen in practice: the SSH session backing the launch command itself can
    reset ("Connection reset by peer") mid-command — if that happens before
    the remote shell got to background the job, nothing is running and
    polling for its completion marker would just spin uselessly for hours.
    Checks first (not just retries blindly) before each launch attempt, so
    a verification hiccup alone can't cause a duplicate/racing second launch."""
    cmd = f"cd /workspace && nohup bash remote_pipeline.sh {stage} > {log_name} 2>&1 < /dev/null & disown"
    for attempt in (1, 2):
        check = ssh_run(env, "pgrep -f remote_pipeline.sh")
        if check.returncode == 0 and (check.stdout or "").strip():
            print("  confirmed remote_pipeline.sh is running.")
            return
        try:
            ssh_run(env, cmd, capture=False, timeout=30)
        except subprocess.TimeoutExpired:
            print(f"  [WARN] launch command itself timed out (attempt {attempt}/2)…")
        time.sleep(5)
        check = ssh_run(env, "pgrep -f remote_pipeline.sh")
        if check.returncode == 0 and (check.stdout or "").strip():
            print("  confirmed remote_pipeline.sh is running.")
            return
        print(
            f"  [WARN] couldn't confirm the remote pipeline started (attempt {attempt}/2, "
            "likely an SSH hiccup during launch, not a real failure)"
            + (" — retrying…" if attempt == 1 else ".")
        )
    raise RuntimeError(
        f"Could not confirm remote_pipeline.sh ({stage}) actually started on the "
        "instance after 2 attempts — refusing to poll for hours on a marker that "
        "might never appear. Check manually with: gcloud compute ssh ... --command="
        "'pgrep -af remote_pipeline.sh'"
    )


def poll_for_done(env: dict, deadline: float, marker: str = "/workspace/PIPELINE_DONE",
                   log_name: str | None = None) -> str | None:
    while True:
        r = ssh_run(env, f"cat {marker} 2>/dev/null || true")
        out = (r.stdout or "").strip()
        if out:
            return out
        if time.time() > deadline:
            return None
        remaining_h = (deadline - time.time()) / 3600
        progress = ""
        if log_name:
            lr = ssh_run(env, f"tail -1 /workspace/{log_name} 2>/dev/null || true")
            line = (lr.stdout or "").strip()
            if line:
                progress = f"\n    {line[:200]}"
        print(f"  still running… ({remaining_h:.1f}h left before the safety timeout){progress}")
        time.sleep(POLL_INTERVAL_S)


def pull_results_from_pod(env: dict) -> dict:
    """Best-effort: pulls back whatever exists (weights, summary, log) even
    on a failed run, so the failure notification has something to say."""
    # train_detect.py records its ACTUAL resolved output dir to
    # train_output_dir.txt — don't hardcode runs/bow_detect/train/, since
    # ultralytics' own project/name resolution can land elsewhere (observed:
    # runs/detect/runs/bow_detect/train on a real pod, not runs/bow_detect/train).
    r = ssh_run(env, "cd /workspace && cat train_output_dir.txt 2>/dev/null || true")
    save_dir = (r.stdout or "").strip() or "runs/bow_detect/train"
    weights_rel = f"{save_dir}/weights/best.pt"
    results_rel = f"{save_dir}/results.csv"

    ssh_run(
        env,
        f"cd /workspace && tar czf _results_bundle.tgz --ignore-failed-read "
        f"{shlex.quote(weights_rel)} {shlex.quote(results_rel)} "
        "pipeline_summary.json keeplist.json PIPELINE_DONE pipeline.log",
        capture=False,
    )
    staging = CLOUD / "_recv_staging"
    if staging.exists():
        shutil.rmtree(staging)
    try:
        scp_from_pod(env, "/workspace/_results_bundle.tgz", staging)
    except Exception as e:
        print(f"  [WARN] could not pull results bundle: {e}")
        return {}

    bundle = staging / "_results_bundle.tgz"
    if not bundle.exists():
        return {}
    with tarfile.open(bundle) as tf:
        tf.extractall(staging)

    summary = {}
    # train_output_dir.txt is ultralytics' resolved (absolute) save_dir, so
    # weights_rel can be absolute too — Path(staging) / "/abs/path" discards
    # staging entirely (pathlib joins to an absolute RHS verbatim), silently
    # pointing at a nonexistent path on THIS machine instead of where
    # tarfile.extractall() actually put the file. Always join as relative.
    weights_src = staging / weights_rel.lstrip("/")
    if weights_src.exists():
        shutil.copy(weights_src, ROOT / "best.pt")
    else:
        # Don't leave this a mystery: show exactly what training run
        # directories/weights DO exist on the instance instead of just
        # "best.pt missing" downstream.
        r = ssh_run(env, "cd /workspace && (find runs -maxdepth 6 2>&1 || echo 'no runs/ dir at all')")
        print(f"  [WARN] best.pt not in the pulled bundle (looked for {weights_src}). "
              f"Instance-side /workspace/runs tree:\n{r.stdout}")
    for name in ("pipeline_summary.json", "keeplist.json"):
        src = staging / name
        if src.exists():
            shutil.copy(src, CLOUD / name)
    summary_path = staging / "pipeline_summary.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_text())
    log_src = staging / "pipeline.log"
    if log_src.exists():
        shutil.copy(log_src, CLOUD / "pipeline.log")
    return summary


def pull_label_preview(env: dict, sample_size: int = 60) -> tuple[dict, Path | None]:
    """Pulls back label_summary.json + keeplist.json + a bounded sample of
    the frames that survived filtering (bow+violin boxes drawn), so you can
    eyeball auto-labeling AND the filter's decisions together — filtering
    now runs as part of the label stage, so this is the same set
    train_detect.py will actually train on, not raw unfiltered labels. Not
    the whole set, which could be thousands of frames."""
    # Only attempt to build a "what survived filtering" sample if filtering
    # actually ran — auto_keeplist.py may never have produced keeplist.json
    # if an earlier stage (most likely autolabel.py) failed first, and
    # sample_annotated.py would otherwise crash trying to read a keeplist
    # that doesn't exist. That crash previously aborted the whole remote
    # command (it's `&&`-chained), so the results tarball never even got
    # built, which then made the scp pull fail too — cascading into
    # confusing secondary errors that buried the real failure.
    has_keeplist = ssh_run(env, "test -f /workspace/keeplist.json").returncode == 0
    if has_keeplist:
        ssh_run(
            env,
            f"cd /workspace && python3 sample_annotated.py --dataset dataset "
            f"--keeplist keeplist.json --cap {sample_size} --out _label_preview.tgz",
            capture=False,
        )
    ssh_run(
        env,
        "cd /workspace && tar czf _label_bundle.tgz --ignore-failed-read "
        "_label_preview.tgz label_summary.json keeplist.json LABEL_DONE label.log",
        capture=False,
    )
    staging = CLOUD / "_recv_staging"
    if staging.exists():
        shutil.rmtree(staging)
    try:
        scp_from_pod(env, "/workspace/_label_bundle.tgz", staging)
    except Exception as e:
        print(f"  [WARN] could not pull label preview bundle: {e}")
        return {}, None

    bundle = staging / "_label_bundle.tgz"
    if not bundle.exists():
        return {}, None
    with tarfile.open(bundle) as tf:
        tf.extractall(staging)

    summary = {}
    summary_path = staging / "label_summary.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_text())
    log_src = staging / "label.log"
    if log_src.exists():
        shutil.copy(log_src, CLOUD / "label.log")
    keeplist_src = staging / "keeplist.json"
    if keeplist_src.exists():
        shutil.copy(keeplist_src, CLOUD / "keeplist.json")

    preview_dir = None
    sample_tar = staging / "_label_preview.tgz"
    if sample_tar.exists():
        preview_dir = CLOUD / "label_preview"
        if preview_dir.exists():
            shutil.rmtree(preview_dir)
        preview_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(sample_tar) as tf:
            tf.extractall(preview_dir)

    return summary, preview_dir


# ── pending-review state (between the label checkpoint and --continue) ──────

PENDING_REVIEW_PATH = CLOUD / "_pending_review.json"


def save_pending_review(video_names: list[str]) -> None:
    PENDING_REVIEW_PATH.write_text(json.dumps({"videos": sorted(set(video_names))}, indent=2))


def load_pending_review() -> list[str]:
    if not PENDING_REVIEW_PATH.exists():
        return []
    return json.loads(PENDING_REVIEW_PATH.read_text()).get("videos", [])


def clear_pending_review() -> None:
    PENDING_REVIEW_PATH.unlink(missing_ok=True)


def run_coreml_export() -> None:
    weights = ROOT / "best.pt"
    if not weights.exists():
        raise RuntimeError("best.pt missing — nothing to export")
    cmd = [sys.executable, str(ROOT / "export_coreml.py"), "--weights", str(weights)]
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        raise RuntimeError("export_coreml.py failed")


# ── notification ─────────────────────────────────────────────────────────────

def _ascript_quote(s: str) -> str:
    """Build a double-quoted AppleScript string literal by hand rather than
    via json.dumps: JSON *always* escapes control chars (e.g. a raw ESC
    byte, which pip/ultralytics/etc. sometimes emit for ANSI color codes
    even when stdout is redirected to a file, easily present in a captured
    log tail) as \\u001b — a valid JSON escape AppleScript's parser doesn't
    understand at all, producing "Expected "" but found unknown token"
    instead of showing the notification. AppleScript only recognizes \\"
    and \\\\ as string escapes, so: strip non-printable chars, then
    hand-escape just those two."""
    printable = "".join(ch for ch in s if ch == "\t" or (0x20 <= ord(ch) and ord(ch) != 0x7F))
    escaped = printable.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def notify(title: str, message: str, sound: str = "Glass") -> None:
    script = (
        f"display notification {_ascript_quote(message)} "
        f"with title {_ascript_quote(title)} sound name {_ascript_quote(sound)}"
    )
    subprocess.run(["osascript", "-e", script])
    print(f"\n[{title}] {message}")


def notify_label_done(summary: dict, preview_dir: Path | None, elapsed_m: float) -> None:
    stats = summary.get("autolabel_stats", {}) or {}
    kl = summary.get("keeplist_stats", {}) or {}
    where = f" Preview: {preview_dir}." if preview_dir else ""
    msg = (
        f"{stats.get('labeled', '?')} labeled, {kl.get('kept_clean', '?')} kept after "
        f"filtering ({kl.get('dropped_flag2', 0)} area outliers, "
        f"{kl.get('dropped_width_outlier', 0)} width outliers dropped). "
        f"{elapsed_m:.0f} min. Instance stopped (cheap while you look).{where} "
        "Review, then run `orchestrate.py --continue` to train."
    )
    notify("StringAI auto-labeling + filtering done", msg)


def notify_success(summary: dict, elapsed_m: float) -> None:
    stats = summary.get("autolabel_stats", {}) or {}
    kl = summary.get("keeplist_stats", {}) or {}
    final = summary.get("final_epoch", {}) or {}
    map50 = final.get("metrics/mAP50(B)", "?")
    msg = (
        f"{stats.get('labeled', '?')} frames labeled, {kl.get('kept_clean', '?')} kept clean. "
        f"mAP50={map50}. {elapsed_m:.0f} min total. "
        f"best.pt + CoreML export in ml/. Review before copying into the app."
    )
    notify("StringAI training done", msg)


def notify_failure(detail: str, elapsed_m: float, log_name: str = "pipeline.log") -> None:
    # Callers delete their stage's local log file before starting, so if it
    # exists here it's guaranteed fresh from *this* run — otherwise a
    # failure that happens before any instance-side log gets pulled (e.g.
    # the dependency bootstrap) would show a stale, misleading tail from a
    # previous run instead of correctly showing none.
    log_path = CLOUD / log_name
    tail = ""
    if log_path.exists():
        lines = log_path.read_text(errors="replace").splitlines()
        tail = " | ".join(lines[-5:])
    msg = f"{detail[:200]} ({elapsed_m:.0f} min elapsed). Instance stopped."
    if tail:
        msg += f" Log tail: {tail[:300]}"
    notify("StringAI training FAILED", msg)


# ── main ─────────────────────────────────────────────────────────────────────

def run_label_stage(env: dict, args: argparse.Namespace) -> None:
    """Default flow: extract new videos, auto-label + auto-filter them on
    the instance, stop the instance, and notify — WITHOUT training yet.
    Filtering runs here (not in --continue) so the preview you review
    reflects the actual frames train_detect.py will see, not raw unfiltered
    labels. You review the preview sample, then run `--continue` to do the
    (expensive) rest."""
    pending_before = load_pending_review()
    new_videos = discover_new_videos()
    if not new_videos:
        if pending_before:
            print(
                f"No new videos, but {len(pending_before)} already-labeled video(s) are "
                f"waiting on review: {', '.join(pending_before)}. Run --continue to train."
            )
        else:
            print("No new videos in ml/videos/ — nothing to do.")
        return
    print(f"{len(new_videos)} new video(s): {', '.join(p.name for p in new_videos)}")

    (CLOUD / "label.log").unlink(missing_ok=True)  # so a failure before any instance-side
                                                    # log is pulled doesn't show a stale one

    t_start = time.time()
    pod_started = False
    outcome = "FAILED"
    detail = ""
    summary: dict = {}
    preview_dir: Path | None = None
    try:
        already_extracted = load_extracted()
        to_extract = [p for p in new_videos if p.name not in already_extracted]
        if to_extract:
            run_extract(to_extract)
            mark_extracted(to_extract)
        else:
            print("All new video(s) already extracted locally from an earlier attempt — skipping re-extraction.")
        video_ids = [video_id_from_path(p) for p in new_videos]

        print("Starting instance…")
        start_instance(env)
        pod_started = True
        wait_for_ssh(env)
        ensure_pod_ready(env, interactive=False)

        push_bundle_to_pod(env, video_ids)

        print("Launching auto-labeling + filtering…")
        launch_remote_pipeline(env, "label", "label.log")

        print("Polling for auto-labeling to finish…")
        marker = poll_for_done(env, deadline=t_start + args.wall_clock_cap, marker="/workspace/LABEL_DONE",
                                log_name="label.log")

        summary, preview_dir = pull_label_preview(env)

        if marker and marker.strip() == "OK":
            outcome = "OK"
            save_pending_review(pending_before + [p.name for p in new_videos])
        else:
            detail = marker or "timed out waiting for the instance"
    except Exception as e:
        detail = str(e)
    finally:
        if pod_started:
            print("Stopping instance…")
            gcloud_cmd(["compute", "instances", "stop", env["GCE_INSTANCE_NAME"], *gce_instance_base(env)])

    elapsed_m = (time.time() - t_start) / 60
    if outcome == "OK":
        notify_label_done(summary, preview_dir, elapsed_m)
    else:
        notify_failure(detail, elapsed_m, log_name="label.log")
        sys.exit(1)


def run_train_stage(env: dict, args: argparse.Namespace) -> None:
    """`--continue` flow: train on whatever the instance already auto-labeled
    AND filtered (both happen in the label stage now), then export CoreML
    and notify."""
    pending = load_pending_review()
    if not pending:
        sys.exit(
            "No pending auto-labeled run found (ml/cloud/_pending_review.json "
            "missing). Run `python orchestrate.py` first to auto-label new videos."
        )
    print(f"Continuing with {len(pending)} previously-labeled video(s): {', '.join(pending)}")

    t_start = time.time()
    pod_started = False
    outcome = "FAILED"
    detail = ""
    summary: dict = {}
    try:
        print("Starting instance…")
        start_instance(env)
        pod_started = True
        wait_for_ssh(env)
        ensure_pod_ready(env, interactive=False)

        print("Launching training…")
        launch_remote_pipeline(env, "train", "pipeline.log")

        print("Polling for completion — this can take a while…")
        marker = poll_for_done(env, deadline=t_start + args.wall_clock_cap, marker="/workspace/PIPELINE_DONE",
                                log_name="pipeline.log")

        summary = pull_results_from_pod(env)

        if marker and marker.strip() == "OK":
            # run_coreml_export() first, and outcome/side effects only after
            # it succeeds — it can raise (e.g. best.pt didn't actually get
            # pulled), and setting outcome = "OK" or clearing pending-review
            # state before that's confirmed would report false success *and*
            # throw away the ability to just retry via --continue.
            run_coreml_export()
            outcome = "OK"
            mark_processed([VIDEOS_DIR / name for name in pending])
            clear_pending_review()
        else:
            detail = marker or "timed out waiting for the instance"
    except Exception as e:
        detail = str(e)
    finally:
        if pod_started:
            print("Stopping instance…")
            gcloud_cmd(["compute", "instances", "stop", env["GCE_INSTANCE_NAME"], *gce_instance_base(env)])

    elapsed_m = (time.time() - t_start) / 60
    if outcome == "OK":
        notify_success(summary, elapsed_m)
    else:
        notify_failure(detail, elapsed_m)
        sys.exit(1)


# ── single-instance lock ─────────────────────────────────────────────────────
#
# Two orchestrate.py invocations racing against the same instance is a real,
# observed footgun: autolabel.py locks in its list of frames to process at
# startup, so a second run's newly-pushed videos can silently never get
# labeled while the second run still sees the *first* run's remote_pipeline.sh
# already going, assumes that's its own launch, waits for its LABEL_DONE, and
# incorrectly marks its videos "successfully labeled" — no error, just wrong.

LOCK_PATH = CLOUD / ".orchestrate.lock"


def acquire_lock() -> None:
    if LOCK_PATH.exists():
        pid = None
        try:
            pid = int(LOCK_PATH.read_text().strip())
        except ValueError:
            pass
        alive = False
        if pid is not None:
            try:
                os.kill(pid, 0)  # signal 0: just checks the process exists
                alive = True
            except OSError:
                alive = False
        if alive:
            sys.exit(
                f"Another orchestrate.py is already running (pid {pid}). Running two at "
                "once against the same instance can race — see the comment above "
                "acquire_lock() for exactly how. Wait for it to finish, or if you're sure "
                f"it's not actually running anymore, delete {LOCK_PATH} and retry."
            )
        print(f"[WARN] stale lock file (pid {pid} not running) — removing and continuing.")
    LOCK_PATH.write_text(str(os.getpid()))


def release_lock() -> None:
    LOCK_PATH.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the bow-detector training pipeline against a GCE instance.")
    parser.add_argument("--setup", action="store_true", help="Force the interactive setup wizard even if .env looks complete")
    parser.add_argument("--continue", dest="do_continue", action="store_true",
                        help="Resume after the auto-labeling checkpoint: train on what's already labeled + filtered on the instance")
    parser.add_argument("--wall-clock-cap", type=int, default=WALL_CLOCK_CAP_S,
                        help="Max seconds to wait for each remote stage before giving up (default 6h)")
    args = parser.parse_args()

    acquire_lock()
    try:
        env = load_env()
        if args.setup or any(k not in env for k in REQUIRED_KEYS):
            env = run_setup_wizard(env)

        if args.do_continue:
            run_train_stage(env, args)
        else:
            run_label_stage(env, args)
    finally:
        release_lock()


if __name__ == "__main__":
    main()
