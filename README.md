# dsh-plugin-dpom-apm

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin that wires the Huawei Cloud APM/CES diagnostics of [DPOMBaseMCPServer](https://github.com/xinqihuang/DPOMBaseMCPServer) into DSH agents — and fixes the traps you hit when driving that MCP server raw.

## Problems it solves

| Trap (measured against the live server) | What the plugin does |
|---|---|
| **businessId / envId are unclear** | `dpom_apm_resolve_context` resolves them from an alarm name / SMN topic (`SmartPVMS_critical_alarm` -> business `smartpvms` -> most active env), cached, with usage hints |
| **Argument naming mismatch**: specs say snake_case (`business_id`), the MCP schemas are camelCase (`businessId`); wrong keys are silently dropped, then a misleading upstream error appears | `dpom_apm_call` normalizes snake_case keys to camelCase and auto-injects businessId / region via a verified whitelist |
| **region semantics**: `search_apm_application`'s region is the RESOURCE region (cn-north-9), not the APM endpoint region (cn-north-4); the wrong one returns zero apps, silently | `resourceRegion` is an explicit config field and only the resource region is injected |
| **Diagnosis evidence is scattered** | `dpom_apm_diagnose_alarm` emits a **replayable evidence chain** ([schema](schema/evidence-chain.schema.json)): every step records tool + arguments + raw data; findings reference evidence by index |

## Tools

- **`dpom_apm_resolve_context`** — resolve businessId/envId from businessId / businessName / alarmName / smnTopic
- **`dpom_apm_call`** — call any DPOMBaseMCPServer MCP tool with argument normalization and auto-injection
- **`dpom_apm_diagnose_alarm`** — one-shot diagnosis: CES alarm -> business -> APM alarms -> slow/error trace window-vs-baseline -> slow endpoint ranking -> worst trace SQL extraction with anti-pattern detection -> resource CES metrics -> rule-based findings + evidence chain; `outputPath` writes the full chain JSON

## Install

```yaml
# DSH plugin_manager / plugin_market target:
target: https://github.com/xinqihuang/dsh-plugin-dpom-apm.git
```

Requires DPOMBaseMCPServer running (default `http://127.0.0.1:8080`, SSE at `/sse`).

## Configuration (cordis.patch.yml)

```yaml
- id: dpom-apm
  name: dsh-plugin-dpom-apm
  config:
    serverUrl: http://127.0.0.1:8080   # DPOMBaseMCPServer base URL
    resourceRegion: cn-north-9          # region where monitored resources live (NOT the APM endpoint region)
    defaultBusinessId: null            # optional default businessId
    requestTimeoutMs: 120000
    discoveryCacheTtlMs: 3600000
```

## Evidence chain format

Diagnosis output follows [schema/evidence-chain.schema.json](schema/evidence-chain.schema.json) (`dpom-evidence-chain/1.0`): ordered `evidence[]` steps (kind, tool, query, summary, raw data), `findings[]` referencing steps by index, a rule-based `conclusion`, and `provenance`. A real sample: [examples/evidence-chain-smartpvms-rds-cpu-2026-11-10.json](examples/evidence-chain-smartpvms-rds-cpu-2026-11-10.json).

A downstream code-diagnosis service audits `evidence[].data` and challenges `findings` via `evidenceRefs` — no access to the original MCP server needed.

## Design decisions

- **Zero runtime dependencies**: global fetch only; no `@deepseek-ai/*` imports, so installation never trips over peer resolution
- **Plain ESM JavaScript (`lib/*.js`)**: no build step
- **Whitelist-based businessId injection**: MCP tool schemas are mostly `additionalProperties: false`; injecting businessId into a tool that does not accept it fails validation — the whitelist is verified against the live `tools/list`
- **Rule-based conclusions** (not LLM-generated): the chain must stay auditable

## License

MIT
