/**
 * Strategy registry — maps a strategy name to a factory so the CLI can resolve
 * `--strategy <name>`. Strategies self-register at module load (see
 * src/strategies/index.ts), keeping the runner agnostic to concrete strategies.
 */
import type { Strategy } from "./types.js";

const registry = new Map<string, () => Strategy<any>>();

export function registerStrategy(name: string, factory: () => Strategy<any>): void {
  if (registry.has(name)) throw new Error(`Strategy "${name}" already registered`);
  registry.set(name, factory);
}

export function createStrategy(name: string): Strategy<any> {
  const factory = registry.get(name);
  if (!factory) {
    const known = registeredStrategies().join(", ") || "(none)";
    throw new Error(`Unknown strategy "${name}". Registered: ${known}`);
  }
  return factory();
}

export function registeredStrategies(): string[] {
  return [...registry.keys()];
}
