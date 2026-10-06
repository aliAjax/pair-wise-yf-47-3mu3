"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type SectionPassage = "封锁" | "限速" | "待放行" | "放行";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已排队" | "已执行";
export type OpType =
  | "station.setStatus"
  | "section.release"
  | "plan.create"
  | "plan.updateVehicles"
  | "plan.submit"
  | "plan.countersign"
  | "plan.execute"
  | "timeline.add";
export type OpStatus = "applied" | "queued" | "retry";

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复";
}

export interface Station {
  id: string;
  name: string;
  section: string;
  status: StationStatus;
  passengerRisk: "低" | "中" | "高";
  note: string;
  updatedAt: string;
}

export interface Approval {
  role: Role;
  opId: string;
  baseline: number;
  time: string;
}

export interface Occupancy {
  planId: string;
  vehicles: number;
  opId: string;
  baseline: number;
  time: string;
}

export interface Section {
  id: string;
  name: string;
  stationIds: string[];
  passage: SectionPassage;
  released: boolean;
  releaseBaseline?: number;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: Approval[];
  note: string;
}

export interface Operation {
  opId: string;
  type: OpType;
  role: Role;
  baseline: number;
  deps: string[];
  payload: Record<string, any>;
  time: string;
  status: OpStatus;
  reason?: string;
}

export interface PendingAction {
  id: string;
  opId: string;
  action: string;
  detail: string;
  role: Role;
  baseline: number;
  deps: string[];
  time: string;
  status: OpStatus;
  reason?: string;
}

interface ApplyOk {
  ok: true;
  patch: Partial<IncidentState>;
}
interface ApplyFail {
  ok: false;
  reason: string;
}
type ApplyResult = ApplyOk | ApplyFail;

export type ActionResult = { ok: boolean; reason?: string };

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  sections: Section[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  occupancy: Occupancy[];
  vehiclePool: number;
  role: Role;
  online: boolean;
  baseline: number;
  operations: Operation[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => ActionResult;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => ActionResult;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => ActionResult;
  updatePlanVehicles: (id: string, vehicles: number) => ActionResult;
  submitPlan: (id: string) => ActionResult;
  countersignPlan: (id: string) => ActionResult;
  executePlan: (id: string) => ActionResult;
  releaseSection: (id: string) => ActionResult;
  syncActions: () => void;
}

const now = () => new Date().toISOString();

const AUTHORITY: Record<OpType, Role[]> = {
  "station.setStatus": ["调度员", "车站值班员"],
  "section.release": ["调度员"],
  "plan.create": ["调度员", "公交接驳负责人"],
  "plan.updateVehicles": ["调度员", "公交接驳负责人"],
  "plan.submit": ["调度员", "公交接驳负责人"],
  "plan.countersign": ["调度员", "公交接驳负责人"],
  "plan.execute": ["调度员"],
  "timeline.add": ["调度员", "车站值班员", "公交接驳负责人", "客服主管"]
};

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

const seedSections: Section[] = [
  { id: "sec-1", name: "中心-滨江", stationIds: ["s1"], passage: "封锁", released: false },
  { id: "sec-2", name: "会展-滨江", stationIds: ["s2"], passage: "限速", released: false },
  { id: "sec-3", name: "滨江-东港", stationIds: ["s3"], passage: "待放行", released: false }
];

const tMinus = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

const seedOperations: Operation[] = [
  { opId: "op-seed-1", type: "station.setStatus", role: "调度员", baseline: 1, deps: [], payload: { stationId: "s1", status: "封闭" }, time: tMinus(35), status: "applied" },
  { opId: "op-seed-2", type: "station.setStatus", role: "车站值班员", baseline: 1, deps: [], payload: { stationId: "s2", status: "限流" }, time: tMinus(20), status: "applied" },
  { opId: "op-seed-3", type: "plan.create", role: "公交接驳负责人", baseline: 1, deps: [], payload: { planId: "p2" }, time: tMinus(18), status: "applied" },
  { opId: "op-seed-4", type: "plan.countersign", role: "调度员", baseline: 1, deps: [], payload: { planId: "p2" }, time: tMinus(16), status: "applied" },
  { opId: "op-seed-5", type: "plan.countersign", role: "公交接驳负责人", baseline: 1, deps: [], payload: { planId: "p2" }, time: tMinus(15), status: "applied" }
];

function hasBothApprovals(plan: ShuttlePlan, baseline: number): boolean {
  const valid = plan.approvals.filter((a) => a.baseline === baseline);
  const roles = new Set(valid.map((a) => a.role));
  return roles.has("调度员") && roles.has("公交接驳负责人");
}

function latestApprovalTime(plan: ShuttlePlan, baseline: number): number {
  const valid = plan.approvals.filter((a) => a.baseline === baseline);
  return valid.length ? Math.max(...valid.map((a) => new Date(a.time).getTime())) : 0;
}

function latestApprovalOpId(plan: ShuttlePlan, baseline: number): string {
  const valid = plan.approvals.filter((a) => a.baseline === baseline);
  return valid.length ? valid.reduce((latest, a) => (new Date(a.time).getTime() > new Date(latest.time).getTime() ? a : latest)).opId : "";
}

function recomputeOccupancy(state: IncidentState): { plans: ShuttlePlan[]; occupancy: Occupancy[] } {
  const baseline = state.baseline;
  const signed = state.plans
    .filter((p) => p.status !== "已执行" && hasBothApprovals(p, baseline))
    .sort((a, b) => latestApprovalTime(a, baseline) - latestApprovalTime(b, baseline));
  let free = state.vehiclePool;
  const occupancy: Occupancy[] = [];
  const nextStatus = new Map<string, PlanStatus>();
  for (const plan of signed) {
    if (free >= plan.vehicles) {
      free -= plan.vehicles;
      nextStatus.set(plan.id, "已确认");
      occupancy.push({ planId: plan.id, vehicles: plan.vehicles, opId: latestApprovalOpId(plan, baseline), baseline, time: now() });
    } else {
      nextStatus.set(plan.id, "已排队");
    }
  }
  const plans = state.plans.map((p) => (nextStatus.has(p.id) ? { ...p, status: nextStatus.get(p.id)! } : p));
  return { plans, occupancy };
}

function recomputeSections(state: IncidentState): Section[] {
  return state.sections.map((sec) => {
    const members = sec.stationIds.map((id) => state.stations.find((s) => s.id === id)).filter((s): s is Station => Boolean(s));
    const allNormal = members.every((s) => s.status === "正常");
    const anyClosed = members.some((s) => s.status === "封闭");
    const anyRestricted = members.some((s) => s.status === "限流" || s.status === "恢复中");
    let passage: SectionPassage;
    if (sec.released && allNormal) passage = "放行";
    else if (anyClosed) passage = "封锁";
    else if (anyRestricted) passage = "限速";
    else passage = "待放行";
    return { ...sec, passage };
  });
}

function voidApprovals(plans: ShuttlePlan[], onlyPlanId?: string): ShuttlePlan[] {
  return plans.map((p) => {
    if (p.status === "已执行") return p;
    if (onlyPlanId && p.id !== onlyPlanId) return p;
    return { ...p, approvals: [], status: "待确认" as PlanStatus };
  });
}

function invalidateRelease(sections: Section[], stationId: string): Section[] {
  return sections.map((sec) => (sec.stationIds.includes(stationId) ? { ...sec, released: false, releaseBaseline: undefined } : sec));
}

function applyOp(state: IncidentState, op: Operation): ApplyResult {
  switch (op.type) {
    case "station.setStatus": {
      const { stationId, status, note } = op.payload as { stationId: string; status: StationStatus; note?: string };
      const station = state.stations.find((s) => s.id === stationId);
      if (!station) return { ok: false, reason: "车站不存在" };
      const stations = state.stations.map((s) => (s.id === stationId ? { ...s, status, note: note ?? s.note, updatedAt: now() } : s));
      const baseline = state.baseline + 1;
      const voided = voidApprovals(state.plans);
      const sections = recomputeSections({ ...state, stations, sections: invalidateRelease(state.sections, stationId) });
      const after: IncidentState = { ...state, stations, plans: voided, sections, baseline, occupancy: [] };
      const { plans, occupancy } = recomputeOccupancy(after);
      const timeline = [
        { id: crypto.randomUUID(), time: now(), actor: op.role, action: "更新车站状态", detail: `${station.name} → ${status}（基线 ${baseline}，会签与占用作废重算）`, phase: (status === "正常" || status === "恢复中" ? "恢复" : "响应") as "恢复" | "响应" },
        ...state.timeline
      ];
      return { ok: true, patch: { stations, plans, sections, baseline, occupancy, timeline } };
    }
    case "section.release": {
      const { sectionId } = op.payload as { sectionId: string };
      const section = state.sections.find((s) => s.id === sectionId);
      if (!section) return { ok: false, reason: "区段不存在" };
      const members = section.stationIds.map((id) => state.stations.find((s) => s.id === id)).filter((s): s is Station => Boolean(s));
      if (!members.every((s) => s.status === "正常")) {
        return { ok: false, reason: `车站未恢复，${section.name} 不能放行` };
      }
      const sections = state.sections.map((s) => (s.id === sectionId ? { ...s, released: true, releaseBaseline: state.baseline, passage: "放行" as SectionPassage } : s));
      const timeline = [
        { id: crypto.randomUUID(), time: now(), actor: op.role, action: "区段放行", detail: `${section.name} 区段已放行（基线 ${state.baseline}）`, phase: "恢复" as const },
        ...state.timeline
      ];
      return { ok: true, patch: { sections, timeline } };
    }
    case "plan.create": {
      const { plan } = op.payload as { plan: ShuttlePlan };
      if (state.plans.some((p) => p.id === plan.id)) return { ok: true, patch: {} };
      return { ok: true, patch: { plans: [plan, ...state.plans] } };
    }
    case "plan.updateVehicles": {
      const { planId, vehicles } = op.payload as { planId: string; vehicles: number };
      const plan = state.plans.find((p) => p.id === planId);
      if (!plan) return { ok: false, reason: "计划不存在" };
      if (plan.status === "已执行") return { ok: false, reason: "已执行计划不可变更车辆" };
      const baseline = state.baseline + 1;
      const voided = voidApprovals(state.plans, planId);
      const after: IncidentState = { ...state, plans: voided, baseline, occupancy: [] };
      const { plans, occupancy } = recomputeOccupancy(after);
      const timeline = [
        { id: crypto.randomUUID(), time: now(), actor: op.role, action: "调整接驳车辆", detail: `${plan.stations.join("→")} 车辆数 → ${vehicles}（基线 ${baseline}，会签与占用作废重算）`, phase: "接驳" as const },
        ...state.timeline
      ];
      return { ok: true, patch: { plans, baseline, occupancy, timeline } };
    }
    case "plan.submit": {
      const { planId } = op.payload as { planId: string };
      const plan = state.plans.find((p) => p.id === planId);
      if (!plan) return { ok: false, reason: "计划不存在" };
      if (plan.status !== "草稿") return { ok: false, reason: "计划已提交" };
      const plans = state.plans.map((p) => (p.id === planId ? { ...p, status: "待确认" as PlanStatus } : p));
      const timeline = [
        { id: crypto.randomUUID(), time: now(), actor: op.role, action: "提交接驳计划", detail: `${plan.stations.join("→")} 等待跨岗位会签`, phase: "接驳" as const },
        ...state.timeline
      ];
      return { ok: true, patch: { plans, timeline } };
    }
    case "plan.countersign": {
      const { planId } = op.payload as { planId: string };
      const plan = state.plans.find((p) => p.id === planId);
      if (!plan) return { ok: false, reason: "计划不存在" };
      if (plan.status === "草稿") return { ok: false, reason: "缺依赖：计划未提交" };
      if (plan.status === "已执行") return { ok: false, reason: "计划已执行" };
      if (plan.approvals.some((a) => a.role === op.role && a.baseline === state.baseline)) return { ok: false, reason: "已会签，勿重复" };
      const approval: Approval = { role: op.role, opId: op.opId, baseline: state.baseline, time: now() };
      const withApproval = state.plans.map((p) =>
        p.id === planId ? { ...p, approvals: [...p.approvals.filter((a) => a.baseline === state.baseline), approval] } : p
      );
      const after: IncidentState = { ...state, plans: withApproval, occupancy: [] };
      const { plans, occupancy } = recomputeOccupancy(after);
      const signed = plans.find((p) => p.id === planId);
      const timeline = [
        { id: crypto.randomUUID(), time: now(), actor: op.role, action: "会签接驳计划", detail: `${plan.stations.join("→")} ${op.role} 已会签（${signed?.status === "已排队" ? "车辆池已满，排队" : "占用车辆"}）`, phase: "接驳" as const },
        ...state.timeline
      ];
      return { ok: true, patch: { plans, occupancy, timeline } };
    }
    case "plan.execute": {
      const { planId } = op.payload as { planId: string };
      const plan = state.plans.find((p) => p.id === planId);
      if (!plan) return { ok: false, reason: "计划不存在" };
      if (plan.status === "已执行") return { ok: true, patch: {} };
      if (plan.status === "草稿" || plan.status === "待确认") return { ok: false, reason: "缺会签，计划未确认" };
      if (plan.status === "已排队") return { ok: false, reason: "车辆占用中，计划排队未确认，不能执行" };
      const marked = state.plans.map((p) => (p.id === planId ? { ...p, status: "已执行" as PlanStatus } : p));
      const after: IncidentState = { ...state, plans: marked, occupancy: state.occupancy.filter((o) => o.planId !== planId) };
      const { plans, occupancy } = recomputeOccupancy(after);
      const timeline = [
        { id: crypto.randomUUID(), time: now(), actor: op.role, action: "执行接驳计划", detail: `${plan.stations.join("→")} 已下发执行`, phase: "接驳" as const },
        ...state.timeline
      ];
      return { ok: true, patch: { plans, occupancy, timeline } };
    }
    case "timeline.add": {
      const entry = op.payload.entry as Omit<TimelineEntry, "id" | "time">;
      const timeline = [{ ...entry, id: crypto.randomUUID(), time: now() }, ...state.timeline];
      return { ok: true, patch: { timeline } };
    }
  }
}

function makeOp(type: OpType, role: Role, baseline: number, deps: string[], payload: Record<string, any>): Operation {
  return { opId: crypto.randomUUID(), type, role, baseline, deps, payload, time: now(), status: "queued" };
}

function findQueuedOpId(state: IncidentState, pred: (o: Operation) => boolean): string | undefined {
  return state.operations.find((o) => (o.status === "queued" || o.status === "retry") && pred(o))?.opId;
}

function opLabel(type: OpType): string {
  switch (type) {
    case "station.setStatus": return "更新车站状态";
    case "section.release": return "区段放行";
    case "plan.create": return "创建接驳计划";
    case "plan.updateVehicles": return "调整接驳车辆";
    case "plan.submit": return "提交接驳计划";
    case "plan.countersign": return "会签接驳计划";
    case "plan.execute": return "执行接驳计划";
    case "timeline.add": return "添加处置记录";
  }
}

function opDetail(op: Operation): string {
  switch (op.type) {
    case "station.setStatus": return `${op.payload.stationId} → ${op.payload.status}`;
    case "section.release": return op.payload.sectionId;
    case "plan.create": return op.payload.plan?.stations?.join(" → ") ?? op.payload.planId;
    case "plan.updateVehicles": return `${op.payload.planId} → ${op.payload.vehicles} 辆`;
    case "plan.submit": return op.payload.planId;
    case "plan.countersign": return op.payload.planId;
    case "plan.execute": return op.payload.planId;
    case "timeline.add": return op.payload.entry?.detail ?? "";
  }
}

export const useIncidentStore = create<IncidentState>()(persist((set, get) => ({
  incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
  stations: seedStations,
  sections: seedSections,
  timeline: [
    { id: "e1", time: tMinus(35), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
    { id: "e2", time: tMinus(27), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
  ],
  plans: [
    { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: [{ role: "调度员", opId: "op-seed-4", baseline: 1, time: tMinus(16) }], note: "优先疏运站外滞留乘客" },
    { id: "p2", stations: ["东港站", "滨江站"], vehicles: 10, interval: 8, operator: "东城公交", status: "已确认", approvals: [
      { role: "调度员", opId: "op-seed-4", baseline: 1, time: tMinus(16) },
      { role: "公交接驳负责人", opId: "op-seed-5", baseline: 1, time: tMinus(15) }
    ], note: "东港站备车，接续疏运" }
  ],
  occupancy: [{ planId: "p2", vehicles: 10, opId: "op-seed-5", baseline: 1, time: tMinus(15) }],
  vehiclePool: 30,
  role: "调度员",
  online: true,
  baseline: 1,
  operations: seedOperations,
  setRole: (role) => set({ role }),
  setOnline: (online) => set({ online }),
  setStationStatus: (id, status, note) => {
    const state = get();
    const op = makeOp("station.setStatus", state.role, state.baseline, [], { stationId: id, status, note });
    if (state.online) {
      const result = applyOp(state, op);
      if (!result.ok) return result;
      set({ ...result.patch, operations: [{ ...op, status: "applied" }, ...state.operations] });
      return { ok: true };
    }
    set({ operations: [op, ...state.operations] });
    return { ok: true };
  },
  addTimeline: (entry) => {
    const state = get();
    const op = makeOp("timeline.add", state.role, state.baseline, [], { entry });
    if (state.online) {
      const result = applyOp(state, op);
      if (!result.ok) return result;
      set({ ...result.patch, operations: [{ ...op, status: "applied" }, ...state.operations] });
      return { ok: true };
    }
    set({ operations: [op, ...state.operations] });
    return { ok: true };
  },
  addPlan: (plan) => {
    const state = get();
    const newPlan: ShuttlePlan = { ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [] };
    const op = makeOp("plan.create", state.role, state.baseline, [], { plan: newPlan });
    if (state.online) {
      const result = applyOp(state, op);
      if (!result.ok) return result;
      set({ ...result.patch, operations: [{ ...op, status: "applied" }, ...state.operations] });
      return { ok: true };
    }
    set({ operations: [op, ...state.operations] });
    return { ok: true };
  },
  updatePlanVehicles: (id, vehicles) => {
    const state = get();
    const deps = state.online ? [] : [findQueuedOpId(state, (o) => o.type === "plan.create" && o.payload.plan?.id === id)].filter((d): d is string => Boolean(d));
    const op = makeOp("plan.updateVehicles", state.role, state.baseline, deps, { planId: id, vehicles });
    if (state.online) {
      const result = applyOp(state, op);
      if (!result.ok) return result;
      set({ ...result.patch, operations: [{ ...op, status: "applied" }, ...state.operations] });
      return { ok: true };
    }
    set({ operations: [op, ...state.operations] });
    return { ok: true };
  },
  submitPlan: (id) => {
    const state = get();
    const deps = state.online ? [] : [findQueuedOpId(state, (o) => o.type === "plan.create" && o.payload.plan?.id === id)].filter((d): d is string => Boolean(d));
    const op = makeOp("plan.submit", state.role, state.baseline, deps, { planId: id });
    if (state.online) {
      const result = applyOp(state, op);
      if (!result.ok) return result;
      set({ ...result.patch, operations: [{ ...op, status: "applied" }, ...state.operations] });
      return { ok: true };
    }
    set({ operations: [op, ...state.operations] });
    return { ok: true };
  },
  countersignPlan: (id) => {
    const state = get();
    const deps = state.online ? [] : [
      findQueuedOpId(state, (o) => o.type === "plan.submit" && o.payload.planId === id),
      findQueuedOpId(state, (o) => o.type === "plan.create" && o.payload.plan?.id === id)
    ].filter((d): d is string => Boolean(d));
    const op = makeOp("plan.countersign", state.role, state.baseline, deps, { planId: id });
    if (state.online) {
      const result = applyOp(state, op);
      if (!result.ok) return result;
      set({ ...result.patch, operations: [{ ...op, status: "applied" }, ...state.operations] });
      return { ok: true };
    }
    set({ operations: [op, ...state.operations] });
    return { ok: true };
  },
  executePlan: (id) => {
    const state = get();
    const deps = state.online ? [] : [
      findQueuedOpId(state, (o) => o.type === "plan.countersign" && o.payload.planId === id),
      findQueuedOpId(state, (o) => o.type === "plan.submit" && o.payload.planId === id),
      findQueuedOpId(state, (o) => o.type === "plan.create" && o.payload.plan?.id === id)
    ].filter((d): d is string => Boolean(d));
    const op = makeOp("plan.execute", state.role, state.baseline, deps, { planId: id });
    if (state.online) {
      const result = applyOp(state, op);
      if (!result.ok) return result;
      set({ ...result.patch, operations: [{ ...op, status: "applied" }, ...state.operations] });
      return { ok: true };
    }
    set({ operations: [op, ...state.operations] });
    return { ok: true };
  },
  releaseSection: (id) => {
    const state = get();
    const deps = state.online ? [] : state.operations
      .filter((o) => (o.status === "queued" || o.status === "retry") && o.type === "station.setStatus" && state.sections.find((s) => s.id === id)?.stationIds.includes(o.payload.stationId))
      .map((o) => o.opId);
    const op = makeOp("section.release", state.role, state.baseline, deps, { sectionId: id });
    if (state.online) {
      const result = applyOp(state, op);
      if (!result.ok) return result;
      set({ ...result.patch, operations: [{ ...op, status: "applied" }, ...state.operations] });
      return { ok: true };
    }
    set({ operations: [op, ...state.operations] });
    return { ok: true };
  },
  syncActions: () => set((state) => {
    const pending = state.operations.filter((o) => o.status === "queued" || o.status === "retry");
    if (!pending.length) return { online: true };
    const applied = new Set(state.operations.filter((o) => o.status === "applied").map((o) => o.opId));
    const pendingById = new Map(pending.map((o) => [o.opId, o]));
    const sorted: Operation[] = [];
    const visited = new Set<string>();
    const visit = (op: Operation) => {
      if (visited.has(op.opId)) return;
      visited.add(op.opId);
      for (const dep of op.deps) {
        const depOp = pendingById.get(dep);
        if (depOp) visit(depOp);
      }
      sorted.push(op);
    };
    [...pending].sort((a, b) => a.time.localeCompare(b.time) || a.opId.localeCompare(b.opId)).forEach(visit);

    let current: IncidentState = state;
    const newOps = state.operations.map((o) => ({ ...o }));
    for (const op of sorted) {
      if (applied.has(op.opId)) {
        const idx = newOps.findIndex((o) => o.opId === op.opId);
        if (idx >= 0) newOps[idx] = { ...newOps[idx], status: "applied", reason: undefined };
        continue;
      }
      if (!AUTHORITY[op.type].includes(op.role)) {
        const idx = newOps.findIndex((o) => o.opId === op.opId);
        newOps[idx] = { ...newOps[idx], status: "retry", reason: `越权：${op.role} 无权执行 ${opLabel(op.type)}` };
        continue;
      }
      const missing = op.deps.filter((d) => !applied.has(d));
      if (missing.length) {
        const idx = newOps.findIndex((o) => o.opId === op.opId);
        newOps[idx] = { ...newOps[idx], status: "retry", reason: `缺依赖：操作 ${missing.map((m) => m.slice(0, 8)).join("、")} 未生效` };
        continue;
      }
      const result = applyOp(current, op);
      if (!result.ok) {
        const idx = newOps.findIndex((o) => o.opId === op.opId);
        newOps[idx] = { ...newOps[idx], status: "retry", reason: result.reason };
        continue;
      }
      current = { ...current, ...result.patch };
      applied.add(op.opId);
      const idx = newOps.findIndex((o) => o.opId === op.opId);
      newOps[idx] = { ...newOps[idx], status: "applied", reason: undefined };
    }
    return { ...current, operations: newOps, online: true };
  })
}), { name: "pair-wise-yf-47/incident" }));

export { opLabel, opDetail };
