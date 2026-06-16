"""Shared constants and paths for the research pipeline."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC_DIR = REPO_ROOT / "research" / "spec"
FEATURE_SPEC_PATH = SPEC_DIR / "features.json"
DATA_DIR = REPO_ROOT / "data"
ARTIFACTS_DIR = REPO_ROOT / "research" / "artifacts"

# Dataset defaults
DEFAULT_SAMPLE_MS = 1000  # compute features every 1s
DEFAULT_PURGE_MS = 60_000  # 60s gap between train/test to avoid label leakage
DEFAULT_TEST_FRACTION = 0.2
