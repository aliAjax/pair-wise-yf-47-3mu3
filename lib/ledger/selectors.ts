import type { LedgerState, ShuttlePlan, Station, Section } from "./types";
import { activeHoldOf, allocatedVehicles, availableVehicles, isSectionOpenable, stationsOfSection } from "./engine";

export interface PlanView {
  plan: ShuttlePlan;
  stationNames: string[];
  hold: ReturnType<typeof activeHoldOf>;
  signedByDispatcher: boolean;
  signedByShuttle: boolean;
  countersignComplete: boolean;
  canSubmit: boolean;
  canExecute: boolean;
}

export function planViews(state: LedgerState): PlanView[] {
  const nameOf = (id: string) => state.stations.find((s) => s.id === id)?.name ?? id;
  return state.plans.map((plan) => {
    const signedRoles = new Set(plan.countersigns.map((c) => c.role));
    const hold = activeHoldOf(state, plan.id);
    const countersignComplete = plan.countersigns.length >= 2;
    return {
      plan,
      stationNames: plan.stationIds.map(nameOf),
      hold,
      signedByDispatcher: signedRoles.has("调度员"),
      signedByShuttle: signedRoles.has("公交接驳负责人"),
      countersignComplete,
      canSubmit: plan.status === "草稿" && hold?.status === "占用",
      canExecute: plan.status === "已确认" && countersignComplete,
    };
  });
}

export interface SectionView {
  section: Section;
  stations: Station[];
  openable: boolean;
  blockedBy: string[];
}

export function sectionViews(state: LedgerState): SectionView[] {
  return state.sections.map((section) => {
    const list = stationsOfSection(state, section.id);
    return {
      section,
      stations: list,
      openable: isSectionOpenable(state, section.id),
      blockedBy: list.filter((s) => s.status !== "正常").map((s) => `${s.name}（${s.status}）`),
    };
  });
}

export { activeHoldOf, allocatedVehicles, availableVehicles };
