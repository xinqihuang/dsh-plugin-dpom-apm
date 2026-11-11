# 证据链格式（dpom-evidence-chain/1.0）

> 权威 schema：[`schema/evidence-chain.schema.json`](../schema/evidence-chain.schema.json)
> 真实样例：[`examples/evidence-chain-smartpvms-rds-cpu-2026-11-10.json`](../examples/evidence-chain-smartpvms-rds-cpu-2026-11-10.json)

## 设计目标

一次跨组件诊断（CES 告警 → APM business → trace → SQL → 资源指标）产生的所有观察，
必须打包成**可回放、可审计**的单一 JSON 文档，让下游"代码诊断服务"在**不访问原 MCP Server**
的前提下能够：

1. **审计每一步**——哪个工具、什么入参、返回了什么原始数据；
2. **挑战每个结论**——findings 按索引引用证据步，可从原始数据重新推导；
3. **机器处理**——结构固定、类型明确、无自由文本依赖（summary 仅供人读）。

## 顶层结构

```
{
  "schema":        "dpom-evidence-chain/1.0",     // 格式标识 + 版本
  "incident":      { title, severity, status, detectedAt, recoveredAt },
  "context":       { source, resource, business, environments, timeWindow },
  "evidence":      [ ...有序证据步... ],
  "findings":      [ ...规则化发现，引用 evidence 下标... ],
  "conclusion":    { rootCause, confidence, recommendations },
  "provenance":    { mcpServer, generatedAt, generator }
}
```

## evidence[]（证据步）

每步固定六字段：

| 字段 | 含义 |
|---|---|
| `step` | 1 起始的步序号，findings 引用它 |
| `kind` | 机器可读类型，见下表 |
| `tool` | 产生数据的 MCP 工具名（或工具链描述） |
| `query` | 该工具收到的**原始入参**（可原样重放） |
| `summary` | 一句话人读摘要 |
| `data` | 原始工具结果（紧凑输出时数组截断，尾部有 `{ "trimmed": N }` 标记） |

标准 kind 序列（`dpom_apm_diagnose_alarm` 的固定产出顺序）：

| kind | 内容 |
|---|---|
| `ces_alarm` | CES 告警历史与目标告警（含维度、SMN 主题、数据点） |
| `apm_business_resolution` | businessId 解析：别名 → 告警名/SMN token → business |
| `apm_alarm` | 窗口附近的 APM 应用层告警 |
| `trace_stats` | 告警窗 vs 双基线窗的错误/慢调用计数 |
| `slow_endpoint_ranking` | 慢接口排名（按累计耗时） |
| `trace_sql` | 最慢 trace 的事件序列 + 分型（Mysql SQL / Redis / HTTP 下游 / Kafka）+ SQL 反模式分析 |
| `resource_metric_discovery` | `list_ces_metrics` 实时发现该资源可用指标（多维度重试），供指标步打分选型 |
| `resource_metrics` | 资源 CES 指标分钟级序列（告警指标 + 发现的 CPU/吞吐/慢查询/连接类指标） |
| `aom_events` | 窗口内 AOM 基础设施事件（CronJob/OOM/FailedDelete 等），按事件名聚合 |

## findings[]（发现）

```json
{ "id": "F1", "statement": "慢调用(>3s)在告警窗上升 3.0 倍", "evidenceRefs": [4], "severity": "high" }
```

- `evidenceRefs` 必须指向存在的 step 下标（schema 强制 ≥1）；
- 结论是**规则推导**的，不是 LLM 生成的——每条 finding 都能从其引用的证据数据复算。

## 时间窗语义

- `timeWindow.alarm`：[触发时间, 恢复时间]（告警未恢复时为查询窗末）；
- `timeWindow.baseline`：紧贴告警窗前的等长窗口；
- `timeWindow.baseline2`：再往前一个等长窗口；
- **判定参照 = min(baseline, baseline2)**：防止告警前的爬坡期污染基线
  （实战案例：15:15 起慢查询爬坡，紧贴基线被污染，第二基线才干净）。

## 时间格式约定

- 人读时间：`yyyy-MM-dd HH:mm:ss`，宿主机本地时区；
- `provenance.generatedAt`：ISO-8601 UTC；
- CES 毫秒时间戳原样保留在 `data` 中。

## 下游消费建议（给代码诊断服务）

1. 校验 `schema` 字段确认版本；
2. 遍历 `evidence[]`，按 `kind` 分派处理器；
3. 对每条 `finding`，取 `evidenceRefs` 指向的 `data` 复算判据（如倍率、峰值、占比）；
4. 结合 `conclusion.recommendations` 生成自己的独立结论——**不要盲信** `conclusion`，
   它是规则化的起点，不是终点。
