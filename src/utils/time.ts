import type { Nord } from "@n1xyz/nord-ts";

let offsetMs = 0;

export async function syncTime(nord: Nord): Promise<void> {
  const before = Date.now();
  const serverTs = await nord.getTimestamp();
  const after = Date.now();
  const rtt = after - before;
  const serverMs = Number(serverTs) * 1000;
  offsetMs = serverMs - (before + rtt / 2);
}

export function serverNow(): number {
  return Date.now() + offsetMs;
}

export function getOffset(): number {
  return offsetMs;
}
