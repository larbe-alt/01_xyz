"""
Training harness — time-split, LightGBM training, model export.

Standard quant-ML practices:
  - Time-based split (no random shuffle — preserves temporal structure)
  - Purge gap between train/test (avoids label leakage at the boundary)
  - Export to custom JSON tree format for TS inference (no ONNX dependency)
"""

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import polars as pl

try:
    import lightgbm as lgb
except ImportError:
    lgb = None  # type: ignore


from .features import FEATURE_NAMES
from .config import DEFAULT_PURGE_MS, DEFAULT_TEST_FRACTION


@dataclass
class TrainConfig:
    label: str = "fwd_return_sign_5s"
    objective: str = "binary"
    feature_names: list[str] | None = None
    test_fraction: float = DEFAULT_TEST_FRACTION
    purge_ms: int = DEFAULT_PURGE_MS
    # LightGBM params
    num_leaves: int = 31
    learning_rate: float = 0.05
    n_estimators: int = 200
    min_child_samples: int = 50
    subsample: float = 0.8
    colsample_bytree: float = 0.8
    reg_alpha: float = 0.1
    reg_lambda: float = 1.0


@dataclass
class TrainResult:
    model: object  # lgb.Booster
    feature_names: list[str]
    train_metrics: dict
    test_metrics: dict
    feature_importance: dict[str, float]


def time_split(
    df: pl.DataFrame,
    test_fraction: float = 0.2,
    purge_ms: int = 60_000,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """
    Split dataset by time with a purge gap.

    The purge gap removes rows between train and test to prevent label leakage
    (a label at the end of train could overlap with the test period).
    """
    df = df.sort("ts")
    n = len(df)
    split_idx = int(n * (1 - test_fraction))

    train = df[:split_idx]
    if len(train) == 0:
        raise ValueError("Train set is empty")

    train_end_ts = train["ts"][-1]
    purge_start = train_end_ts - purge_ms

    # Remove rows in purge zone from train
    train = train.filter(pl.col("ts") < purge_start)
    test = df[split_idx:]

    return train, test


def train_model(df: pl.DataFrame, config: TrainConfig | None = None) -> TrainResult:
    """
    Train a LightGBM model on the dataset.

    Args:
        df: polars DataFrame with features + labels (from build_dataset)
        config: training configuration

    Returns:
        TrainResult with model, metrics, and feature importance
    """
    if lgb is None:
        raise ImportError("lightgbm is required for training: pip install lightgbm")

    cfg = config or TrainConfig()
    features = cfg.feature_names or FEATURE_NAMES
    label = cfg.label

    # Drop rows with null labels (end of dataset where forward labels can't be computed)
    clean = df.drop_nulls(subset=[label])
    if len(clean) < 100:
        raise ValueError(f"Too few valid samples ({len(clean)}) after dropping null labels")

    train_df, test_df = time_split(clean, cfg.test_fraction, cfg.purge_ms)

    X_train = train_df.select(features).to_numpy()
    y_train = train_df[label].to_numpy()
    X_test = test_df.select(features).to_numpy()
    y_test = test_df[label].to_numpy()

    # Replace any remaining NaN/inf with 0
    X_train = np.nan_to_num(X_train, nan=0.0, posinf=0.0, neginf=0.0)
    X_test = np.nan_to_num(X_test, nan=0.0, posinf=0.0, neginf=0.0)

    params = {
        "objective": cfg.objective,
        "num_leaves": cfg.num_leaves,
        "learning_rate": cfg.learning_rate,
        "n_estimators": cfg.n_estimators,
        "min_child_samples": cfg.min_child_samples,
        "subsample": cfg.subsample,
        "colsample_bytree": cfg.colsample_bytree,
        "reg_alpha": cfg.reg_alpha,
        "reg_lambda": cfg.reg_lambda,
        "verbosity": -1,
    }

    model = lgb.LGBMClassifier(**params) if cfg.objective == "binary" else lgb.LGBMRegressor(**params)
    model.fit(X_train, y_train, eval_set=[(X_test, y_test)])

    # Metrics
    train_pred = model.predict_proba(X_train)[:, 1] if cfg.objective == "binary" else model.predict(X_train)
    test_pred = model.predict_proba(X_test)[:, 1] if cfg.objective == "binary" else model.predict(X_test)

    train_metrics = _compute_metrics(y_train, train_pred, cfg.objective)
    test_metrics = _compute_metrics(y_test, test_pred, cfg.objective)

    # Feature importance
    importance = dict(zip(features, model.feature_importances_.tolist()))
    total = sum(importance.values()) or 1.0
    importance = {k: v / total for k, v in importance.items()}

    return TrainResult(
        model=model.booster_,
        feature_names=features,
        train_metrics=train_metrics,
        test_metrics=test_metrics,
        feature_importance=importance,
    )


def export_model(result: TrainResult, path: str, metadata: dict | None = None) -> None:
    """
    Export trained model to the custom JSON tree format for TS inference.

    The format is defined in research/spec/model_format.json.
    """
    booster = result.model
    model_json = booster.dump_model()

    trees = []
    for tree_info in model_json["tree_info"]:
        tree = tree_info["tree_structure"]
        nodes: list[dict] = []
        _flatten_tree(tree, nodes)
        trees.append({"nodes": nodes})

    output = {
        "version": 1,
        "model_type": "gbdt",
        "objective": model_json.get("objective", "unknown"),
        "feature_names": result.feature_names,
        "base_score": 0.0,
        "learning_rate": model_json.get("learning_rate", 0.1),
        "trees": trees,
        "metadata": {
            "feature_importance": result.feature_importance,
            "train_metrics": result.train_metrics,
            "test_metrics": result.test_metrics,
            **(metadata or {}),
        },
    }

    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2))


def _flatten_tree(node: dict, out: list[dict]) -> int:
    """Recursively flatten a LightGBM tree into the flat node-array format."""
    idx = len(out)
    if "leaf_value" in node:
        out.append({"v": node["leaf_value"]})
        return idx

    # Split node — reserve slot, then recurse
    out.append({})  # placeholder
    left_idx = _flatten_tree(node["left_child"], out)
    right_idx = _flatten_tree(node["right_child"], out)
    out[idx] = {
        "f": node["split_feature"],
        "t": node["threshold"],
        "l": left_idx,
        "r": right_idx,
    }
    return idx


def _compute_metrics(y_true: np.ndarray, y_pred: np.ndarray, objective: str) -> dict:
    """Compute evaluation metrics."""
    if objective == "binary":
        y_class = (y_pred > 0.5).astype(int)
        accuracy = float(np.mean(y_class == y_true))
        # Log loss
        eps = 1e-15
        y_pred_clip = np.clip(y_pred, eps, 1 - eps)
        logloss = -float(np.mean(y_true * np.log(y_pred_clip) + (1 - y_true) * np.log(1 - y_pred_clip)))
        return {"accuracy": accuracy, "logloss": logloss, "n_samples": len(y_true)}
    else:
        mse = float(np.mean((y_true - y_pred) ** 2))
        corr = float(np.corrcoef(y_true, y_pred)[0, 1]) if len(y_true) > 1 else 0.0
        return {"mse": mse, "correlation": corr, "n_samples": len(y_true)}
