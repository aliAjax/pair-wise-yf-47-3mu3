import test from "node:test";
import assert from "node:assert/strict";
import {
  activeHoldOf,
  allocatedVehicles,
  availableVehicles,
  freshState,
  isSectionOpenable,
  mergeLedger,
} from "./engine";
import type {
  LedgerOperation,
  PlanSignOp,
  PlanSubmitOp,
  PlanUpsertOp,
  SectionReleaseOp,
  StationStatusOp,
} from "./types";

const T = (ms: number) => new Date(Date.UTC(2026, 9, 6, 2, 0) + ms).toISOString();

function stationOp(role: StationStatusOp["role"], baseVersion: number, stationId: string, status: StationStatusOp["status"], ms: number, opId?: string, note?: string, dependsOn?: string[]): StationStatusOp {
  return { opId: opId ?? `op-st-${stationId}-${status}`, type: "station.status", role, baseVersion, stationId, status, note, at: T(ms), dependsOn };
}
function releaseOp(baseVersion: number, sectionId: string, ms: number, opId = "op-rel", dependsOn?: string[]): SectionReleaseOp {
  return { opId, type: "section.release", role: "调度员", baseVersion, sectionId, at: T(ms), dependsOn };
}
function planOp(planId: string, vehicles: number, stationIds: string[], ms: number, opId: string, create = false, baseVersion = 1): PlanUpsertOp {
  return { opId, type: "plan.upsert", role: "公交接驳负责人", baseVersion: create ? 0 : baseVersion, planId, create, name: `计划-${planId}`, stationIds, vehicles, intervalMin: 6, operator: "东城公交", note: "疏运滞留乘客", at: T(ms) };
}
function fullConfirm(s: ReturnType<typeof freshState>, planId: string, t0: number, tag: string) {
  const plan = findPlan(s, planId);
  const ops: LedgerOperation[] = [
    submitOp(planId, plan.version, t0, `${tag}-sub`, [activeHoldOf(s, planId)!.id]),
    signOp(planId, plan.version + 1, "调度员", t0 + 10, `${tag}-sd`, [`${tag}-sub`]),
    signOp(planId, plan.version + 1, "公交接驳负责人", t0 + 20, `${tag}-sb`, [`${tag}-sub`]),
    { opId: `${tag}-exec`, type: "plan.execute", role: "调度员", baseVersion: plan.version + 2, planId, at: T(t0 + 30) },
  ];
  return mergeLedger(s, ops, T(t0 + 40)).state;
}
function submitOp(planId: string, baseVersion: number, ms: number, opId: string, dependsOn?: string[]): PlanSubmitOp {
  return { opId, type: "plan.submit", role: "公交接驳负责人", baseVersion, planId, at: T(ms), dependsOn };
}
function signOp(planId: string, baseVersion: number, role: PlanSignOp["role"], ms: number, opId: string, dependsOn?: string[]): PlanSignOp {
  return { opId, type: "plan.sign", role, baseVersion, planId, at: T(ms), dependsOn };
}

function findPlan(s: ReturnType<typeof freshState>, id: string) {
  const p = s.plans.find((x) => x.id === id);
  assert.ok(p, `计划 ${id} 应存在`);
  return p!;
}

// ---------- 规则 1：车站没恢复，所在区段不能放行 ----------
test("区段放行闸门：封闭车站未恢复时拒绝放行；全部恢复后才可放行", () => {
  let s = freshState(T(0));
  assert.equal(isSectionOpenable(s, "sec-center"), false, "滨江站封闭，中心区段不可放行");

  // 越权：车站值班员不能放行
  const relByStation: SectionReleaseOp = { ...releaseOp(1, "sec-center", 1000, "rel-1"), role: "车站值班员" };
  let r = mergeLedger(s, [relByStation], T(2000));
  s = r.state;
  assert.equal(s.sections.find((x) => x.id === "sec-center")!.status, "封闭");
  assert.equal(r.retried[0]?.reason, "越权", "越权操作进重试队列");

  // 业务条件不满足：车站未恢复
  r = mergeLedger(s, [releaseOp(1, "sec-center", 3000, "rel-2")], T(4000));
  const stateAfterBlock = r.state;
  assert.equal(stateAfterBlock.sections.find((x) => x.id === "sec-center")!.status, "封闭");
  assert.equal(r.retried.find((x) => x.opId === "rel-2")?.reason, "业务条件不满足");
  assert.match(r.retried.find((x) => x.opId === "rel-2")!.detail, /滨江站/);

  // 车站值班员恢复滨江站（v1 -> v2）；恢复后此前被拒留在重试队列的
  // 调度放行 rel-2 条件已满足，随本轮重放自动生效（这就是“恢复后续作”）
  r = mergeLedger(stateAfterBlock, [stationOp("车站值班员", 1, "s1", "正常", 5000, "s1-ok")], T(6000));
  s = r.state;
  assert.equal(isSectionOpenable(s, "sec-center"), true);
  assert.ok(r.applied.includes("rel-2"), "恢复后留队的调度放行自动补生效");
  assert.equal(s.sections.find((x) => x.id === "sec-center")!.status, "放行");

  // 基线过期：还拿 v99 去放行
  r = mergeLedger(s, [releaseOp(99, "sec-center", 7000, "rel-stale")], T(7500));
  s = r.state;
  assert.equal(r.retried.find((x) => x.opId === "rel-stale")?.reason, "基线过期");

  // 区段已放行：重复放行请求被拒，不产生重复入账
  r = mergeLedger(s, [releaseOp(2, "sec-center", 8000, "rel-ok")], T(9000));
  s = r.state;
  assert.equal(s.sections.find((x) => x.id === "sec-center")!.status, "放行");
  assert.ok(!r.applied.includes("rel-ok"));
  assert.equal(r.retried.find((x) => x.opId === "rel-ok")?.reason, "业务条件不满足");
});

test("放行后车站再变化：区段放行自动收回", () => {
  let s = freshState(T(0));
  let r = mergeLedger(s, [stationOp("车站值班员", 1, "s1", "正常", 1000, "s1-ok"), releaseOp(1, "sec-center", 2000, "rel-ok")], T(3000));
  s = r.state;
  assert.equal(s.sections.find((x) => x.id === "sec-center")!.status, "放行");

  // 滨江站再次积水封闭
  r = mergeLedger(s, [stationOp("车站值班员", 2, "s1", "封闭", 4000, "s1-flood-again", "区间再次进水")], T(5000));
  s = r.state;
  assert.equal(s.sections.find((x) => x.id === "sec-center")!.status, "封闭", "放行应自动收回");
  assert.match(s.events[0].text, /停止放行/);
});

test("三区段联动：滨江站影响中心、会展、东港三个区段", () => {
  const s = freshState(T(0));
  // 会展中心恢复、滨江仍封闭 → 会展-滨江区段仍不可放行
  const r = mergeLedger(s, [stationOp("车站值班员", 1, "s2", "正常", 1000, "s2-ok")], T(2000));
  assert.equal(isSectionOpenable(r.state, "sec-expo"), false, "滨江站未恢复，会展-滨江不能放行");
  assert.equal(isSectionOpenable(r.state, "sec-donggang"), false, "滨江站未恢复，滨江-东港不能放行");
});

// ---------- 规则 2：车站或车辆数一变，会签和占用都作废重算 ----------
test("车辆数变化：释放原占用、新申请排到队尾、会签清零", () => {
  let s = freshState(T(0)); // 池 12
  const id = "P1";
  // 建计划申请 8 辆（占用）
  let r = mergeLedger(s, [planOp(id, 8, ["s1"], 1000, "v-hold", true)], T(1100));
  s = r.state;
  assert.equal(allocatedVehicles(s), 8);
  assert.equal(activeHoldOf(s, id)!.status, "占用");

  // 提交 + 双岗会签完成
  const p1 = findPlan(s, id);
  r = mergeLedger(s, [
    submitOp(id, p1.version, 2000, "sub1", ["v-hold"]),
    signOp(id, p1.version + 1, "调度员", 2100, "sign-d1", ["sub1"]),
    signOp(id, p1.version + 1, "公交接驳负责人", 2200, "sign-b1", ["sub1"]),
  ], T(2300));
  s = r.state;
  assert.equal(findPlan(s, id).status, "已确认");
  assert.equal(findPlan(s, id).countersigns.length, 2);

  // 车辆数 8 -> 6：会签清零、占用释放、新申请 v-hold2
  const version = findPlan(s, id).version;
  r = mergeLedger(s, [planOp(id, 6, ["s1"], 3000, "v-hold2", false, version)], T(3100));
  s = r.state;
  const plan = findPlan(s, id);
  assert.equal(plan.status, "草稿", "车辆数一变，计划退回草稿");
  assert.equal(plan.countersigns.length, 0, "会签作废");
  assert.equal(plan.version, version + 1);
  assert.equal(activeHoldOf(s, id)!.id, "v-hold2");
  assert.equal(activeHoldOf(s, id)!.status, "占用", "释放 8 辆后池有 12，新申请 6 辆可立即占用");
  assert.equal(s.voidedOpIds.some((x) => x.opId === "sign-d1"), true, "旧会签操作被标记作废");

  // 旧会签操作重放 → 不再生效
  r = mergeLedger(s, [signOp(id, plan.version, "调度员", 4000, "sign-d1")], T(4100));
  assert.deepEqual(r.duplicates, ["sign-d1"], "同一操作号只生效一次");
});

test("车站变化作废经过该站的计划", () => {
  let s = freshState(T(0));
  const r = mergeLedger(s, [
    planOp("P1", 4, ["s1", "s3"], 1000, "h1", true),
    submitOp("P1", 1, 2000, "sub1", ["h1"]),
    signOp("P1", 2, "调度员", 2100, "sd", ["sub1"]),
  ], T(2200));
  s = r.state;
  assert.equal(findPlan(s, "P1").countersigns.length, 1);

  // 东港站状态一变（计划经停东港）
  const r2 = mergeLedger(s, [stationOp("车站值班员", 1, "s3", "限流", 3000, "s3-limit")], T(3100));
  const plan = findPlan(r2.state, "P1");
  assert.equal(plan.status, "草稿");
  assert.equal(plan.countersigns.length, 0);
  assert.equal(r2.state.holds.find((h) => h.id === "h1")!.status, "释放", "已占用随车站变化释放；若当时在排队则为作废");
});

// ---------- 规则 3：车辆池先到先得，晚到者排队 ----------
test("车辆池 FIFO：先到者占用，队首不足后续等待，释放后按序递补", () => {
  let s = freshState(T(0)); // 池 12
  let r = mergeLedger(s, [
    planOp("A", 8, ["s1"], 1000, "ha", true),
    planOp("B", 4, ["s3"], 2000, "hb", true),
  ], T(2100));
  s = r.state;
  assert.equal(activeHoldOf(s, "A")!.status, "占用");
  assert.equal(activeHoldOf(s, "B")!.status, "占用", "8+4=12 正好占满");
  assert.equal(availableVehicles(s), 0);

  // 晚到者 C 申请 2 辆，队首不足 → 排队
  r = mergeLedger(s, [planOp("C", 2, ["s3"], 3000, "hc", true)], T(3100));
  s = r.state;
  assert.equal(activeHoldOf(s, "C")!.status, "排队");
  assert.equal(s.retryQueue.length, 0, "排队是正常状态，不进重试队列");

  // 更晚的 D 申请 2 辆：即使 C 被拒绝后 D 的需求能满足，也不能插队
  r = mergeLedger(s, [planOp("D", 2, ["s3"], 3200, "hd", true)], T(3300));
  s = r.state;
  assert.deepEqual(s.holds.filter((h) => h.status === "排队").map((h) => h.planId), ["C", "D"]);

  // 同一毫秒两个岗位提交 E、F：按进入批次的先后稳定占用排队序号
  const sameAt = T(5000);
  const opE = { ...planOp("E", 1, ["s3"], 0, "he", true), at: sameAt };
  const opF = { ...planOp("F", 1, ["s3"], 0, "hf", true), at: sameAt };
  r = mergeLedger(s, [opE, opF], T(5100));
  s = r.state;
  assert.equal(s.holds.find((h) => h.id === "he")!.queueSeq + 1, s.holds.find((h) => h.id === "hf")!.queueSeq, "同刻先进入者序号在前");

  // A 走完会签并执行 → 释放 8 辆 → C、D 按序递补，E、F 随后，全部 2+2+1+1=6 ≤ 8
  s = fullConfirm(s, "A", 4000, "a");
  assert.equal(findPlan(s, "A").status, "已执行");
  assert.equal(activeHoldOf(s, "C")!.status, "占用", "C 先到先得");
  assert.equal(activeHoldOf(s, "D")!.status, "占用", "D 随后");
  assert.equal(activeHoldOf(s, "E")!.status, "占用");
  assert.equal(activeHoldOf(s, "F")!.status, "占用");
  assert.equal(availableVehicles(s), 2, "B 占 4 + C/D/E/F 占 6 = 10，余 2");
});

// ---------- 规则 4：离线恢复按依赖合并；操作号幂等；越权/缺依赖留重试 ----------
test("离线合并：按依赖排序生效，缺依赖留队列，依赖满足后重试成功", () => {
  const s0 = freshState(T(0));
  // 先把滨江恢复
  let s = mergeLedger(s0, [stationOp("车站值班员", 1, "s1", "正常", 0, "s1-ok")], T(100)).state;

  // 离线期间乱序到达：放行依赖 s1-ok（已满足）；会签依赖提交（提交在同批、时刻更早）
  const batch: LedgerOperation[] = [
    signOp("P1", 2, "调度员", 2300, "off-sign-d", ["off-submit"]),
    submitOp("P1", 1, 2200, "off-submit", ["off-hold"]),
    planOp("P1", 8, ["s1"], 2100, "off-hold", true),
    releaseOp(1, "sec-center", 500, "off-rel", ["s1-ok"]),
  ];
  const r = mergeLedger(s, batch, T(3000));
  assert.deepEqual(r.applied.sort(), ["off-hold", "off-rel", "off-sign-d", "off-submit"]);
  assert.equal(r.state.retryQueue.length, 0);
  assert.equal(r.state.sections.find((x) => x.id === "sec-center")!.status, "放行");
});

test("缺依赖的操作留在重试队列，依赖补做后重放成功；越权操作持续留队", () => {
  const s0 = freshState(T(0));
  // 会签先到、提交操作缺失 → 缺依赖
  const orphan = signOp("P1", 1, "调度员", 1000, "orphan-sign", ["missing-submit"]);
  const badRole = { ...signOp("P1", 1, "公交接驳负责人", 2000, "bad-role", ["missing-submit"]), role: "客服主管" as const };
  let r = mergeLedger(s0, [orphan, badRole], T(3000));
  assert.equal(r.state.retryQueue.length, 2);
  assert.deepEqual(r.state.retryQueue.map((q) => q.reason).sort(), ["缺依赖", "越权"]);

  // 重放但依赖仍缺 → 继续留队，attempts 增加
  r = mergeLedger(r.state, [], T(4000));
  assert.equal(r.state.retryQueue.find((q) => q.op.opId === "orphan-sign")!.attempts, 2);

  // 越权操作即使再多重放也不生效
  const again = mergeLedger(r.state, [], T(5000));
  assert.ok(!again.state.appliedOpIds.includes("bad-role"));
});

test("同一操作号只生效一次（跨批次重复提交）", () => {
  const s0 = freshState(T(0));
  const op = stationOp("车站值班员", 1, "s3", "限流", 1000, "dup-op");
  const r1 = mergeLedger(s0, [op], T(2000));
  assert.deepEqual(r1.applied, ["dup-op"]);
  const r2 = mergeLedger(r1.state, [op], T(3000));
  assert.deepEqual(r2.applied, []);
  assert.deepEqual(r2.duplicates, ["dup-op"]);
  assert.equal(r2.state.stations.find((x) => x.id === "s3")!.version, 2, "未重复入账，版本只加一次");
});

test("乐观并发：基线过期不覆盖别人修改，留在重试队列可基于新基线重做", () => {
  const s0 = freshState(T(0));
  // 值班员 A 把滨江恢复（v1→v2）
  let r = mergeLedger(s0, [stationOp("车站值班员", 1, "s1", "正常", 1000, "a-recover")], T(1100));
  // 值班员 B 基于旧基线 v1 提交“封闭”
  r = mergeLedger(r.state, [stationOp("车站值班员", 1, "s1", "封闭", 2000, "b-close-stale")], T(2100));
  assert.equal(r.retried[0]?.reason, "基线过期");
  assert.equal(r.state.stations.find((x) => x.id === "s1")!.status, "正常", "过期基线不得覆盖新状态");
  // B 基于 v2 重做 → 生效
  r = mergeLedger(r.state, [stationOp("车站值班员", 2, "s1", "封闭", 3000, "b-close-fresh")], T(3100));
  assert.deepEqual(r.applied, ["b-close-fresh"]);
  assert.equal(r.state.stations.find((x) => x.id === "s1")!.status, "封闭");
});
