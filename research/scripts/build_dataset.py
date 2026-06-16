"""
CLI: build a feature+label dataset from recorded parquet data.

Usage:
    python -m scripts.build_dataset --symbol ETHUSD --env mainnet [--dir data] [--sample-ms 1000] [--out dataset.parquet]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.dataset import build_dataset


def main():
    parser = argparse.ArgumentParser(description="Build quant-ML dataset from recorded market data")
    parser.add_argument("--symbol", required=True, help="Market symbol (e.g. ETHUSD)")
    parser.add_argument("--env", default="mainnet", help="Environment (mainnet/devnet)")
    parser.add_argument("--dir", default="data", help="Path to data/ directory")
    parser.add_argument("--sample-ms", type=int, default=1000, help="Feature sample interval in ms")
    parser.add_argument("--from-ts", type=int, default=None, help="Start timestamp filter (ms)")
    parser.add_argument("--to-ts", type=int, default=None, help="End timestamp filter (ms)")
    parser.add_argument("--out", default=None, help="Output parquet path (default: research/datasets/<symbol>.parquet)")
    args = parser.parse_args()

    out_path = args.out or str(Path(__file__).resolve().parents[1] / "datasets" / f"{args.symbol}.parquet")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)

    print(f"Building dataset for {args.symbol} ({args.env}) sample={args.sample_ms}ms ...")
    df = build_dataset(
        data_dir=args.dir,
        env=args.env,
        symbol=args.symbol,
        sample_ms=args.sample_ms,
        from_ts=args.from_ts,
        to_ts=args.to_ts,
    )

    df.write_parquet(out_path)
    print(f"Dataset: {len(df)} rows, {len(df.columns)} columns")
    print(f"Columns: {df.columns}")
    print(f"Time range: {df['ts'].min()} — {df['ts'].max()}")
    print(f"Saved to {out_path}")

    # Quick stats
    for col in df.columns:
        if col in ("ts",):
            continue
        s = df[col].drop_nulls()
        if len(s) > 0:
            print(f"  {col:30s}  mean={s.mean():12.6f}  std={s.std():12.6f}  null={df[col].null_count()}")


if __name__ == "__main__":
    main()
