#!/usr/bin/env python3
"""MRMS Correlation Coefficient (CC/RhoHV) tile pipeline.

Downloads latest MRMS MergedRhoHV GRIB2 from NOAA, converts to colored
GeoTIFF, generates z3-z7 map tiles, serves via FastAPI static mount.

Designed to run as a cron job every 5 minutes. Single-process, no queue.
Keeps only the last 3 frames to avoid storage bloat.

Usage:
    python3 cc_pipeline.py              # run once
    python3 cc_pipeline.py --daemon     # run every 5 min
"""
import argparse
import gzip
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [cc_pipeline] %(levelname)s: %(message)s",
)
logger = logging.getLogger("cc_pipeline")

# --- Configuration ---
MRMS_URL = "https://mrms.ncep.noaa.gov/2D/MergedRhoHV/MRMS_MergedRhoHV.latest.grib2.gz"
TILE_DIR = Path("/opt/storm-tracker/data/cc_tiles")
WORK_DIR = Path("/tmp/cc_pipeline")
MAX_FRAMES = 3
ZOOM_LEVELS = "3-7"
POLL_INTERVAL = 300  # 5 minutes

# CC color table: value R G B Alpha
# RhoHV: 0=no data, <0.80=debris/non-met, 0.80-0.90=hail, 0.90-0.97=rain, >0.97=pure rain
CC_COLORS = """nv 0 0 0 0
-999 0 0 0 0
0.00 0 0 0 0
0.20 139 0 0 180
0.50 255 0 0 200
0.70 255 140 0 200
0.80 255 215 0 200
0.85 255 255 100 200
0.90 173 216 230 200
0.95 100 149 237 200
0.97 30 144 255 220
1.00 0 0 255 220
1.05 0 0 139 220
"""


def run_pipeline() -> bool:
    """Execute one pipeline cycle. Returns True on success."""
    start = time.monotonic()
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    TILE_DIR.mkdir(parents=True, exist_ok=True)

    try:
        # 1. Download
        gz_path = WORK_DIR / "mrms_cc.grib2.gz"
        logger.info("Downloading MRMS MergedRhoHV...")
        result = subprocess.run(
            ["curl", "-sf", "-m", "30", "-o", str(gz_path), MRMS_URL],
            capture_output=True, text=True, timeout=45,
        )
        if result.returncode != 0 or not gz_path.exists() or gz_path.stat().st_size < 1000:
            logger.error(f"Download failed: {result.stderr}")
            return False

        # 2. Gunzip
        grib_path = WORK_DIR / "mrms_cc.grib2"
        with gzip.open(gz_path, "rb") as f_in:
            with open(grib_path, "wb") as f_out:
                f_out.write(f_in.read())

        # Extract timestamp from GRIB metadata
        ts = _extract_timestamp(grib_path)
        if not ts:
            ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        frame_id = ts.replace("-", "").replace(":", "").replace("T", "")
        logger.info(f"Frame timestamp: {ts} (id: {frame_id})")

        # Skip if this frame already exists
        frame_dir = TILE_DIR / frame_id
        if frame_dir.exists():
            logger.info(f"Frame {frame_id} already processed, skipping")
            return True

        # 3. Write color table
        colors_path = WORK_DIR / "cc_colors.txt"
        colors_path.write_text(CC_COLORS)

        # 4. Convert GRIB2 → raw GeoTIFF
        raw_tif = WORK_DIR / "cc_raw.tif"
        _run_cmd(["gdal_translate", "-of", "GTiff", "-a_nodata", "-999",
                  str(grib_path), str(raw_tif)])

        # 5. Apply color relief
        colored_tif = WORK_DIR / "cc_colored.tif"
        _run_cmd(["gdaldem", "color-relief", str(raw_tif), str(colors_path),
                  str(colored_tif), "-alpha", "-of", "GTiff"])

        # 6. Reproject to EPSG:3857
        web_tif = WORK_DIR / "cc_3857.tif"
        _run_cmd(["gdalwarp", "-t_srs", "EPSG:3857", "-r", "near",
                  "-of", "GTiff", str(colored_tif), str(web_tif)])

        # 7. Generate tiles
        temp_tiles = WORK_DIR / "tiles"
        if temp_tiles.exists():
            shutil.rmtree(temp_tiles)
        _run_cmd(["gdal2tiles.py", "-z", ZOOM_LEVELS, "-w", "none", "--xyz",
                  str(web_tif), str(temp_tiles)])

        # 8. Atomic move to serving directory
        if frame_dir.exists():
            shutil.rmtree(frame_dir)
        shutil.move(str(temp_tiles), str(frame_dir))

        # 9. Update "latest" symlink
        latest_link = TILE_DIR / "latest"
        if latest_link.is_symlink() or latest_link.exists():
            latest_link.unlink()
        latest_link.symlink_to(frame_id)

        # 10. Write metadata
        meta = {
            "frame_id": frame_id,
            "timestamp": ts,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "tile_count": sum(1 for _ in frame_dir.rglob("*.png")),
            "zoom_levels": ZOOM_LEVELS,
        }
        (TILE_DIR / "metadata.json").write_text(json.dumps(meta, indent=2))

        # 11. Cleanup old frames
        _cleanup_old_frames()

        elapsed = time.monotonic() - start
        logger.info(f"Pipeline complete: {meta['tile_count']} tiles in {elapsed:.1f}s")
        return True

    except Exception as e:
        logger.error(f"Pipeline failed: {e}")
        return False
    finally:
        # Clean work directory
        for f in WORK_DIR.glob("*"):
            if f.is_file():
                f.unlink()


def _extract_timestamp(grib_path: Path) -> str | None:
    """Extract valid time from GRIB2 metadata via gdalinfo."""
    try:
        result = subprocess.run(
            ["gdalinfo", str(grib_path)],
            capture_output=True, text=True, timeout=10,
        )
        for line in result.stdout.splitlines():
            if "GRIB_VALID_TIME" in line:
                epoch = int(line.split("=")[-1].strip())
                dt = datetime.fromtimestamp(epoch, tz=timezone.utc)
                return dt.strftime("%Y%m%dT%H%M%SZ")
    except Exception:
        pass
    return None


def _run_cmd(cmd: list[str]):
    """Run a shell command, raise on failure."""
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{result.stderr}")


def _cleanup_old_frames():
    """Remove old frames, keeping only MAX_FRAMES most recent."""
    frames = sorted([
        d for d in TILE_DIR.iterdir()
        if d.is_dir() and d.name != "latest" and not d.is_symlink()
    ])
    while len(frames) > MAX_FRAMES:
        old = frames.pop(0)
        logger.info(f"Removing old frame: {old.name}")
        shutil.rmtree(old)


def daemon_loop():
    """Run pipeline on a loop every POLL_INTERVAL seconds."""
    logger.info(f"CC pipeline daemon started (interval: {POLL_INTERVAL}s)")
    while True:
        try:
            run_pipeline()
        except Exception as e:
            logger.error(f"Pipeline error: {e}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MRMS CC Tile Pipeline")
    parser.add_argument("--daemon", action="store_true", help="Run continuously")
    args = parser.parse_args()

    if args.daemon:
        daemon_loop()
    else:
        success = run_pipeline()
        sys.exit(0 if success else 1)
