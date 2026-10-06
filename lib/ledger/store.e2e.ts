// 端到端演练：断网操作（带岗位/基线/依赖）→ 恢复联网按依赖合并 → 越权留重试队列
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import type { QueuedOperation, Section, ShuttlePlan, VehicleHold } from "./types";

declare const require: (id: string) => any;

Object.defineProperty(globalThis, "crypto", { value: webcrypto });
// zustand persist 默认用 localStorage，需在加载 store 前就位
const memory = new Map<string, string>();
const storageStub = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: storageStub });
Object.defineProperty(globalThis, "window", { value: { localStorage: storageStub } });

const { useLedgerStore } = require(process.env.LEDGER_STORE ?? "../../store/ledger");

interface StoreShape {
  resetAll: () => void;
  setOnline: (v: boolean) => void;
  setRole: (r: string) => void;
  setStationStatus: (id: string, st: string, note?: string) => void;
  releaseSection: (id: string) => void;
  createPlan: (d: unknown) => string;
  submitPlan: (id: string) => void;
  signPlan: (id: string) => void;
  executePlan: (id: string) => void;
  online: boolean;
  outbox: { opId: string }[];
  plans: ShuttlePlan[];
  holds: VehicleHold[];
  sections: Section[];
  retryQueue: QueuedOperation[];
}
const get = () => useLedgerStore.getState() as StoreShape;

test("E2E：断网期间三岗位各自操作，恢复后按依赖合并、越权留队、操作号幂等", () => {
  get().resetAll();

  // —— 断网开始 ——
  get().setOnline(false);

  // 值班员恢复会展中心站
  get().setRole("车站值班员");
  get().setStationStatus("s2", "正常");
  // 调度员断网尝试放行会展-滨江区段：滨江仍封闭 → 业务拒绝，留重试
  get().setRole("调度员");
  get().releaseSection("sec-expo");
  // 客服主管越权改车站状态
  get().setRole("客服主管");
  get().setStationStatus("s1", "封闭");
  // 接驳负责人断网连建三个计划抢车：池 12
  get().setRole("公交接驳负责人");
  const idA = get().createPlan({ name: "西线接驳", stationIds: ["s1"], vehicles: 8, intervalMin: 6, operator: "东城公交", note: "疏运" });
  const idB = get().createPlan({ name: "东线接驳", stationIds: ["s3"], vehicles: 4, intervalMin: 8, operator: "西城公交", note: "疏运" });
  const idC = get().createPlan({ name: "晚到接驳", stationIds: ["s3"], vehicles: 2, intervalMin: 10, operator: "南城公交", note: "疏运" });
  // A 的车辆占用、双岗会签、调度执行 → 释放 8 辆 → 排队中的 C 按 FIFO 递补
  get().submitPlan(idA);
  get().signPlan(idA); // 接驳负责人
  get().setRole("调度员");
  get().signPlan(idA);
  get().executePlan(idA);

  const offline = get();
  assert.equal(offline.online, false);
  assert.ok(offline.outbox.length >= 8, "断网操作全部进入发件箱");
  assert.equal(offline.plans.find((p: ShuttlePlan) => p.id === idA)!.status, "已执行");
  assert.equal(offline.holds.filter((h: VehicleHold) => h.planId === idC).pop()!.status, "占用", "释放后晚到者按序递补");

  // —— 恢复联网：重放发件箱（本地已入账的操作幂等去重；越权/被拦截继续留队）——
  get().setOnline(true);
  const recovered = get();
  assert.equal(recovered.online, true);
  // 已生效操作离开发件箱；仍被拒的 2 条（越权改车站 + 条件不满足的放行）保留待重试
  assert.equal(recovered.outbox.length, 2, "仅被拒条目留在发件箱");
  const queuedBad = recovered.retryQueue.filter((q: QueuedOperation) => q.reason === "越权");
  assert.ok(queuedBad.length >= 1, "越权操作留在重试队列");
  assert.ok(queuedBad.some((q: QueuedOperation) => q.op.role === "客服主管"));
  // 滨江未恢复，会展区段放行请求条件不满足 → 留在重试队列
  const blockedRelease = recovered.retryQueue.find((q: QueuedOperation) => q.op.type === "section.release");
  assert.ok(blockedRelease, "未恢复时的放行请求停留在重试队列");
  assert.equal(blockedRelease!.reason, "业务条件不满足");

  // —— 滨江恢复：留队放行自动重放生效（会展+滨江两站均恢复）——
  get().setRole("车站值班员");
  get().setStationStatus("s1", "正常");
  const afterRecover = get();
  assert.equal(afterRecover.sections.find((x: Section) => x.id === "sec-expo")!.status, "放行", "恢复后重试队列中的调度放行自动生效");
  assert.ok(!afterRecover.retryQueue.some((q: QueuedOperation) => q.op.opId === blockedRelease!.op.opId), "已生效的放行离队");
});
