"""
CLI: train a model on a pre-built dataset.

Usage:
    python -m scripts.train_model --dataset research/datasets/ETHUSD.parquet [--label fwd_return_sign_5s] [--out research/artifacts/model.json]
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import polars as pl
from src.train import TrainConfig, train_model, export_model


def main():
    parser = argparse.ArgumentParser(description="Train quant-ML model on dataset")
    parser.add_argument("--dataset", required=True, help="Path to dataset parquet")
    parser.add_argument("--label", default="fwd_return_sign_5s", help="Label column to predict")
    parser.add_argument("--objective", default="binary", choices=["binary", "regression"], help="Learning objective")
    parser.add_argument("--n-estimators", type=int, default=200, help="Number of boosting rounds")
    parser.add_argument("--lr", type=float, default=0.05, help="Learning rate")
    parser.add_argument("--test-fraction", type=float, default=0.2, help="Test set fraction")
    parser.add_argument("--purge-ms", type=int, default=60000, help="Purge gap between train/test (ms)")
    parser.add_argument("--out", default=None, help="Output model JSON path")
    args = parser.parse_args()

    df = pl.read_parquet(args.dataset)
    print(f"Loaded dataset: {len(df)} rows, {len(df.columns)} columns")

    config = TrainConfig(
        label=args.label,
        objective=args.objective,
        n_estimators=args.n_estimators,
        learning_rate=args.lr,
        test_fraction=args.test_fraction,
        purge_ms=args.purge_ms,
    )

    print(f"Training {config.objective} model on label={config.label} ...")
    result = train_model(df, config)

    print(f"\n── Train metrics ──")
    for k, v in result.train_metrics.items():
        print(f"  {k}: {v:.6f}" if isinstance(v, float) else f"  {k}: {v}")

    print(f"\n── Test metrics ──")
    for k, v in result.test_metrics.items():
        print(f"  {k}: {v:.6f}" if isinstance(v, float) else f"  {k}: {v}")

    print(f"\n── Feature importance ──")
    sorted_imp = sorted(result.feature_importance.items(), key=lambda x: -x[1])
    for name, imp in sorted_imp:
        bar = "#" * int(imp * 50)
        print(f"  {name:30s}  {imp:.3f}  {bar}")

    out_path = args.out or str(Path(__file__).resolve().parents[1] / "artifacts" / f"{args.label}.json")
    export_model(result, out_path, metadata={
        "dataset": args.dataset,
        "label": args.label,
    })
    print(f"\nModel exported to {out_path}")


if __name__ == "__main__":
    main()
