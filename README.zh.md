# dsh-plugin-dpom-apm

[English](README.md) | 中文

DeepSeek Harness（DSH）插件：把 [DPOMBaseMCPServer](https://github.com/xinqihuang/DPOMBaseMCPServer) 的华为云 APM/CES 诊断能力接入 DSH 智能体，并修掉直接使用该 MCP Server 时最痛的几个问题。

## 解决什么问题

直接把 DPOMBaseMCPServer 挂给智能体时，实测有四个坑：

| 坑 | 本插件的做法 |
|---|---|
| **businessId / envId 不知道怎么填** | `dpom_apm_resolve_context` 从告警名 / SMN 主题自动解析（如 `SmartPVMS_critical_alarm` → business `smartpvms` → 最活跃 env），带缓存，结果附带用法说明 |
| **入参命名不一致**：spec 文档是 snake_case（`business_id`），MCP schema 实际是 camelCase（`businessId`），传错被静默忽略后报误导性的上游错误 | `dpom_apm_call` 自动把 snake_case 键归一化为 camelCase，并按白名单自动注入 businessId / region |
| **region 语义陷阱**：`search_apm_application` 的 region 是资源所在 region（如 cn-north-9），不是 APM 端点 region（cn-north-4），传错返回 0 个应用且不报错 | 配置里显式区分 `resourceRegion`，注入时只用资源 region |
| **诊断证据散落各处**，无法交给下游服务复核 | `dpom_apm_diagnose_alarm` 一次调用产出**可回放证据链**（[schema](schema/evidence-chain.schema.json)），每步记录工具、入参、原始数据，findings 按索引引用证据 |

## 提供的工具

- **`dpom_apm_resolve_context`** — 解析 businessId/envId（输入：businessId / businessName / alarmName / smnTopic 任一；支持 `businessAliases` 配置中文告警名 → business 名映射）
- **`dpom_apm_call`** — 调用任意 DPOMBaseMCPServer MCP 工具（入参自动归一化 + businessId/region 自动注入）
- **`dpom_apm_diagnose_alarm`** — 一键诊断：CES 告警 → business 解析 → APM 告警 → 慢/错 trace 窗口对比 → 慢接口排名 → 最慢 trace 分型分析（SQL / Redis / HTTP 下游 / Kafka）→ **资源指标动态发现**（`list_ces_metrics` 实时发现该资源的真实指标并按诊断相关性打分，自动覆盖全部 CES namespace）→ AOM 基础设施事件 → 规则化 findings + 证据链；`outputPath` 可落盘完整证据链 JSON

### 告警类型覆盖（v0.2.0 实测）

| 告警类型 | business 解析 | 资源指标 | 实测结果 |
|---|---|---|---|
| SYS.RDS（数据库） | 告警名/SMN token | 发现 88 个指标，CPU/QPS/TPS/慢查询全取 | 6 findings（含非 sargable SQL 根因） |
| SYS.DCS（Redis） | 同上 | 按维度发现 | 慢调用 3.0x finding |
| SYS.DMS（Kafka） | 同上 | broker 维度 + 告警指标兜底 | JettyClient 慢调用分型 + broker CPU + FailedDelete 事件 findings |
| AGT.ECS（主机） | DMaaS token | 不在 CES 工具枚举内 → 优雅降级 | business 解析 + trace 分析正常 |
| SYS.ELB 等 | 需 `businessAliases`（中文名无英文 token） | 动态发现 | — |

## 安装

DSH 的插件管理器支持直接从 GitHub 安装组合包：

```yaml
# 在 DSH 的 plugin_manager / plugin_market 工具中：
target: https://github.com/xinqihuang/dsh-plugin-dpom-apm.git
```

前提：本机已运行 DPOMBaseMCPServer（默认 `http://127.0.0.1:8080`，SSE 端点 `/sse`）。

## 配置（cordis.patch.yml）

```yaml
- id: dpom-apm
  name: dsh-plugin-dpom-apm
  config:
    serverUrl: http://127.0.0.1:8080   # DPOMBaseMCPServer 地址
    resourceRegion: cn-north-9          # 被监控资源所在 region（不是 APM 端点 region）
    defaultBusinessId: null            # 可选：默认 businessId
    requestTimeoutMs: 120000
    discoveryCacheTtlMs: 3600000       # business/app 发现缓存 TTL
```

## 证据链格式

诊断输出遵循 [schema/evidence-chain.schema.json](schema/evidence-chain.schema.json)（`dpom-evidence-chain/1.0`）：

- `evidence[]` — 每步：kind（ces_alarm / trace_stats / trace_sql / resource_metrics…）、tool、query（原始入参）、summary、data（原始数据）
- `findings[]` — 规则化结论，`evidenceRefs` 按索引引用证据步
- `conclusion` — 根因 + 置信度 + 建议
- `provenance` — MCP server、生成时间、生成器

真实样例见 [examples/evidence-chain-smartpvms-rds-cpu-2026-11-10.json](examples/evidence-chain-smartpvms-rds-cpu-2026-11-10.json)（智能光伏 RDS CPU 告警诊断）。

下游"代码诊断服务"只需要：读 `evidence[].data` 复核每一步、按 `findings[].evidenceRefs` 挑战结论，无需访问原 MCP Server。

## 设计决策

- **零运行时依赖**：只用宿主进程的 global fetch；不 import 任何 `@deepseek-ai/*` 包，因此安装时不会被 peer 解析问题卡住
- **纯 ESM JavaScript（`lib/*.js`）**：无构建步骤，装完即用
- **businessId 注入走白名单**：MCP 工具 schema 多为 `additionalProperties: false`，向不接受 businessId 的工具注入会被校验拒绝；白名单按真实 `tools/list` schema 核对
- **诊断结论是规则化的**（非 LLM 生成）：证据链必须可审计，结论必须可从数据推导

## License

MIT
