import type { Station } from "./ledger/types";

// 车站状态直接读取本地持久化处置账（离线也能续作）；在线时可作为最近缓存使用
export async function fetchStations(): Promise<Station[]> {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const raw = localStorage.getItem("pair-wise-yf-47/ledger");
  if (!raw) return [];
  return (JSON.parse(raw).state?.stations ?? []) as Station[];
}
