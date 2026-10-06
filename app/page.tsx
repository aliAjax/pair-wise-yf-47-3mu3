"use client";

import { useMemo, useState } from "react";
import {
  App as AntApp,
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from "antd";
import { format } from "date-fns";
import { z } from "zod";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import {
  allocatedVehicles,
  availableVehicles,
  planViews,
  sectionViews,
} from "../lib/ledger/selectors";
import { isStationRecovered } from "../lib/ledger/engine";
import type { Role, Station, StationStatus, Section } from "../lib/ledger/types";
import { useLedgerStore, type PlanDraft } from "../store/ledger";
import { MapPanel } from "../components/MapPanel";

const ROLES: Role[] = ["调度员", "车站值班员", "公交接驳负责人", "客服主管"];

const planSchema = z.object({
  name: z.string().min(2, "计划名称至少 2 个字"),
  stationIds: z.array(z.string()).min(1, "至少选择一个接驳站"),
  vehicles: z.number().int("车辆数为整数").min(1, "至少 1 辆"),
  intervalMin: z.number().int().min(2, "间隔至少 2 分钟").max(60, "间隔不超过 60 分钟"),
  operator: z.string().min(2, "运营方名称至少 2 个字"),
  note: z.string().min(2, "计划说明至少 2 个字"),
});

const statusColor: Record<StationStatus, string> = { 封闭: "red", 限流: "orange", 恢复中: "blue", 正常: "green" };
const fmt = (value?: string) => (value ? format(new Date(value), "HH:mm:ss") : "—");
const opTypeLabel: Record<string, string> = {
  "station.status": "车站状态",
  "section.release": "区段放行",
  "plan.upsert": "新建/修改接驳计划",
  "plan.submit": "提交会签",
  "plan.sign": "岗位会签",
  "plan.execute": "执行计划",
};
const reasonColor: Record<string, string> = { 越权: "red", 缺依赖: "gold", 基线过期: "orange", 业务条件不满足: "default" };

function Workbench() {
  const t = useTranslations();
  const { message } = AntApp.useApp();
  const store = useLedgerStore();
  const [panel, setPanel] = useState<"总览" | "区段通行" | "接驳会签" | "离线处置账">("总览");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  const sections = useMemo(() => sectionViews(store), [store]);
  const plans = useMemo(() => planViews(store), [store]);
  const occupied = allocatedVehicles(store);
  const available = availableVehicles(store);

  const nameOf = (id: string) => store.stations.find((s) => s.id === id)?.name ?? id;

  const changeStation = (station: Station, status: StationStatus) => {
    if (store.role !== "车站值班员") {
      message.error(`仅车站值班员可变更车站状态（当前岗位：${store.role}），操作将被拒绝并入重试队列`);
    }
    store.setStationStatus(station.id, status, store.role === "车站值班员" ? `${station.name}现场处置：${status}` : undefined);
  };

  const release = (section: Section) => {
    if (store.role !== "调度员") {
      message.error(`仅调度员可放行区段（当前岗位：${store.role}）`);
    }
    store.releaseSection(section.id);
  };

  const openCreate = () => {
    setEditingId(null);
    form.setFieldsValue({ name: "", stationIds: ["s1"], vehicles: 4, intervalMin: 6, operator: "东城公交", note: "" });
    setModalOpen(true);
  };
  const openEdit = (planId: string) => {
    const view = plans.find((v) => v.plan.id === planId);
    if (!view) return;
    setEditingId(planId);
    form.setFieldsValue({ ...view.plan });
    setModalOpen(true);
  };

  const savePlan = () => {
    const values = form.getFieldsValue() as PlanDraft;
    const parsed = planSchema.safeParse(values);
    if (!parsed.success) {
      message.error(parsed.error.issues[0]?.message ?? "表单校验未通过");
      return;
    }
    if (parsed.data.vehicles > store.pool.total) {
      message.warning(`申请 ${parsed.data.vehicles} 辆超过车辆池总量 ${store.pool.total} 辆，可提交但会排队等待`);
    }
    if (editingId) {
      store.updatePlan(editingId, parsed.data);
      message.success(store.online ? "计划已更新，会签与占用已重算" : "已离线入账，恢复后按依赖合并");
    } else {
      store.createPlan(parsed.data);
      message.success(store.online ? "接驳计划已建立，车辆申请进入占用排队" : "已离线建账，恢复后按到达顺序占用车辆");
    }
    setModalOpen(false);
  };

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name", width: 110 },
    {
      title: "所在区段", dataIndex: "sectionIds", width: 230,
      render: (ids: string[]) => <Space size={4} wrap>{ids.map((id) => <Tag key={id}>{store.sections.find((s) => s.id === id)?.name ?? id}</Tag>)}</Space>,
    },
    { title: "状态", dataIndex: "status", width: 90, render: (v: StationStatus) => <Tag color={statusColor[v]}>{v}</Tag> },
    {
      title: "滞留风险", dataIndex: "passengerRisk", width: 90,
      render: (v) => <Badge status={v === "高" ? "error" : v === "中" ? "warning" : "success"} text={v} />,
    },
    { title: "现场说明", dataIndex: "note" },
    { title: "版本", dataIndex: "version", width: 64, render: (v) => <Tag bordered={false}>v{v}</Tag> },
    { title: "更新", dataIndex: "updatedAt", width: 86, render: fmt },
    {
      title: "现场处置（值班员）", width: 230, render: (_, record) => (
        <Space wrap>
          <Button size="small" disabled={record.status === "封闭"} danger onClick={() => changeStation(record, "封闭")}>封闭</Button>
          <Button size="small" disabled={record.status === "限流"} onClick={() => changeStation(record, "限流")}>限流</Button>
          <Button size="small" type="primary" ghost disabled={record.status === "恢复中"} onClick={() => changeStation(record, "恢复中")}>恢复中</Button>
          <Button size="small" type="primary" disabled={record.status === "正常"} onClick={() => changeStation(record, "正常")}>恢复正常</Button>
        </Space>
      ),
    },
  ];

  const sectionColumns: ColumnsType<(typeof sections)[number]> = [
    {
      title: "区段", dataIndex: ["section", "name"],
      render: (_, r) => <Space direction="vertical" size={2}><b>{r.section.name}</b><small style={{ color: "#8b95a6" }}>v{r.section.version} · {r.section.note}</small></Space>,
    },
    {
      title: "区内车站", dataIndex: "stations",
      render: (_, r) => <Space size={4} wrap>{r.stations.map((s) => <Tag key={s.id} color={statusColor[s.status]}>{s.name}·{s.status}</Tag>)}</Space>,
    },
    {
      title: "通行状态", dataIndex: ["section", "status"], width: 110,
      render: (v) => v === "放行" ? <Tag color="green">放行</Tag> : <Tag color="red">停止放行</Tag>,
    },
    {
      title: "闸门", key: "gate", width: 240,
      render: (_, r) => r.openable
        ? <Tag color="green">区内车站全部恢复，具备放行条件</Tag>
        : <Tooltip title="车站没恢复，所在区段不能放行"><Tag color="red">拦截：{r.blockedBy.join("、")}</Tag></Tooltip>,
    },
    { title: "放行时刻", dataIndex: ["section", "releasedAt"], width: 90, render: fmt },
    {
      title: "调度处置", width: 130,
      render: (_, r) => <Button size="small" type="primary" disabled={r.section.status === "放行" || !r.openable} onClick={() => release(r.section)}>
        {r.section.status === "放行" ? "已放行" : "确认放行"}
      </Button>,
    },
  ];

  const planColumns: ColumnsType<(typeof plans)[number]> = [
    {
      title: "接驳计划", render: (_, r) => (
        <Space direction="vertical" size={2}>
          <b>{r.plan.name}</b>
          <span>{r.stationNames.join(" → ")}</span>
          <small style={{ color: "#8b95a6" }}>{r.plan.operator} · 间隔 {r.plan.intervalMin} 分钟 · v{r.plan.version} · {r.plan.note}</small>
        </Space>
      ),
    },
    {
      title: "车辆占用", width: 210,
      render: (_, r) => !r.hold ? <Tag>无占用申请</Tag> : r.hold.status === "占用"
        ? <Tag color="green">已占用 {r.hold.requested} 辆</Tag>
        : r.hold.status === "排队"
          ? <Tooltip title="车辆池先到先得；队首需求未满足前后续继续排队"><Tag color="orange">排队中（序号 {r.hold.queueSeq}）· 申请 {r.hold.requested} 辆</Tag></Tooltip>
          : <Tag color={r.hold.status === "释放" ? "default" : "red"}>{r.hold.status}{r.hold.voidReason ? `：${r.hold.voidReason}` : ""}</Tag>,
    },
    {
      title: "会签", width: 210,
      render: (_, r) => <Space direction="vertical" size={2}>
        <Space size={4}>
          <Tag color={r.signedByDispatcher ? "green" : "default"}>调度员{r.signedByDispatcher ? "✓" : ""}</Tag>
          <Tag color={r.signedByShuttle ? "green" : "default"}>接驳负责人{r.signedByShuttle ? "✓" : ""}</Tag>
        </Space>
        {r.plan.voidReason && <small style={{ color: "#cf1322" }}>会签已作废：{r.plan.voidReason}</small>}
      </Space>,
    },
    {
      title: "状态", dataIndex: ["plan", "status"], width: 90,
      render: (v: string) => <Tag color={v === "已执行" ? "green" : v === "已确认" ? "cyan" : v === "待确认" ? "orange" : "default"}>{v}</Tag>,
    },
    {
      title: "处置", width: 250,
      render: (_, r) => {
        const p = r.plan;
        return <Space wrap>
          {p.status === "草稿" && <Button size="small" disabled={!r.canSubmit || store.role !== "公交接驳负责人"} onClick={() => store.submitPlan(p.id)}>提交会签</Button>}
          {p.status === "待确认" && (store.role === "调度员" || store.role === "公交接驳负责人") &&
            <Button size="small" disabled={p.countersigns.some((c) => c.role === store.role)} type="primary" ghost onClick={() => store.signPlan(p.id)}>{store.role}会签</Button>}
          {p.status === "已确认" && <Button size="small" type="primary" disabled={store.role !== "调度员"} onClick={() => store.executePlan(p.id)}>调度执行</Button>}
          {p.status !== "已执行" && store.role === "公交接驳负责人" && <Button size="small" onClick={() => openEdit(p.id)}>改车站/车辆</Button>}
        </Space>;
      },
    },
  ];

  const phaseColor: Record<string, string> = { 车站: "red", 区段: "geekblue", 接驳: "blue", 系统: "default" };

  return <div className="shell">
    <aside className="side">
      <div className="brand"><b>RAIL OPS LEDGER</b><span>积水处置账</span></div>
      <nav>{(["总览", "区段通行", "接驳会签", "离线处置账"] as const).map((item) => <button key={item} className={panel === item ? "active" : ""} onClick={() => setPanel(item)}>{item}</button>)}</nav>
      <div className="side-status">
        <small>网络状态</small>
        <b className={store.online ? "ok" : "warn"}>{store.online ? "在线" : "断网降级 · 离线续作"}</b>
        <span>上次同步 {store.lastSyncAt ? fmt(store.lastSyncAt) : "本次会话"}</span>
        <span>发件箱 {store.outbox.length} · 重试队列 {store.retryQueue.length}</span>
      </div>
    </aside>

    <main>
      <header>
        <div>
          <small>{store.incident.id} · 启动于 {format(new Date(store.incident.startedAt), "MM-dd HH:mm")}</small>
          <h1>{t("title")}</h1>
          <p>{t("subtitle")} · {store.incident.title}</p>
        </div>
        <Space>
          <Segmented value={store.online} onChange={(v) => store.setOnline(Boolean(v))} options={[{ label: "在线", value: true }, { label: "断网", value: false }]} />
          <Select<Role> value={store.role} onChange={store.setRole} style={{ width: 170 }} options={ROLES.map((r) => ({ value: r, label: `岗位：${r}` }))} />
          <Button size="small" danger ghost onClick={() => { store.resetAll(); message.success("已重置为初始处置账"); }}>重置演练</Button>
        </Space>
      </header>

      <Row gutter={14} style={{ marginBottom: 16 }}>
        <Col span={4}><Card><Statistic title="未恢复车站" value={store.stations.filter((s) => !isStationRecovered(s)).length} suffix={`/ ${store.stations.length} 座`} /></Card></Col>
        <Col span={4}><Card><Statistic title="放行区段" value={store.sections.filter((s) => s.status === "放行").length} suffix={`/ ${store.sections.length}`} /></Card></Col>
        <Col span={5}><Card title={<span style={{ fontSize: 13 }}>车辆池占用</span>} size="small"><Progress percent={Math.round((occupied / store.pool.total) * 100)} format={() => `${occupied}/${store.pool.total} 辆`} size="small" /><small style={{ color: "#59667b" }}>可用 {available} 辆 · 排队 {store.holds.filter((h) => h.status === "排队").length} 笔</small></Card></Col>
        <Col span={4}><Card><Statistic title="待双岗会签" value={plans.filter((p) => p.plan.status === "待确认").length} /></Card></Col>
        <Col span={4}><Card><Statistic title="待同步 / 重试" value={store.outbox.length + store.retryQueue.length} valueStyle={{ color: store.outbox.length + store.retryQueue.length ? "#cf1322" : undefined }} /></Card></Col>
        <Col span={3}><Card><Statistic title="账本版本" value={store.version} /></Card></Col>
      </Row>

      {!store.online && <Alert style={{ marginBottom: 14 }} type="warning" showIcon
        message="断网降级：操作照常在本地入账续作，每条操作带岗位、基线版本和依赖"
        description="恢复联网后发件箱将按依赖合并，同一操作号只生效一次；越权、缺依赖、基线过期或条件不满足的操作留在重试队列。" />}
      {store.online && store.retryQueue.length > 0 && <Alert style={{ marginBottom: 14 }} type="error" showIcon
        message={`有 ${store.retryQueue.length} 条操作停留在重试队列`}
        description={<Space wrap>{store.retryQueue.map((q) => <Tag key={q.op.opId} color={reasonColor[q.reason]}>{opTypeLabel[q.op.type]} · {q.reason}（第 {q.attempts} 次）</Tag>)}</Space>}
        action={<Space direction="vertical"><Button size="small" type="primary" onClick={store.retryQueued}>按当前账重试</Button><Button size="small" onClick={() => store.retryQueue.forEach((q) => store.discardQueued(q.op.opId))}>全部放弃</Button></Space>} />}

      {panel === "总览" && <Row gutter={14}>
        <Col span={15}><Card title="车站状态（值班员账）" extra={<small>未恢复车站经过的区段一律不能放行</small>}>
          <Table rowKey="id" columns={stationColumns} dataSource={store.stations} pagination={false} size="small" scroll={{ x: 900 }} />
        </Card></Col>
        <Col span={9}><Card title="态势图" className="map-card"><MapPanel stations={store.stations} sections={store.sections} plans={store.plans.filter((p) => p.status !== "草稿")} /></Card></Col>
      </Row>}

      {panel === "区段通行" && <Card title="区段通行（调度员账）" extra={<small>放行闸门：区段内所有车站恢复（正常）后，调度员方可确认放行</small>}>
        <Table rowKey={(r) => r.section.id} columns={sectionColumns} dataSource={sections} pagination={false} size="small" />
      </Card>}

      {panel === "接驳会签" && <Card title="公交接驳计划与双岗会签" extra={<Button type="primary" disabled={store.role !== "公交接驳负责人"} onClick={openCreate}>新建接驳计划</Button>}>
        <Table rowKey={(r) => r.plan.id} columns={planColumns} dataSource={plans} pagination={false} size="small" />
      </Card>}

      {panel === "离线处置账" && <Row gutter={14}>
        <Col span={14}>
          <Card title="处置流水（合并后事件序）" size="small" style={{ marginBottom: 14 }}>
            <Timeline items={store.events.map((e) => ({ color: phaseColor[e.phase] ?? "gray", children: <div><Space size={6}><Tag color={phaseColor[e.phase]}>{e.phase}</Tag><b>{e.role}</b>{e.opId && <Typography.Text code style={{ fontSize: 11 }}>{e.opId.slice(-8)}</Typography.Text>}</Space><p style={{ margin: "3px 0" }}>{e.text}</p><small>{format(new Date(e.time), "MM-dd HH:mm:ss.SSS")}</small></div> }))} />
          </Card>
        </Col>
        <Col span={10}>
          <Card title={`发件箱（${store.outbox.length}）`} size="small" style={{ marginBottom: 14 }}>
            {store.outbox.length === 0 ? <small>无待同步操作</small> : <Timeline items={store.outbox.map((op) => ({ children: <div><b>{opTypeLabel[op.type]}</b><Tag>{op.role}</Tag><p style={{ margin: "2px 0" }}><Typography.Text code style={{ fontSize: 11 }}>{op.opId}</Typography.Text></p><small>基线 v{op.baseVersion}{op.dependsOn?.length ? ` · 依赖 ${op.dependsOn.map((d) => d.slice(-6)).join("、")}` : " · 无依赖"} · {fmt(op.at)}</small></div> }))} />}
            {store.online && store.outbox.length > 0 && <Button size="small" type="primary" block onClick={() => store.setOnline(true)}>立即合并</Button>}
          </Card>
          <Card title={`重试队列（${store.retryQueue.length}）`} size="small" style={{ marginBottom: 14 }}>
            {store.retryQueue.length === 0 ? <small>队列已清空</small> : store.retryQueue.map((q) => <Card key={q.op.opId} size="small" style={{ marginBottom: 8 }} styles={{ body: { padding: 10 } }}>
              <Space style={{ justifyContent: "space-between", width: "100%" }}>
                <b>{opTypeLabel[q.op.type]}</b>
                <Tag color={reasonColor[q.reason]}>{q.reason}</Tag>
              </Space>
              <p style={{ margin: "6px 0", fontSize: 12 }}>{q.detail}</p>
              <small><Typography.Text code style={{ fontSize: 11 }}>{q.op.opId}</Typography.Text> · {q.op.role} · 已尝试 {q.attempts} 次</small>
              <Space style={{ marginTop: 6 }}><Button size="small" type="primary" ghost onClick={store.retryQueued}>重试全部</Button><Button size="small" danger ghost onClick={() => store.discardQueued(q.op.opId)}>放弃</Button></Space>
            </Card>)}
          </Card>
          <Card title="已作废操作号" size="small">
            {store.voidedOpIds.length === 0 ? <small>暂无</small> : <Space wrap>{store.voidedOpIds.map((v) => <Tooltip key={v.opId} title={v.reason}><Tag color="red"><Typography.Text code style={{ fontSize: 11 }}>{v.opId.slice(-10)}</Typography.Text></Tag></Tooltip>)}</Space>}
          </Card>
        </Col>
      </Row>}

      <Modal title={editingId ? "修改接驳计划（车站/车辆数变化将作废重算）" : "新建接驳计划"} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={savePlan} okText={store.online ? "保存并占车" : "离线保存"} destroyOnHidden>
        <Form form={form} layout="vertical" initialValues={{ stationIds: ["s1"], vehicles: 4, intervalMin: 6, operator: "东城公交" }}>
          <Form.Item label="计划名称" name="name"><Input placeholder="如：滨江西线接驳" /></Form.Item>
          <Form.Item label="接驳车站（改车站会作废会签与占用）" name="stationIds"><Select mode="multiple" options={store.stations.map((s) => ({ value: s.id, label: `${s.name}（${s.status}）` }))} /></Form.Item>
          <Space>
            <Form.Item label="车辆数（改数量会作废重算）" name="vehicles"><InputNumber min={1} max={store.pool.total * 2} addonAfter="辆" /></Form.Item>
            <Form.Item label="发车间隔" name="intervalMin"><InputNumber min={2} max={60} addonAfter="分钟" /></Form.Item>
            <Form.Item label="运营方" name="operator"><Input /></Form.Item>
          </Space>
          <Form.Item label="计划说明" name="note"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </main>
  </div>;
}

export default function Page() {
  return <AntApp><Workbench /></AntApp>;
}
