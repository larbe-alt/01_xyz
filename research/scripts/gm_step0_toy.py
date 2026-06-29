#!/usr/bin/env python
"""gm_step0_toy.py — Glosten-Milgrom Step 0: toy simulator of the model itself.

Цель: построить модель руками, чтобы понять, откуда берутся формулы 5.1-5.7
из Hasbrouck (Empirical Market Microstructure).

Запуск:
    python research/scripts/gm_step0_toy.py
    python research/scripts/gm_step0_toy.py --mu 0.5 --delta 0.5
    python research/scripts/gm_step0_toy.py --mu 0.2 --delta 0.3 --n 200000

Что делает:
  1. Разыгрывает дерево событий N раз (Природа -> V, Природа -> тип, действие).
  2. Считает эмпирические Pr(Buy), Pr(V_high | Buy) и пр.
  3. Считает аналитические формулы 5.1, 5.2, 5.5, 5.6, 5.7.
  4. Печатает обе колонки рядом -> ты видишь, что симуляция сходится к формулам.
  5. Показывает, как Ask и Bid сдвигаются с ростом mu.

Параметры:
    V_high, V_low : два возможных терминальных значения актива
    delta         : Pr(V = V_low), prior дилера
    mu            : доля информированных в потоке
"""
import argparse
import numpy as np


def simulate(mu: float, delta: float, V_high: float, V_low: float,
             n: int, seed: int = 0):
    """Разыграть N независимых сделок по дереву GM. Вернуть массивы V, type, action."""
    rng = np.random.default_rng(seed)

    # Шаг 1: Природа выбирает V
    is_low = rng.random(n) < delta            # True => V = V_low
    V = np.where(is_low, V_low, V_high)

    # Шаг 2: Природа выбирает тип трейдера
    is_informed = rng.random(n) < mu          # True => informed

    # Шаг 3: Действие
    # Informed: buy если V=V_high, sell если V=V_low
    # Uninformed: 50/50
    coin = rng.random(n) < 0.5                # для uninformed: True=>buy
    informed_buy = is_informed & (~is_low)    # informed + V_high -> buy
    informed_sell = is_informed & is_low      # informed + V_low  -> sell
    uninformed_buy = (~is_informed) & coin
    uninformed_sell = (~is_informed) & (~coin)

    is_buy = informed_buy | uninformed_buy    # sell = ~buy
    return V, is_informed, is_buy


def analytical(mu: float, delta: float, V_high: float, V_low: float):
    """Закрытые формулы из текста (5.1, 5.2, 5.5, 5.6, 5.7)."""
    out = {}
    # Pr(Buy) и Pr(Sell) (см. текст, "sum of total probabilities over Buy nodes")
    out["Pr(Buy)"]  = (1 + mu * (1 - 2*delta)) / 2
    out["Pr(Sell)"] = (1 - mu * (1 - 2*delta)) / 2

    # Posterior на V_low после Buy и Sell (формулы 5.1 и 5.5)
    out["delta_1(Buy)"]  = delta * (1 - mu) / (1 + mu * (1 - 2*delta))
    out["delta_1(Sell)"] = delta * (1 + mu) / (1 - mu * (1 - 2*delta))

    # E[V|Buy] = Ask, E[V|Sell] = Bid (формулы 5.2 и 5.6)
    d1b = out["delta_1(Buy)"]
    d1s = out["delta_1(Sell)"]
    out["Ask = E[V|Buy]"]  = d1b * V_low + (1 - d1b) * V_high
    out["Bid = E[V|Sell]"] = d1s * V_low + (1 - d1s) * V_high

    # Spread (формула 5.7)
    out["Spread A-B"] = out["Ask = E[V|Buy]"] - out["Bid = E[V|Sell]"]
    return out


def empirical(V, is_informed, is_buy, V_high, V_low):
    """То же самое, но посчитано на симуляции."""
    out = {}
    n = len(V)
    out["Pr(Buy)"]  = is_buy.mean()
    out["Pr(Sell)"] = (~is_buy).mean()

    # Pr(V_low | Buy) = #(V=V_low AND Buy) / #(Buy)
    is_low = (V == V_low)
    nb = is_buy.sum()
    ns = (~is_buy).sum()
    out["delta_1(Buy)"]  = (is_low & is_buy).sum() / nb if nb else float("nan")
    out["delta_1(Sell)"] = (is_low & ~is_buy).sum() / ns if ns else float("nan")

    # Ask = E[V|Buy] = средняя истинная V среди трейдов, где была покупка
    out["Ask = E[V|Buy]"]  = V[is_buy].mean()
    out["Bid = E[V|Sell]"] = V[~is_buy].mean()
    out["Spread A-B"] = out["Ask = E[V|Buy]"] - out["Bid = E[V|Sell]"]
    return out


def print_compare(emp, ana, title):
    print(f"\n{title}")
    print(f"  {'quantity':<22s} {'analytical':>14s} {'empirical':>14s} {'diff':>10s}")
    print(f"  {'-'*22} {'-'*14} {'-'*14} {'-'*10}")
    for k in ana:
        a = ana[k]
        e = emp[k]
        print(f"  {k:<22s} {a:>14.6f} {e:>14.6f} {e-a:>+10.5f}")


def sweep_mu(delta: float, V_high: float, V_low: float):
    """Показать, как Ask, Bid и спред меняются с ростом mu."""
    print("\nКак спред зависит от mu (доли информированных):")
    print(f"  delta={delta}, V_high={V_high}, V_low={V_low}")
    print(f"  {'mu':>6s} {'Ask':>10s} {'Bid':>10s} {'Spread':>10s} "
          f"{'Spread/(V_h-V_l)':>20s}")
    print(f"  {'-'*6} {'-'*10} {'-'*10} {'-'*10} {'-'*20}")
    for mu in [0.0, 0.05, 0.1, 0.2, 0.5, 0.8, 1.0]:
        a = analytical(mu, delta, V_high, V_low)
        spr = a["Spread A-B"]
        print(f"  {mu:>6.2f} {a['Ask = E[V|Buy]']:>10.4f} "
              f"{a['Bid = E[V|Sell]']:>10.4f} {spr:>10.4f} "
              f"{spr/(V_high-V_low):>20.4f}")
    print("  Замечание: при delta=0.5 спред = mu * (V_high - V_low) ровно.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mu", type=float, default=0.2,
                    help="доля информированных трейдеров")
    ap.add_argument("--delta", type=float, default=0.5,
                    help="prior Pr(V = V_low)")
    ap.add_argument("--V_high", type=float, default=100.0)
    ap.add_argument("--V_low", type=float, default=90.0)
    ap.add_argument("--n", type=int, default=100_000,
                    help="число симулированных сделок")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    print(f"=== GM toy model ===")
    print(f"  V_high={args.V_high}  V_low={args.V_low}")
    print(f"  delta ={args.delta}  mu={args.mu}  N={args.n}")

    V, is_informed, is_buy = simulate(args.mu, args.delta,
                                       args.V_high, args.V_low,
                                       args.n, args.seed)
    ana = analytical(args.mu, args.delta, args.V_high, args.V_low)
    emp = empirical(V, is_informed, is_buy, args.V_high, args.V_low)
    print_compare(emp, ana,
                  "Сравнение формул vs симуляции (должно совпадать при больших N):")

    sweep_mu(args.delta, args.V_high, args.V_low)

    print("\nЧто потрогать:")
    print("  --mu 0      -> чистый шум, спред должен быть 0 (нечего бояться)")
    print("  --mu 1      -> все информированные, спред = V_high - V_low")
    print("  --delta 0.3 -> асимметричный prior, увидишь skew mid != EV")
    print("  --n 1000    -> шумная симуляция, эмпирика отойдёт от формул")
    print("  --n 1000000 -> сходимость почти идеальная")


if __name__ == "__main__":
    main()
