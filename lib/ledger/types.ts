// 处置账领域模型与操作协议
// 三类岗位共用同一份账：调度员、车站值班员、公交接驳负责人

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";

export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
// 未恢复（不允许区段放行）的车站状态
export const BLOCKED_STATION_STATUSES: ReadonlySet<StationStatus> = new Set(["限流", "封闭", "恢复中"]);

export type SectionStatus = "封闭" | "放行";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";

// 车辆占用生命周期：排队 -> 占用 -> 释放/作废
export type HoldStatus = "排队" | "占用" | "释放" | "作废";

export interface Station {
  id: string;
  name: string;
  // 滨江站为相邻三区段的共用车站，区段联动按此多对多关系计算
  sectionIds: string[];
  status: StationStatus;
  passengerRisk: "低" | "中" | "高";
  note: string;
  version: number;
  updatedAt: string;
}

export interface Section {
  id: string;
  name: string;
  stationIds: string[];
  // 只有区段内所有车站均恢复（正常）才允许置为放行
  status: SectionStatus;
  releasedAt?: string;
  note: string;
  version: number;
}

export interface ShuttlePlan {
  id: string;
  name: string;
  stationIds: string[];
  vehicles: number;
  intervalMin: number;
  operator: string;
  note: string;
  status: PlanStatus;
  // 会签记录：同一岗位只计一次
  countersigns: { role: Role; at: string; opId: string }[];
  // 最近一次提交会签的操作号（会签/执行的依赖锚点）
  submitOpId?: string;
  // 会签/占用是否因车站或车辆数变化被作废
  voidReason?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface VehicleHold {
  id: string; // opId of plan.vehicles
  planId: string;
  requested: number;
  status: HoldStatus;
  // 全局排队序号，先到者排前
  queueSeq: number;
  requestedAt: string;
  allocatedAt?: string;
  releasedAt?: string;
  voidReason?: string;
}

export interface VehiclePool {
  total: number;
}

export type LedgerPhase = "车站" | "区段" | "接驳" | "系统";

export interface LedgerEvent {
  id: string;
  time: string;
  phase: LedgerPhase;
  role: Role | "系统";
  opId?: string;
  text: string;
}

// ---- 操作协议：断网操作带岗位、基线（baseVersion）和依赖（dependsOn）----

interface OpBase {
  opId: string;
  role: Role;
  baseVersion: number; // 操作所基于的实体版本
  dependsOn?: string[]; // 依赖的其它操作号，生效前依赖必须已生效
  at: string; // 操作产生时间（提交时刻，先到先得以它为准）
}

export interface StationStatusOp extends OpBase {
  type: "station.status";
  stationId: string;
  status: StationStatus;
  note?: string;
}

export interface SectionReleaseOp extends OpBase {
  type: "section.release";
  sectionId: string;
  note?: string;
}

export interface PlanUpsertOp extends OpBase {
  type: "plan.upsert";
  planId: string; // 新建时由提交端预生成
  name: string;
  stationIds: string[];
  vehicles: number;
  intervalMin: number;
  operator: string;
  note: string;
  create?: boolean;
}

export interface PlanSubmitOp extends OpBase {
  type: "plan.submit";
  planId: string;
}

export interface PlanSignOp extends OpBase {
  type: "plan.sign";
  planId: string;
}

export interface PlanExecuteOp extends OpBase {
  type: "plan.execute";
  planId: string;
}

export type LedgerOperation =
  | StationStatusOp
  | SectionReleaseOp
  | PlanUpsertOp
  | PlanSubmitOp
  | PlanSignOp
  | PlanExecuteOp;

export type RetryReason = "越权" | "缺依赖" | "基线过期" | "业务条件不满足";

export interface QueuedOperation {
  op: LedgerOperation;
  reason: RetryReason;
  detail: string;
  enqueuedAt: string;
  attempts: number;
}

export interface LedgerState {
  incident: { id: string; title: string; startedAt: string };
  sections: Section[];
  stations: Station[];
  plans: ShuttlePlan[];
  holds: VehicleHold[];
  pool: VehiclePool;
  events: LedgerEvent[];
  // 已生效操作号，同一操作号只生效一次
  appliedOpIds: string[];
  // 越权 / 缺依赖 / 基线过期 / 条件不满足的留在重试队列
  retryQueue: QueuedOperation[];
  // 已作废操作号（例如依赖的车辆申请被作废后，会签自动作废）
  voidedOpIds: { opId: string; reason: string; at: string }[];
  queueCounter: number;
  version: number;
}

export interface MergeResult {
  state: LedgerState;
  applied: string[];
  retried: { opId: string; reason: RetryReason; detail: string }[];
  duplicates: string[];
}
