import {
  BLOCKED_STATION_STATUSES,
  type LedgerEvent,
  type LedgerOperation,
  type LedgerState,
  type MergeResult,
  type PlanStatus,
  type QueuedOperation,
  type RetryReason,
  type Role,
  type Section,
  type ShuttlePlan,
  type Station,
  type VehicleHold,
} from "./types";

// ---------- 基础工具 ----------

export const iso = () => new Date().toISOString();

export function uid(prefix = "id"): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const id = g.crypto?.randomUUID ? g.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${id}`;
}

// 先到先得：按操作提交时刻排序；同刻保持进入队列时的先后（稳定排序）
const arrivalCompare = (a: LedgerOperation, b: LedgerOperation) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

export function isStationRecovered(station: Station): boolean {
  return !BLOCKED_STATION_STATUSES.has(station.status);
}

export function stationsOfSection(state: LedgerState, sectionId: string): Station[] {
  return state.stations.filter((s) => s.sectionIds.includes(sectionId));
}

export function isSectionOpenable(state: LedgerState, sectionId: string): boolean {
  const list = stationsOfSection(state, sectionId);
  return list.length > 0 && list.every(isStationRecovered);
}

export function sectionBlockReason(state: LedgerState, sectionId: string): string {
  const blocked = stationsOfSection(state, sectionId).filter((s) => !isStationRecovered(s));
  return blocked.map((s) => `${s.name}（${s.status}）`).join("、");
}

export function activeHoldOf(state: LedgerState, planId: string): VehicleHold | undefined {
  // 一个计划同时只有一笔未终结的占用申请
  return [...state.holds].reverse().find((h) => h.planId === planId && (h.status === "排队" || h.status === "占用"));
}

export function allocatedVehicles(state: LedgerState): number {
  return state.holds.filter((h) => h.status === "占用").reduce((sum, h) => sum + h.requested, 0);
}

export function availableVehicles(state: LedgerState): number {
  return state.pool.total - allocatedVehicles(state);
}

// 会签所需岗位：调度员 + 公交接驳负责人
export const COUNTERSIGN_ROLES: Role[] = ["调度员", "公交接驳负责人"];

const PERMISSIONS: Record<LedgerOperation["type"], Role[]> = {
  "station.status": ["车站值班员"],
  "section.release": ["调度员"],
  "plan.upsert": ["公交接驳负责人"],
  "plan.submit": ["公交接驳负责人"],
  "plan.sign": ["调度员", "公交接驳负责人"],
  "plan.execute": ["调度员"],
};

// 越权是岗位固有属性，与依赖/基线无关，合并时最先判定
export function permissionDenied(op: LedgerOperation): string | undefined {
  if (PERMISSIONS[op.type].includes(op.role)) return undefined;
  return `${op.role}无权执行「${op.type}」，仅 ${PERMISSIONS[op.type].join("、")} 可操作`;
}

// ---------- 事件 / 作废 / 车辆池 ----------

function log(state: LedgerState, phase: LedgerEvent["phase"], role: LedgerEvent["role"], text: string, opId?: string, at = iso()) {
  state.events.unshift({ id: uid("evt"), time: at, phase, role, text, opId });
}

function markOpVoided(state: LedgerState, opId: string, reason: string, at: string) {
  if (!state.voidedOpIds.some((v) => v.opId === opId)) state.voidedOpIds.push({ opId, reason, at });
}

// 车辆池 FIFO 结算：严格按 queueSeq 先到先得，队首不够则后面一律等待
export function pumpHolds(state: LedgerState, at: string) {
  const waiting = state.holds.filter((h) => h.status === "排队").sort((a, b) => a.queueSeq - b.queueSeq);
  for (const hold of waiting) {
    if (hold.requested > availableVehicles(state)) break; // 队首不足，后续继续排队
    hold.status = "占用";
    hold.allocatedAt = at;
    log(state, "接驳", "系统", `车辆占用生效：计划 ${planLabel(state, hold.planId)} 占用 ${hold.requested} 辆（剩余可用 ${availableVehicles(state)}/${state.pool.total}）`, hold.id, at);
  }
}

function planLabel(state: LedgerState, planId: string): string {
  return state.plans.find((p) => p.id === planId)?.name ?? planId;
}

// 车站或车辆数一变：会签和占用都作废重算
function voidPlanCountersignAndHold(state: LedgerState, plan: ShuttlePlan, reason: string, at: string) {
  if (plan.status === "已执行") return false; // 已执行计划的车辆已上路，不回收
  const before = plan.status;
  plan.status = "草稿";
  plan.voidReason = reason;
  plan.updatedAt = at;
  for (const cs of plan.countersigns) markOpVoided(state, cs.opId, `会签随${reason}作废`, at);
  if (plan.submitOpId) markOpVoided(state, plan.submitOpId, `提交随${reason}作废`, at);
  plan.countersigns = [];
  plan.submitOpId = undefined;
  const hold = activeHoldOf(state, plan.id);
  if (hold) {
    if (hold.status === "占用") {
      hold.status = "释放";
      hold.releasedAt = at;
      hold.voidReason = reason;
    } else {
      hold.status = "作废";
      hold.voidReason = reason;
    }
    markOpVoided(state, hold.id, `车辆占用随${reason}作废`, at);
  }
  log(state, "接驳", "系统", `计划「${plan.name}」${reason}：${before === "草稿" ? "占用申请" : "会签与占用"}作废，需重新申请车辆、重新会签`, undefined, at);
  return true;
}

// ---------- 单条操作的校验与落账 ----------

interface Verdict {
  ok: boolean;
  reason?: RetryReason;
  detail?: string;
}

function reject(reason: RetryReason, detail: string): Verdict {
  return { ok: false, reason, detail };
}

function checkAndApply(state: LedgerState, op: LedgerOperation, at: string): Verdict {
  // 1) 越权
  if (!PERMISSIONS[op.type].includes(op.role)) {
    return reject("越权", `${op.role}无权执行「${op.type}」，仅 ${PERMISSIONS[op.type].join("、")} 可操作`);
  }

  switch (op.type) {
    case "station.status": {
      const station = state.stations.find((s) => s.id === op.stationId);
      if (!station) return reject("业务条件不满足", `车站 ${op.stationId} 不存在`);
      if (op.baseVersion !== station.version) return reject("基线过期", `车站基线 v${op.baseVersion} 已过期，当前 v${station.version}，请刷新后重试`);
      const prev = station.status;
      station.status = op.status;
      if (op.note !== undefined) station.note = op.note;
      station.version += 1;
      station.updatedAt = at;
      log(state, "车站", op.role, `${station.name}状态 ${prev} → ${op.status}${op.note ? `（${op.note}）` : ""}`, op.opId, at);

      // 车站没恢复，所在区段不能放行：状态一变，若已放行则自动收回；
      // 车站全部恢复后仅解除拦截，区段仍保持封闭，等待调度员显式放行确认
      for (const section of state.sections.filter((sec) => sec.stationIds.some((id) => id === station.id))) {
        const recovered = stationsOfSection(state, section.id).every(isStationRecovered);
        if (!recovered && section.status === "放行") {
          section.status = "封闭";
          section.version += 1;
          section.note = `${station.name}未恢复，放行自动收回`;
          log(state, "区段", "系统", `区段「${section.name}」停止放行：${sectionBlockReason(state, section.id)}`, undefined, at);
        } else if (recovered && section.status === "封闭" && !section.releasedAt) {
          section.note = "区内车站全部恢复，待调度员放行确认";
        }
      }

      // 车站一变：相关未执行计划的会签和占用全部作废重算
      for (const plan of state.plans.filter((p) => p.status !== "已执行" && p.stationIds.includes(station.id))) {
        if (voidPlanCountersignAndHold(state, plan, `车站${station.name}状态变化`, at)) pumpHolds(state, at);
      }
      return { ok: true };
    }

    case "section.release": {
      const section = state.sections.find((s) => s.id === op.sectionId);
      if (!section) return reject("业务条件不满足", `区段 ${op.sectionId} 不存在`);
      if (op.baseVersion !== section.version) return reject("基线过期", `区段基线 v${op.baseVersion} 已过期，当前 v${section.version}，请刷新后重试`);
      if (!isSectionOpenable(state, section.id)) {
        return reject("业务条件不满足", `区段「${section.name}」内仍有车站未恢复：${sectionBlockReason(state, section.id)}，不能放行`);
      }
      if (section.status === "放行") {
        return reject("业务条件不满足", `区段「${section.name}」已处于放行状态`);
      }
      section.status = "放行";
      section.releasedAt = at;
      section.version += 1;
      section.note = op.note ?? "区内车站全部恢复，调度放行";
      log(state, "区段", op.role, `区段「${section.name}」恢复放行`, op.opId, at);
      return { ok: true };
    }

    case "plan.upsert": {
      const stationIds = Array.from(new Set(op.stationIds));
      if (stationIds.length === 0) return reject("业务条件不满足", "接驳计划至少选择一个车站");
      if (stationIds.some((id) => !state.stations.some((s) => s.id === id))) return reject("业务条件不满足", "包含不存在的车站");
      if (!Number.isInteger(op.vehicles) || op.vehicles < 1) return reject("业务条件不满足", "车辆数必须为正整数");
      if (op.vehicles > state.pool.total) return reject("业务条件不满足", `申请 ${op.vehicles} 辆超过车辆池总量 ${state.pool.total} 辆`);
      if (!Number.isInteger(op.intervalMin) || op.intervalMin < 1) return reject("业务条件不满足", "发车间隔不合法");
      if (!op.operator.trim()) return reject("业务条件不满足", "运营方不能为空");

      const existing = state.plans.find((p) => p.id === op.planId);
      if (op.create && existing) return reject("业务条件不满足", "计划号冲突，已存在同号计划");
      if (!op.create && !existing) return reject("业务条件不满足", `计划 ${op.planId} 不存在，无法修改`);
      if (existing && existing.status === "已执行") return reject("业务条件不满足", "计划已执行，不能再修改");
      if (existing && op.baseVersion !== existing.version) return reject("基线过期", `计划基线 v${op.baseVersion} 已过期，当前 v${existing.version}，请刷新后重试`);

      if (!existing) {
        const plan: ShuttlePlan = {
          id: op.planId,
          name: op.name,
          stationIds,
          vehicles: op.vehicles,
          intervalMin: op.intervalMin,
          operator: op.operator,
          note: op.note,
          status: "草稿",
          countersigns: [],
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
        state.plans.unshift(plan);
        enqueueHold(state, plan.id, op.vehicles, op.opId, at);
        pumpHolds(state, at);
        log(state, "接驳", op.role, `新建接驳计划「${plan.name}」：${stationNames(state, stationIds)}，申请 ${op.vehicles} 辆`, op.opId, at);
        return { ok: true };
      }

      const stationsChanged = JSON.stringify([...stationIds].sort()) !== JSON.stringify([...existing.stationIds].sort());
      const vehiclesChanged = existing.vehicles !== op.vehicles;
      existing.name = op.name;
      existing.stationIds = stationIds;
      existing.vehicles = op.vehicles;
      existing.intervalMin = op.intervalMin;
      existing.operator = op.operator;
      existing.note = op.note;
      existing.version += 1;
      existing.updatedAt = at;

      if (stationsChanged || vehiclesChanged) {
        voidPlanCountersignAndHold(state, existing, stationsChanged ? "接驳车站调整" : "车辆数调整", at);
        enqueueHold(state, existing.id, op.vehicles, op.opId, at);
        pumpHolds(state, at);
        log(state, "接驳", op.role, `修改计划「${existing.name}」：${stationsChanged ? "接驳站变化" : ""}${stationsChanged && vehiclesChanged ? "、" : ""}${vehiclesChanged ? "车辆数变化" : ""}，会签与占用重新计算`, op.opId, at);
      } else {
        log(state, "接驳", op.role, `更新计划「${existing.name}」基础信息`, op.opId, at);
      }
      return { ok: true };
    }

    case "plan.submit": {
      const plan = state.plans.find((p) => p.id === op.planId);
      if (!plan) return reject("业务条件不满足", `计划 ${op.planId} 不存在`);
      if (op.baseVersion !== plan.version) return reject("基线过期", `计划基线 v${op.baseVersion} 已过期，当前 v${plan.version}，请刷新后重试`);
      if (plan.status !== "草稿") return reject("业务条件不满足", `计划当前为「${plan.status}」，仅草稿可提交会签`);
      const hold = activeHoldOf(state, plan.id);
      if (!hold || hold.status !== "占用") {
        return reject("业务条件不满足", hold ? `车辆仍在排队（申请 ${hold.requested} 辆），占用生效后才能提交会签` : "尚无车辆占用申请，无法提交会签");
      }
      plan.status = "待确认";
      plan.submitOpId = op.opId;
      plan.version += 1;
      plan.updatedAt = at;
      log(state, "接驳", op.role, `计划「${plan.name}」提交会签（车辆已占用 ${hold.requested} 辆），待调度员与接驳负责人双方签署`, op.opId, at);
      return { ok: true };
    }

    case "plan.sign": {
      const plan = state.plans.find((p) => p.id === op.planId);
      if (!plan) return reject("业务条件不满足", `计划 ${op.planId} 不存在`);
      if (op.baseVersion !== plan.version) return reject("基线过期", `计划基线 v${op.baseVersion} 已过期，当前 v${plan.version}，请刷新后重试`);
      if (plan.status !== "待确认") return reject("业务条件不满足", `计划当前为「${plan.status}」，仅待确认状态可会签`);
      if (plan.countersigns.some((c) => c.role === op.role)) {
        return reject("业务条件不满足", `${op.role}已签署过该计划，请勿重复会签`);
      }
      const hold = activeHoldOf(state, plan.id);
      if (!hold || hold.status !== "占用") return reject("业务条件不满足", "车辆占用已失效，请退回重新申请车辆");
      plan.countersigns.push({ role: op.role, at, opId: op.opId });
      const signedRoles = new Set(plan.countersigns.map((c) => c.role));
      const done = COUNTERSIGN_ROLES.every((r) => signedRoles.has(r));
      if (done) {
        plan.status = "已确认";
        // 会签为追加性记录，仅在双岗签齐导致状态流转时推进版本，避免同批并行会签互相判为基线过期
        plan.version += 1;
        log(state, "接驳", op.role, `计划「${plan.name}」双岗会签完成（${COUNTERSIGN_ROLES.join("、")}），状态 → 已确认`, op.opId, at);
      } else {
        log(state, "接驳", op.role, `${op.role}会签计划「${plan.name}」，尚缺 ${COUNTERSIGN_ROLES.filter((r) => !signedRoles.has(r)).join("、")}`, op.opId, at);
      }
      plan.updatedAt = at;
      return { ok: true };
    }

    case "plan.execute": {
      const plan = state.plans.find((p) => p.id === op.planId);
      if (!plan) return reject("业务条件不满足", `计划 ${op.planId} 不存在`);
      if (op.baseVersion !== plan.version) return reject("基线过期", `计划基线 v${op.baseVersion} 已过期，当前 v${plan.version}，请刷新后重试`);
      if (plan.status !== "已确认") return reject("业务条件不满足", `计划当前为「${plan.status}」，双岗会签完成后才能执行`);
      plan.status = "已执行";
      plan.version += 1;
      plan.updatedAt = at;
      const hold = activeHoldOf(state, plan.id);
      if (hold && hold.status === "占用") {
        hold.status = "释放";
        hold.releasedAt = at;
        hold.voidReason = "计划已执行，车辆上路投入疏运";
      }
      pumpHolds(state, at);
      log(state, "接驳", op.role, `计划「${plan.name}」已执行，${plan.vehicles} 辆接驳车投入疏运`, op.opId, at);
      return { ok: true };
    }
  }
}

function stationNames(state: LedgerState, ids: string[]): string {
  return ids.map((id) => state.stations.find((s) => s.id === id)?.name ?? id).join(" → ");
}

function enqueueHold(state: LedgerState, planId: string, requested: number, opId: string, at: string) {
  state.queueCounter += 1;
  const hold: VehicleHold = { id: opId, planId, requested, status: "排队", queueSeq: state.queueCounter, requestedAt: at };
  state.holds.push(hold);
  log(state, "接驳", "系统", `计划「${planLabel(state, planId)}」申请 ${requested} 辆，进入车辆队列（序号 ${hold.queueSeq}，池余量 ${availableVehicles(state)}/${state.pool.total}）`, opId, at);
}

// ---------- 离线恢复后的依赖合并 ----------

export function mergeLedger(prev: LedgerState, incoming: LedgerOperation[], at = iso()): MergeResult {
  // 处置账是纯数据（无函数/无循环引用），用 JSON 深拷贝切断与调用方状态的共享
  const state: LedgerState = JSON.parse(JSON.stringify(prev));
  const applied: string[] = [];
  const duplicates: string[] = [];
  const retried: MergeResult["retried"] = [];

  // 既有重试队列优先参与本轮重放（保留原排队时刻与尝试次数）
  const carried = state.retryQueue;
  const attemptsById = new Map(carried.map((q) => [q.op.opId, q.attempts]));
  state.retryQueue = [];
  const queue = [...carried.map((q) => q.op), ...incoming].sort(arrivalCompare);

  const upsertRetry = (op: LedgerOperation, reason: RetryReason, detail: string) => {
    const existing = state.retryQueue.find((q) => q.op.opId === op.opId);
    if (existing) {
      existing.reason = reason;
      existing.detail = detail;
      existing.attempts += 1;
      existing.enqueuedAt = at;
    } else {
      const q: QueuedOperation = { op, reason, detail, enqueuedAt: at, attempts: (attemptsById.get(op.opId) ?? 0) + 1 };
      state.retryQueue.push(q);
    }
    if (!retried.some((r) => r.opId === op.opId)) retried.push({ opId: op.opId, reason, detail });
  };

  // 不动点合并：每轮把“本批新操作 + 上轮仍失败的重试条目”按到达顺序统一处理，
  // 只要本轮有操作生效就再来一轮（可能解开依赖/基线），直到无进展为止。
  let pending = queue;
  let guard = 0;
  while (pending.length > 0) {
    if (++guard > 10000) break;
    let progress = false;
    const failed: LedgerOperation[] = [];
    for (const op of pending) {
      // 同一操作号只生效一次（含已作废后重放）
      if (state.appliedOpIds.includes(op.opId) || state.voidedOpIds.some((v) => v.opId === op.opId)) {
        if (!duplicates.includes(op.opId)) duplicates.push(op.opId);
        continue;
      }
      // 越权优先判定：岗位无权时无论依赖是否满足都留在重试队列
      const denied = permissionDenied(op);
      if (denied) {
        upsertRetry(op, "越权", denied);
        failed.push(op);
        continue;
      }
      const missing = (op.dependsOn ?? []).filter((d) => !state.appliedOpIds.includes(d));
      if (missing.length > 0) {
        upsertRetry(op, "缺依赖", `等待依赖操作生效：${missing.join("、")}`);
        failed.push(op);
        continue;
      }
      const verdict = checkAndApply(state, op, at);
      if (verdict.ok) {
        state.appliedOpIds.push(op.opId);
        applied.push(op.opId);
        progress = true;
      } else {
        upsertRetry(op, verdict.reason!, verdict.detail ?? "操作未生效");
        failed.push(op);
      }
    }
    if (!progress) break;
    // 已成功的条目从重试集合移除，其余进入下一轮
    for (const opId of applied) {
      const idx = state.retryQueue.findIndex((q) => q.op.opId === opId);
      if (idx >= 0) state.retryQueue.splice(idx, 1);
    }
    pending = failed.sort(arrivalCompare);
  }

  // 本轮最终的重试结果覆盖重试队列（attempts 累加由 upsertRetry 维护）
  state.version += 1;
  return { state, applied, retried, duplicates };
}

// ---------- 初始基线账 ----------

export function freshState(at = iso()): LedgerState {
  const stations: Station[] = [
    { id: "s1", name: "滨江站", sectionIds: ["sec-center", "sec-expo", "sec-donggang"], status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", version: 1, updatedAt: at },
    { id: "s2", name: "会展中心站", sectionIds: ["sec-expo"], status: "限流", passengerRisk: "中", note: "出入口单向组织", version: 1, updatedAt: at },
    { id: "s3", name: "东港站", sectionIds: ["sec-donggang"], status: "正常", passengerRisk: "低", note: "做好接班车准备", version: 1, updatedAt: at },
  ];
  const sections: Section[] = [
    { id: "sec-center", name: "中心站—滨江站", stationIds: ["s1"], status: "封闭", note: "滨江站积水，双向暂停", version: 1 },
    { id: "sec-expo", name: "会展中心站—滨江站", stationIds: ["s2", "s1"], status: "封闭", note: "受滨江站积水影响封闭", version: 1 },
    { id: "sec-donggang", name: "滨江站—东港站", stationIds: ["s1", "s3"], status: "封闭", note: "受滨江站积水影响封闭", version: 1 },
  ];
  return {
    incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", startedAt: new Date(Date.now() - 35 * 60000).toISOString() },
    sections,
    stations,
    plans: [],
    holds: [],
    pool: { total: 12 },
    events: [
      { id: uid("evt"), time: new Date(Date.now() - 27 * 60000).toISOString(), phase: "车站", role: "车站值班员", text: "滨江站双向入口封闭并组织乘客出站" },
      { id: uid("evt"), time: new Date(Date.now() - 35 * 60000).toISOString(), phase: "区段", role: "调度员", text: "监测到滨江站区间水位超限，三个相邻区段暂停双向行车" },
    ],
    appliedOpIds: [],
    retryQueue: [],
    voidedOpIds: [],
    queueCounter: 0,
    version: 1,
  };
}

export function planStatusOf(plan: ShuttlePlan): PlanStatus {
  return plan.status;
}
