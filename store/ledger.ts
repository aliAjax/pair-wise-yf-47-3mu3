"use client";

import { create, type StateCreator } from "zustand";
import { persist } from "zustand/middleware";
import {
  activeHoldOf,
  freshState,
  iso,
  mergeLedger,
  stationsOfSection,
  uid,
} from "../lib/ledger/engine";
import type {
  LedgerOperation,
  LedgerState,
  PlanUpsertOp,
  Role,
  SectionReleaseOp,
  StationStatus,
  StationStatusOp,
  PlanSubmitOp,
  PlanSignOp,
  PlanExecuteOp,
} from "../lib/ledger/types";

// 保证同毫秒提交也严格先到先得：到达时刻只在 ISO 基础上向后推
function monotonicClock(lastRef: { current: number }): () => string {
  return () => {
    const t = Date.now();
    lastRef.current = t > lastRef.current ? t : lastRef.current + 1;
    return new Date(lastRef.current).toISOString();
  };
}

export interface PlanDraft {
  name: string;
  stationIds: string[];
  vehicles: number;
  intervalMin: number;
  operator: string;
  note: string;
}

interface LedgerStore extends LedgerState {
  role: Role;
  online: boolean;
  outbox: LedgerOperation[]; // 断网期间待同步的操作
  lastSyncAt?: string;
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;

  setStationStatus: (stationId: string, status: StationStatus, note?: string) => void;
  releaseSection: (sectionId: string, note?: string) => void;
  createPlan: (draft: PlanDraft) => string;
  updatePlan: (planId: string, draft: PlanDraft) => void;
  submitPlan: (planId: string) => void;
  signPlan: (planId: string) => void;
  executePlan: (planId: string) => void;

  retryQueued: () => void;
  discardQueued: (opId: string) => void;
  resetAll: () => void;
}

const clock = monotonicClock({ current: Date.now() });

function buildDeps(state: LedgerState, op: LedgerOperation): string[] {
  switch (op.type) {
    case "section.release": {
      // 放行依赖区段内各车站最近一次恢复上报
      const ids: string[] = [];
      for (const station of stationsOfSection(state, op.sectionId)) {
        const evt = state.events.find((e) => e.phase === "车站" && e.opId && e.text.includes(station.name));
        if (evt?.opId) ids.push(evt.opId);
      }
      return ids;
    }
    case "plan.submit":
      return activeHoldOf(state, op.planId) ? [activeHoldOf(state, op.planId)!.id] : [];
    case "plan.sign": {
      const plan = state.plans.find((p) => p.id === op.planId);
      return plan?.submitOpId ? [plan.submitOpId] : [];
    }
    case "plan.execute": {
      const plan = state.plans.find((p) => p.id === op.planId);
      return plan ? [plan.submitOpId, ...plan.countersigns.map((c) => c.opId)].filter(Boolean) as string[] : [];
    }
    default:
      return [];
  }
}

export const useLedgerStore = create<LedgerStore>()(
  persist(
    ((set, get): LedgerStore => {
      // 统一的提交通道：在线立即入账；断网先本地入账保证离线续作，并放入发件箱待恢复合并
      const dispatch = (make: (opId: string, at: string) => LedgerOperation) => {
        const op = make(uid("op"), clock());
        const s = get();
        const withDeps: LedgerOperation = { ...op, dependsOn: Array.from(new Set([...(op.dependsOn ?? []), ...buildDeps(s, op)])) };
        const result = mergeLedger(s, [withDeps], clock());
        set({
          ...stripLedger(result.state),
          outbox: s.online ? s.outbox.filter((item) => !result.duplicates.includes(item.opId)) : [...s.outbox, withDeps],
        });
      };

      return {
        ...freshState(iso()),
        role: "调度员",
        online: true,
        outbox: [],

        setRole: (role) => set({ role }),
        setOnline: (online) => {
          if (online) {
            // 恢复联网：按依赖重新合并发件箱；同一操作号幂等，只生效一次
            const s = get();
            const result = mergeLedger(s, s.outbox, clock());
            // 已生效或确认重复（同一操作号只生效一次）的操作离开发件箱；
            // 仍停留在重试队列的（越权/缺依赖/基线过期/条件不满足）继续保留，待重试或放弃
            const settled = new Set([...result.applied, ...result.duplicates]);
            set({
              ...stripLedger(result.state),
              online: true,
              outbox: s.outbox.filter((op) => !settled.has(op.opId)),
              lastSyncAt: iso(),
            });
          } else {
            set({ online: false });
          }
        },

        setStationStatus: (stationId, status, note) =>
          dispatch((opId, at) => {
            const station = get().stations.find((x) => x.id === stationId)!;
            const op: StationStatusOp = { opId, type: "station.status", role: get().role, baseVersion: station.version, stationId, status, note, at };
            return op;
          }),

        releaseSection: (sectionId, note) =>
          dispatch((opId, at) => {
            const section = get().sections.find((x) => x.id === sectionId)!;
            const op: SectionReleaseOp = { opId, type: "section.release", role: get().role, baseVersion: section.version, sectionId, note, at };
            return op;
          }),

        createPlan: (draft) => {
          const planId = uid("plan");
          dispatch((opId, at) => {
            const op: PlanUpsertOp = { opId, type: "plan.upsert", role: get().role, baseVersion: 0, planId, create: true, ...draft, at };
            return op;
          });
          return planId;
        },

        updatePlan: (planId, draft) =>
          dispatch((opId, at) => {
            const plan = get().plans.find((x) => x.id === planId)!;
            const op: PlanUpsertOp = { opId, type: "plan.upsert", role: get().role, baseVersion: plan.version, planId, ...draft, at };
            return op;
          }),

        submitPlan: (planId) =>
          dispatch((opId, at) => {
            const plan = get().plans.find((x) => x.id === planId)!;
            const op: PlanSubmitOp = { opId, type: "plan.submit", role: get().role, baseVersion: plan.version, planId, at };
            return op;
          }),

        signPlan: (planId) =>
          dispatch((opId, at) => {
            const plan = get().plans.find((x) => x.id === planId)!;
            const op: PlanSignOp = { opId, type: "plan.sign", role: get().role, baseVersion: plan.version, planId, at };
            return op;
          }),

        executePlan: (planId) =>
          dispatch((opId, at) => {
            const plan = get().plans.find((x) => x.id === planId)!;
            const op: PlanExecuteOp = { opId, type: "plan.execute", role: get().role, baseVersion: plan.version, planId, at };
            return op;
          }),

        retryQueued: () => {
          const s = get();
          if (s.retryQueue.length === 0) return;
          const ops = s.retryQueue.map((q) => q.op);
          const result = mergeLedger({ ...s, retryQueue: [] }, ops, clock());
          const settled = new Set([...result.applied, ...result.duplicates]);
          set({
            ...stripLedger(result.state),
            outbox: s.outbox.filter((op) => !settled.has(op.opId)),
            lastSyncAt: iso(),
          });
        },

        discardQueued: (opId) =>
          set((s) => ({ retryQueue: s.retryQueue.filter((q) => q.op.opId !== opId), outbox: s.outbox.filter((op) => op.opId !== opId) })),

        resetAll: () => set({ ...freshState(iso()), role: get().role, online: true, outbox: [], lastSyncAt: undefined }),
      };
    }),
    {
      name: "pair-wise-yf-47/ledger",
      version: 2,
      partialize: (s) => ({
        incident: s.incident,
        sections: s.sections,
        stations: s.stations,
        plans: s.plans,
        holds: s.holds,
        pool: s.pool,
        events: s.events,
        appliedOpIds: s.appliedOpIds,
        retryQueue: s.retryQueue,
        voidedOpIds: s.voidedOpIds,
        queueCounter: s.queueCounter,
        version: s.version,
        role: s.role,
        online: s.online,
        outbox: s.outbox,
        lastSyncAt: s.lastSyncAt,
      }),
    }
  )
);

function stripLedger(state: LedgerState): LedgerState {
  const { sections, stations, plans, holds, pool, events, appliedOpIds, retryQueue, voidedOpIds, queueCounter, version, incident } = state;
  return { incident, sections, stations, plans, holds, pool, events, appliedOpIds, retryQueue, voidedOpIds, queueCounter, version };
}
