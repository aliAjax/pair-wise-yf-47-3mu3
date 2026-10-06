"use client";

import { useEffect, useState } from "react";
import { App as AntApp, Badge, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Segmented, Space, Statistic, Table, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import { useIncidentStore, opLabel, opDetail, type Role, type Section, type ShuttlePlan, type Station, type StationStatus, type Operation, type OpStatus } from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择两个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const statusColor: Record<StationStatus, string> = { "封闭": "red", "限流": "orange", "恢复中": "blue", "正常": "green" };
const passageColor: Record<string, string> = { "封锁": "red", "限速": "orange", "待放行": "default", "放行": "green" };
const planStatusColor: Record<string, string> = { "草稿": "default", "待确认": "orange", "已确认": "green", "已排队": "gold", "已执行": "blue" };
const opStatusColor: Record<OpStatus, string> = { applied: "green", queued: "blue", retry: "red" };
const opStatusLabel: Record<OpStatus, string> = { applied: "已生效", queued: "排队中", retry: "重试" };

function Dashboard() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const state = useIncidentStore();
  const { data: cachedStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online });
  const [modalOpen, setModalOpen] = useState(false);
  const [panel, setPanel] = useState<string>("总览");
  const [messageApi, contextHolder] = message.useMessage();
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  const pendingActions = state.operations.filter((o) => o.status === "queued" || o.status === "retry");
  const occupiedVehicles = state.occupancy.reduce((sum, o) => sum + o.vehicles, 0);
  const queuedPlans = state.plans.filter((p) => p.status === "已排队").length;

  const run = (fn: () => { ok: boolean; reason?: string }, okMsg?: string) => {
    const result = fn();
    if (!result.ok) messageApi.error(result.reason ?? "操作失败");
    else if (okMsg) messageApi.success(okMsg);
  };

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={statusColor[value]}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "处置", render: (_, record) => <Space><Button size="small" disabled={state.role === "客服主管"} onClick={() => run(() => state.setStationStatus(record.id, "限流"))}>限流</Button><Button size="small" disabled={state.role === "客服主管"} danger={record.status !== "封闭"} onClick={() => run(() => state.setStationStatus(record.id, record.status === "封闭" ? "恢复中" : "封闭"))}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button></Space> }
  ];

  const sectionColumns: ColumnsType<Section> = [
    { title: "区段", dataIndex: "name" },
    { title: "包含车站", dataIndex: "stationIds", render: (ids: string[]) => ids.map((id) => state.stations.find((s) => s.id === id)?.name ?? id).join("、") },
    { title: "通行状态", dataIndex: "passage", render: (value: string) => <Tag color={passageColor[value]}>{value}</Tag> },
    { title: "放行基线", dataIndex: "releaseBaseline", render: (v?: number) => v ? `基线 ${v}` : "—" },
    { title: "操作", render: (_, record) => <Button size="small" type="primary" disabled={state.role !== "调度员" || record.passage === "放行"} onClick={() => run(() => state.releaseSection(record.id), `区段 ${record.name} 已放行`)}>放行</Button> }
  ];

  const planColumns: ColumnsType<ShuttlePlan> = [
    { title: "接驳站", dataIndex: "stations", render: (v: string[]) => v.join(" → ") },
    { title: "车辆", dataIndex: "vehicles", render: (v: number, record) => <Space>{v} 辆<Button size="small" type="link" disabled={record.status === "已执行" || (state.role !== "公交接驳负责人" && state.role !== "调度员")} onClick={() => { const next = window.prompt(`调整 ${record.stations.join("→")} 车辆数（当前 ${record.vehicles}）`, String(record.vehicles)); if (next) { const n = Number(next); if (n >= 1 && n <= 80) run(() => state.updatePlanVehicles(record.id, n)); } }}>调整</Button></Space> },
    { title: "间隔", dataIndex: "interval", render: (v: number) => `${v} 分钟` },
    { title: "运营方", dataIndex: "operator" },
    { title: "会签", dataIndex: "approvals", render: (v: { role: Role; baseline: number }[]) => v.length ? v.map((x) => <Tag key={x.role} color="green">{x.role}·基线{x.baseline}</Tag>) : <Tag>未会签</Tag> },
    { title: "占用", render: (_, record) => { const occ = state.occupancy.find((o) => o.planId === record.id); return occ ? <Tag color="blue">占用 {occ.vehicles} 辆</Tag> : record.status === "已排队" ? <Tag color="gold">排队</Tag> : <Tag>—</Tag>; } },
    { title: "状态", dataIndex: "status", render: (v) => <Tag color={planStatusColor[v]}>{v}</Tag> },
    { title: "操作", render: (_, record) => <Space><Button size="small" disabled={record.status !== "草稿" || (state.role !== "公交接驳负责人" && state.role !== "调度员")} onClick={() => run(() => state.submitPlan(record.id))}>提交</Button><Button size="small" disabled={record.status !== "待确认" || (state.role !== "公交接驳负责人" && state.role !== "调度员")} onClick={() => run(() => state.countersignPlan(record.id))}>会签</Button><Button size="small" type="primary" disabled={record.status !== "已确认" || state.role !== "调度员"} onClick={() => run(() => state.executePlan(record.id), "计划已执行")}>执行</Button></Space> }
  ];

  const opColumns: ColumnsType<Operation> = [
    { title: "操作号", dataIndex: "opId", render: (v: string) => <code>{v.slice(0, 8)}</code> },
    { title: "类型", dataIndex: "type", render: (v: string) => opLabel(v as never) },
    { title: "岗位", dataIndex: "role" },
    { title: "基线", dataIndex: "baseline", render: (v: number) => `基线 ${v}` },
    { title: "依赖", dataIndex: "deps", render: (v: string[]) => v.length ? v.map((d) => <Tag key={d}>{d.slice(0, 8)}</Tag>) : "—" },
    { title: "内容", render: (_, record) => opDetail(record) },
    { title: "状态", dataIndex: "status", render: (v: OpStatus) => <Tag color={opStatusColor[v]}>{opStatusLabel[v]}</Tag> },
    { title: "原因", dataIndex: "reason", render: (v?: string) => v ?? "—" },
    { title: "时间", dataIndex: "time", render: (v: string) => format(new Date(v), "MM-DD HH:mm:ss") }
  ];

  const submitPlan = (values: PlanForm) => { const parsed = planSchema.safeParse(values); if (!parsed.success) return; state.addPlan(parsed.data); setModalOpen(false); reset(); };

  return <div className="shell">
    {contextHolder}
    <aside className="side">
      <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
      <nav>{["总览", "事件时间线", "接驳计划", "确认中心", "操作台账"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
      <div className="side-status"><small>系统连接</small><b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b><span>基线 {state.baseline} · 待同步 {pendingActions.length}</span></div>
    </aside>
    <main>
      <header><div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Space><Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} /><Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} /></Space></header>
      <section className="metrics"><Card><Statistic title="事件状态" value={state.incident.status} /></Card><Card><Statistic title="受影响车站" value={state.stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card><Card><Statistic title="待确认计划" value={state.plans.filter((item) => item.status === "待确认" || item.status === "已排队").length} /></Card><Card><Statistic title="待同步操作" value={pendingActions.length} /></Card></section>
      {!state.online && <div className="degrade">当前处于弱网降级模式，显示最近缓存数据。关键处置进入本地队列，携带岗位、基线与依赖；恢复连接后按依赖合并，越权或缺依赖的操作留在重试队列。</div>}
      {panel === "总览" && <section className="overview">
        <Card title={t("stations")} className="wide"><Table rowKey="id" dataSource={state.online && cachedStations?.length ? cachedStations : state.stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 760 }} /></Card>
        <Card title="区段通行" className="wide"><Table rowKey="id" dataSource={state.sections} columns={sectionColumns} pagination={false} size="small" /></Card>
        <Card title="受影响区段" className="map-card"><MapPanel stations={state.stations} plans={state.plans.filter((plan) => plan.status !== "草稿")} /></Card>
      </section>}
      {panel === "事件时间线" && <Card title="处置时间线" extra={<Space><Select value="响应" options={[{value:"响应"},{value:"接驳"},{value:"恢复"}]} /><Button type="primary" onClick={() => run(() => state.addTimeline({ actor: state.role, action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" }))}>添加处置记录</Button></Space>}><div className="timeline-grid"><Timeline items={state.timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red", children: <div><b>{item.action}</b><Tag>{item.actor}</Tag><p>{item.detail}</p><small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small></div> }))} /><Card size="small" title="处置检查"><p>车站未恢复，所在区段不能放行。</p><p>车站或车辆数一变，会签与占用作废重算。</p><p>车辆池有限，先到占用、晚到排队。</p></Card></div></Card>}
      {panel === "接驳计划" && <Card title="公交接驳计划" extra={<Space><Tag color="blue">车辆池 {occupiedVehicles}/{state.vehiclePool}</Tag>{queuedPlans > 0 && <Tag color="gold">{queuedPlans} 项排队</Tag>}<Button type="primary" disabled={state.role !== "公交接驳负责人" && state.role !== "调度员"} onClick={() => setModalOpen(true)}>新建计划</Button></Space>}><Table rowKey="id" pagination={false} dataSource={state.plans} columns={planColumns} /></Card>}
      {panel === "确认中心" && <Card title="跨岗位确认中心" extra={<Button type="primary" disabled={state.online || !pendingActions.length} onClick={state.syncActions}>恢复网络并按依赖合并</Button>}><Timeline items={state.plans.map((plan) => ({ children: <div className="approval"><b>{plan.stations.join(" → ")}</b><Tag color={planStatusColor[plan.status]}>{plan.status}</Tag><p>{plan.vehicles} 辆，间隔 {plan.interval} 分钟，{plan.note}</p><small>已会签：{plan.approvals.map((a) => `${a.role}·基线${a.baseline}`).join("、") || "暂无"}</small></div> }))} /><Card size="small" title="重试队列" style={{ marginTop: 16 }}><Table rowKey="opId" size="small" pagination={false} dataSource={pendingActions} columns={opColumns} locale={{ emptyText: "暂无排队/重试操作" }} /></Card></Card>}
      {panel === "操作台账" && <Card title="操作台账" extra={<Tag>基线 {state.baseline}</Tag>}><Table rowKey="opId" size="small" pagination={{ pageSize: 12 }} dataSource={[...state.operations].sort((a, b) => b.time.localeCompare(a.time))} columns={opColumns} /></Card>}
    </main>
    <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿"><Form layout="vertical"><Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}><Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.name, label: item.name }))} />} /></Form.Item><Space><Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} max={80} />} /></Form.Item><Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} max={30} addonAfter="分钟" />} /></Form.Item></Space><Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item><Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item></Form></Modal>
  </div>;
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
