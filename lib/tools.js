/**
 * Agent tool registrations: the three tools this plugin contributes.
 *
 *   dpom_apm_resolve_context  - businessId/envId auto-resolution (the pain point)
 *   dpom_apm_call              - call any DPOMBaseMCPServer tool with argument
 *                                normalization (snake_case -> camelCase) and
 *                                businessId/region auto-injection
 *   dpom_apm_diagnose_alarm    - one-shot CES-alarm -> APM diagnosis that
 *                                emits a replayable evidence chain document
 *
 * Tool definitions are plain JSON-Schema objects; they do not need the
 * @deepseek-ai/dsh-tools defineTool wrapper, which is a convenience layer
 * over the same shape ctx.tools.register accepts.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { ApmDiscovery, extractBusinessTokens } from "./discovery.js";
import { EvidenceChainBuilder, EVIDENCE_CHAIN_SCHEMA_VERSION, trimForCompact, analyzeSqlPattern } from "./evidence.js";

const GENERATOR = "dsh-plugin-dpom-apm/0.2.0";

/** Convert a snake_case argument key to the camelCase the MCP schemas use. */
function snakeToCamel(key) {
  return key.replace(/_([a-z0-9])/gu, (_, ch) => ch.toUpperCase());
}

/** Normalize whole argument objects: snake_case keys -> camelCase keys. */
export function normalizeArguments(args) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

/**
 * MCP tools that accept a businessId argument (verified against the live
 * tools/list schemas). Tools outside this set must NOT receive businessId:
 * their schemas are additionalProperties:false and would reject it.
 */
const BUSINESS_ID_TOOLS = new Set([
  "query_traces",
  "list_apm_alarm_data",
  "search_apm_application",
  "show_env_monitor_items",
  "show_apm_monitor_item_view_config",
  "show_apm_trend",
  "show_clob_detail",
]);

/**
 * MCP tools whose "region" argument means the RESOURCE region (where the
 * monitored resources run), not the APM endpoint region.
 */
const REGION_TOOLS = new Set([
  "query_traces",
  "list_apm_alarm_data",
  "search_apm_application",
]);

/** Parse "yyyy-MM-dd HH:mm:ss" (host-local time) into epoch millis. */
export function parseLocalTime(text) {
  const normalized = String(text).trim().replace(" ", "T");
  const ms = new Date(normalized).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`dpom-apm: invalid time "${text}"; use yyyy-MM-dd HH:mm:ss`);
  }
  return ms;
}

/** Format epoch millis back to "yyyy-MM-dd HH:mm:ss" host-local time. */
export function formatLocalTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** CES metrics worth pulling for a namespace during diagnosis. */
const NAMESPACE_METRICS = {
  "SYS.RDS": ["rds001_cpu_util", "rds074_slow_queries", "rds006_conn_count", "rds008_qps"],
  "SYS.ECS": ["cpu_util", "mem_usedPercent"],
};

/**
 * Register all three tools. Each register call returns a disposer that the
 * cordis fiber collects when the plugin unmounts.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context carrying ctx.tools
 * @param {import("./mcp-client.js").DpomMcpClient} client
 * @param {object} config - resolved plugin config
 */
export function registerTools(ctx, client, config) {
  const discovery = new ApmDiscovery(client, config);
  ctx.tools.register(buildResolveContextTool(client, discovery, config));
  ctx.tools.register(buildCallTool(client, discovery, config));
  ctx.tools.register(buildDiagnoseTool(client, discovery, config));
}

function buildResolveContextTool(client, discovery, config) {
  return {
    name: "dpom_apm_resolve_context",
    description:
      "Resolve the APM businessId and envId for a Huawei Cloud application from any of: an explicit id, " +
      "a business name, or a CES alarm name / SMN topic (e.g. 'SmartPVMS_critical_alarm' -> business " +
      "'smartpvms'). Returns the business, its applications, and the environment with the most online " +
      "probes. Use this BEFORE any other DPOM APM tool call instead of guessing businessId/envId values.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        businessId: { type: "integer", description: "APM business id, if already known." },
        businessName: { type: "string", description: "APM business name, e.g. 'smartpvms'." },
        alarmName: { type: "string", description: "CES alarm rule name to extract the business from, e.g. 'P2风险告警-智能光伏-RDS-CPU使用率-0400_11'." },
        smnTopic: { type: "string", description: "SMN notification topic name, e.g. 'SmartPVMS_critical_alarm'." },
        envName: { type: "string", description: "Exact environment name to prefer, e.g. 'pvms01-digi_power_cloud-smartpvms'." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          business: { type: "object" },
          applications: { type: "array" },
          environments: { type: "array" },
          resolvedEnv: { type: "object" },
          usage: { type: "object" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            `Resolved APM context: business ${value.business?.name ?? "?"} (businessId=${value.business?.businessId ?? "?"}) ` +
            `via ${value.business?.matchMethod ?? "?"}; ${value.applications?.length ?? 0} app instances, ` +
            `${value.environments?.length ?? 0} environments; recommended env ${value.resolvedEnv?.envName ?? "?"} (envId=${value.resolvedEnv?.envId ?? "?"}).`,
        },
      ],
    },
    async execute(args) {
      const business = await discovery.resolveBusiness({
        businessId: args.businessId,
        businessName: args.businessName,
        alarmName: args.alarmName,
        smnTopics: args.smnTopic ? [args.smnTopic] : [],
      });
      if (business === null) {
        const all = await discovery.listBusinesses();
        return {
          error: "business-not-resolved",
          hint: "Pass businessName or smnTopic. Known businesses: " + all.map((b) => `${b.name}(${b.id})`).join(", "),
        };
      }
      const apps = await discovery.listApps(business.businessId);
      const environments = [];
      for (const app of apps) {
        if (!environments.some((e) => e.envId === app.envId)) {
          environments.push({ envId: app.envId, envName: app.envName, onlineCount: app.onlineCount });
        }
      }
      environments.sort((a, b) => b.onlineCount - a.onlineCount);
      const resolvedEnv = await discovery.resolveEnv(business.businessId, args.envName);
      return {
        business,
        applications: apps.slice(0, 30),
        environments,
        resolvedEnv,
        usage: {
          businessId: business.businessId,
          envId: resolvedEnv?.envId ?? null,
          resourceRegion: config.resourceRegion,
          note: "Pass these values (or just businessName) to dpom_apm_call / dpom_apm_diagnose_alarm.",
        },
      };
    },
  };
}

function buildCallTool(client, discovery, config) {
  return {
    name: "dpom_apm_call",
    description:
      "Call any DPOMBaseMCPServer MCP tool (list_apm_alarm_data, query_traces, show_env_monitor_items, " +
      "show_apm_monitor_item_view_config, show_apm_trend, show_trace_events, get_service_topology, " +
      "list_alarms, query_ces_metric_data, ...). Arguments accept snake_case OR camelCase keys " +
      "(business_id and businessId both work). businessId and resource region are injected automatically " +
      "when omitted and a default is known. Respect the discovery chain: show_env_monitor_items -> " +
      "show_apm_monitor_item_view_config -> show_apm_trend; never invent collector_id or metric_set.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["tool"],
      properties: {
        tool: { type: "string", description: "MCP tool name, e.g. 'query_traces'." },
        arguments: {
          type: "object",
          additionalProperties: true,
          description: "Tool arguments; snake_case keys are converted to the camelCase the MCP schema expects.",
        },
        businessId: { type: "integer", description: "Default businessId injected when the tool accepts one and the arguments omit it." },
        resourceRegion: { type: "string", description: "Default resource region injected when the tool accepts one and the arguments omit it." },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [
        { type: "text", text: `dpom_apm_call(${args.tool}) returned ${JSON.stringify(value).length} bytes.` },
      ],
    },
    async execute(args) {
      const normalized = normalizeArguments(args.arguments);
      const businessId = args.businessId ?? config.defaultBusinessId ?? null;
      if (businessId !== null && normalized.businessId === undefined && BUSINESS_ID_TOOLS.has(args.tool)) {
        normalized.businessId = businessId;
      }
      const region = args.resourceRegion ?? config.resourceRegion;
      if (normalized.region === undefined && REGION_TOOLS.has(args.tool)) {
        normalized.region = region;
      }
      return await client.callTool(args.tool, normalized);
    },
  };
}

function buildDiagnoseTool(client, discovery, config) {
  return {
    name: "dpom_apm_diagnose_alarm",
    description:
      "One-shot cross-component diagnosis of a CES alarm: finds the CES alarm history, resolves the owning " +
      "APM business (from the alarm name / SMN topic), then collects APM alarms, error/slow-trace counts " +
      "(alarm window vs. baseline), the dominant slow endpoints, the worst trace's SQL, and the resource's " +
      "key CES metrics. Returns a compact evidence chain plus rule-based findings. Pass outputPath (absolute) " +
      "to also write the FULL evidence chain JSON for handing to a code-diagnosis service.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        namespace: { type: "string", description: "CES namespace to search, e.g. 'SYS.RDS'. Default: SYS.RDS." },
        alarmName: { type: "string", description: "Substring of the CES alarm rule name to target; the most severe recent alarm is used when omitted." },
        fromTime: { type: "string", description: "Search window start, 'yyyy-MM-dd HH:mm:ss' host-local. Default: 24h before toTime." },
        toTime: { type: "string", description: "Search window end, host-local. Default: now." },
        businessId: { type: "integer", description: "APM business id, when already known." },
        businessName: { type: "string", description: "APM business name, when known." },
        smnTopic: { type: "string", description: "SMN topic carrying the alarm, e.g. 'SmartPVMS_critical_alarm'." },
        outputPath: { type: "string", description: "Optional absolute file path for the full evidence chain JSON." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          summary: { type: "object" },
          chain: { type: "object" },
          outputPath: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `Diagnosis ${value.summary?.incident ?? ""}: ${value.summary?.rootCause ?? "no conclusion"}`,
        },
      ],
    },
    async execute(args) {
      return await diagnoseAlarm({ client, discovery, config, params: args });
    },
  };
}

/**
 * The full diagnosis workflow. Every MCP call is recorded as one evidence
 * step; findings reference steps by index; the conclusion is rule-based.
 *
 * @param {object} input
 * @param {import("./mcp-client.js").DpomMcpClient} input.client
 * @param {ApmDiscovery} input.discovery
 * @param {object} input.config
 * @param {object} input.params - tool arguments
 */
export async function diagnoseAlarm({ client, discovery, config, params }) {
  const namespace = params.namespace ?? "SYS.RDS";
  const toMs = params.toTime ? parseLocalTime(params.toTime) : Date.now();
  const fromMs = params.fromTime ? parseLocalTime(params.fromTime) : toMs - 24 * 3600 * 1000;
  const chain = new EvidenceChainBuilder();
  const findings = [];

  // ---- Step 1: CES alarm history ----
  const alarmList = await client.callTool("list_alarms", {
    namespace,
    from: String(fromMs),
    to: String(toMs),
    limit: 100,
  });
  const alarms = alarmList.alarms ?? [];
  let target = null;
  if (params.alarmName) {
    target = alarms.find((a) => String(a.alarmName ?? "").includes(params.alarmName)) ?? null;
  }
  if (target === null && alarms.length > 0) {
    target = [...alarms].sort((a, b) => (a.alarmLevel ?? 9) - (b.alarmLevel ?? 9) || (b.triggerTime ?? 0) - (a.triggerTime ?? 0))[0];
  }
  chain.add({
    kind: "ces_alarm",
    tool: "list_alarms",
    query: { namespace, from: String(fromMs), to: String(toMs), limit: 100 },
    summary: alarms.length === 0
      ? `No ${namespace} alarms in the search window.`
      : `${alarms.length} ${namespace} alarm(s) in the search window; targeting "${target.alarmName}" (level ${target.alarmLevel}, ${target.alarmStatus}).`,
    data: { total: alarmList.total ?? alarms.length, alarms: alarms.slice(0, 10) },
  });
  if (target === null) {
    return finish({ chain, findings, incident: { title: `No ${namespace} alarms found`, severity: "none", status: "no-alarm", detectedAt: formatLocalTime(fromMs), recoveredAt: formatLocalTime(toMs) }, context: { source: "ces", namespace, timeWindow: { from: formatLocalTime(fromMs), to: formatLocalTime(toMs) } }, config, params, client, conclusion: { rootCause: "No CES alarm matched the query; nothing to diagnose.", confidence: "high", recommendations: ["Widen the time window or check the namespace."] } });
  }

  // ---- Step 2: alarm window + resource ----
  const windowStart = target.triggerTime ?? fromMs;
  const windowEnd = target.alarmRecoveryTime ? target.alarmRecoveryTime * 1000 : (target.updateTime ?? toMs);
  const windowMs = Math.max(windowEnd - windowStart, 60 * 1000);
  const baselineStart = windowStart - windowMs;
  const baselineEnd = windowStart;
  const dimensions = target.metric?.dimensions ?? [];
  const resourceId = dimensions[0]?.value ?? null;
  const smnTopics = (target.alarmActions ?? []).flatMap((action) => action.notificationList ?? [])
    .map((urn) => String(urn).split(":").pop());

  // ---- Step 3: resolve APM business ----
  const business = await discovery.resolveBusiness({
    businessId: params.businessId,
    businessName: params.businessName,
    alarmName: target.alarmName,
    smnTopics,
  });
  chain.add({
    kind: "apm_business_resolution",
    tool: "list_apm_business (+ token match)",
    query: { alarmName: target.alarmName, smnTopics, businessName: params.businessName ?? null },
    summary: business === null
      ? "Could not resolve an APM business from the alarm; pass businessName explicitly."
      : `Alarm maps to APM business "${business.name}" (businessId=${business.businessId}) via ${business.matchMethod}.`,
    data: { resolved: business, tokens: extractBusinessTokens({ alarmName: target.alarmName, smnTopics }) },
  });

  const apps = business ? await discovery.listApps(business.businessId) : [];
  const environments = [];
  for (const app of apps) {
    if (!environments.some((e) => e.envId === app.envId)) {
      environments.push({ envId: app.envId, envName: app.envName, onlineCount: app.onlineCount });
    }
  }
  environments.sort((a, b) => b.onlineCount - a.onlineCount);

  // ---- Step 4: APM application alarms near the window ----
  let apmAlarms = [];
  if (business) {
    const apmAlarmResp = await client.callTool("list_apm_alarm_data", {
      businessId: business.businessId,
      page: 1,
      pageSize: 100,
    });
    apmAlarms = (apmAlarmResp.alarms ?? []).filter((a) => {
      const t = Date.parse(String(a.alarmFirstTime ?? "").replace(" ", "T") + "+08:00");
      return Number.isFinite(t) ? t >= baselineStart && t <= windowEnd + 3600 * 1000 : true;
    });
    chain.add({
      kind: "apm_alarm",
      tool: "list_apm_alarm_data",
      query: { businessId: business.businessId, page: 1, pageSize: 100 },
      summary: `${apmAlarms.length} APM alarm(s) for business ${business.businessId} overlapping [baseline, window].`,
      data: { alarms: apmAlarms.slice(0, 10) },
    });
  }

  // ---- Step 5: trace counts, window vs baseline ----
  const countTraces = async (start, end, extra) => {
    const resp = await client.callTool("query_traces", {
      businessId: business.businessId,
      region: config.resourceRegion,
      startTimeString: formatLocalTime(start),
      endTimeString: formatLocalTime(end),
      page: 1,
      pageSize: 1,
      ...extra,
    });
    return resp.total ?? 0;
  };
  const stats = { window: {}, baseline: {}, baseline2: {} };
  if (business) {
    stats.window.errors = await countTraces(windowStart, windowEnd, { hasError: true });
    stats.baseline.errors = await countTraces(baselineStart, baselineEnd, { hasError: true });
    stats.baseline2.errors = await countTraces(baselineStart - windowMs, baselineStart, { hasError: true });
    stats.window.slow1s = await countTraces(windowStart, windowEnd, { timeUsedMin: 1000 });
    stats.baseline.slow1s = await countTraces(baselineStart, baselineEnd, { timeUsedMin: 1000 });
    stats.baseline2.slow1s = await countTraces(baselineStart - windowMs, baselineStart, { timeUsedMin: 1000 });
    stats.window.slow3s = await countTraces(windowStart, windowEnd, { timeUsedMin: 3000 });
    stats.baseline.slow3s = await countTraces(baselineStart, baselineEnd, { timeUsedMin: 3000 });
    stats.baseline2.slow3s = await countTraces(baselineStart - windowMs, baselineStart, { timeUsedMin: 3000 });
    chain.add({
      kind: "trace_stats",
      tool: "query_traces",
      query: { businessId: business.businessId, windows: { alarm: [formatLocalTime(windowStart), formatLocalTime(windowEnd)], baseline: [formatLocalTime(baselineStart), formatLocalTime(baselineEnd)], baseline2: [formatLocalTime(baselineStart - windowMs), formatLocalTime(baselineStart)] } },
      summary: `Alarm window vs two baseline windows: errors ${stats.window.errors}/${stats.baseline.errors}/${stats.baseline2.errors}, >1s ${stats.window.slow1s}/${stats.baseline.slow1s}/${stats.baseline2.slow1s}, >3s ${stats.window.slow3s}/${stats.baseline.slow3s}/${stats.baseline2.slow3s} (window/baseline/baseline2).`,
      data: stats,
    });
    // Reference = the quieter of the two baselines, so a pre-alarm ramp-up
    // in the first baseline window cannot mask the jump.
    const ref3s = Math.min(stats.baseline.slow3s, stats.baseline2.slow3s);
    const ratio3s = ref3s > 0 ? stats.window.slow3s / ref3s : (stats.window.slow3s > 0 ? Infinity : 1);
    if (ratio3s >= 2) {
      findings.push({
        id: `F${findings.length + 1}`,
        statement: `Slow calls (>3s) rose ${ratio3s === Infinity ? "from zero" : ratio3s.toFixed(1) + "x"} in the alarm window (${stats.window.slow3s} vs quietest baseline ${ref3s}).`,
        evidenceRefs: [chain.steps.length],
        severity: "high",
      });
    }
  }

  // ---- Step 6: dominant slow endpoints ----
  let topEndpoints = [];
  let worstTrace = null;
  if (business && stats.window.slow3s > 0) {
    const slowResp = await client.callTool("query_traces", {
      businessId: business.businessId,
      region: config.resourceRegion,
      startTimeString: formatLocalTime(windowStart),
      endTimeString: formatLocalTime(windowEnd),
      timeUsedMin: 3000,
      page: 1,
      pageSize: 100,
    });
    const spans = slowResp.spans ?? [];
    const bySource = new Map();
    for (const span of spans) {
      const entry = bySource.get(span.source) ?? { count: 0, maxMs: 0, sumMs: 0 };
      entry.count++;
      entry.maxMs = Math.max(entry.maxMs, span.timeUsed);
      entry.sumMs += span.timeUsed;
      bySource.set(span.source, entry);
    }
    topEndpoints = [...bySource.entries()]
      .map(([source, e]) => ({ source, ...e }))
      .sort((a, b) => b.sumMs - a.sumMs)
      .slice(0, 5);
    worstTrace = spans.length > 0 ? spans.reduce((a, b) => (b.timeUsed > a.timeUsed ? b : a)) : null;
    chain.add({
      kind: "slow_endpoint_ranking",
      tool: "query_traces",
      query: { businessId: business.businessId, timeUsedMin: 3000, window: [formatLocalTime(windowStart), formatLocalTime(windowEnd)], pageSize: 100 },
      summary: topEndpoints.length > 0
        ? `Dominant slow endpoint "${topEndpoints[0].source}" (${topEndpoints[0].count} of ${spans.length} sampled slow spans, max ${topEndpoints[0].maxMs}ms).`
        : "No slow spans sampled.",
      data: { sampled: spans.length, total: slowResp.total, topEndpoints },
    });
    if (topEndpoints.length > 0 && topEndpoints[0].count >= spans.length * 0.3) {
      findings.push({
        id: `F${findings.length + 1}`,
        statement: `Endpoint ${topEndpoints[0].source} dominates slow traffic (${topEndpoints[0].count}/${spans.length} sampled slow spans).`,
        evidenceRefs: [chain.steps.length],
        severity: "high",
      });
    }
  }

  // ---- Step 7: worst trace slow-event analysis (SQL / Redis / HTTP / Kafka) ----
  let sqlAnalysis = null;
  if (worstTrace !== null) {
    const eventsResp = await client.callTool("show_trace_events", { traceId: worstTrace.traceId });
    const events = eventsResp.span_event_list ?? [];
    const slowest = [...events].sort((a, b) => (b.time_used ?? 0) - (a.time_used ?? 0)).slice(0, 5)
      .map((e) => ({
        app: e.app_name,
        type: e.type,
        method: e.method,
        timeUsedMs: e.time_used,
        argument: e.argument,
      }));
    const sqlEvent = slowest.find((e) => e.type === "Mysql" && e.argument);
    sqlAnalysis = sqlEvent ? analyzeSqlPattern(sqlEvent.argument) : null;
    // Type breakdown of the slowest events: which dependency ate the time?
    const typeBreakdown = {};
    let typeTotal = 0;
    for (const e of slowest) {
      typeBreakdown[e.type ?? "unknown"] = (typeBreakdown[e.type ?? "unknown"] ?? 0) + (e.timeUsedMs ?? 0);
      typeTotal += e.timeUsedMs ?? 0;
    }
    const dominantType = Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    chain.add({
      kind: "trace_sql",
      tool: "show_trace_events",
      query: { traceId: worstTrace.traceId, source: worstTrace.source, timeUsedMs: worstTrace.timeUsed },
      summary: sqlEvent
        ? `Worst trace ${worstTrace.traceId} (${worstTrace.timeUsed}ms) spends ${sqlEvent.timeUsedMs}ms in one ${sqlEvent.app} SQL statement.`
        : `Worst trace ${worstTrace.traceId} (${worstTrace.timeUsed}ms); dominant slow-event type: ${dominantType ?? "n/a"}.`,
      data: { worstTrace: { traceId: worstTrace.traceId, source: worstTrace.source, timeUsedMs: worstTrace.timeUsed, envId: worstTrace.envId }, slowestEvents: slowest, typeBreakdown, sqlAnalysis },
    });
    if (sqlEvent && sqlAnalysis?.suspicious) {
      findings.push({
        id: `F${findings.length + 1}`,
        statement: `The dominant SQL is non-sargable: ${sqlAnalysis.reasons.join("; ")}.`,
        evidenceRefs: [chain.steps.length],
        severity: "high",
      });
    }
    const DOWNSTREAM = new Set(["Redis", "Kafka", "JettyClient", "HttpClient", "Httpclient", "OkHttp", "Redisson"]);
    if (dominantType !== null && DOWNSTREAM.has(dominantType) && typeTotal > 0 && typeBreakdown[dominantType] / typeTotal >= 0.5) {
      findings.push({
        id: `F${findings.length + 1}`,
        statement: `Slow ${dominantType} operations dominate the worst trace (${typeBreakdown[dominantType]}ms of ${typeTotal}ms in its top events): inspect that dependency's health and call pattern.`,
        evidenceRefs: [chain.steps.length],
        severity: "high",
      });
    }
  }

  // ---- Step 8: resource CES metrics (discovered, namespace-agnostic) ----
  const metricSeries = {};
  if (resourceId !== null && dimensions.length > 0) {
    // Discover the REAL metric names for this resource instead of hardcoding
    // per-namespace lists: list_ces_metrics is the authoritative catalog, so
    // every CES namespace (RDS, DCS, DMS, ELB, ECS, NAT, ...) works the same way.
    // Some namespaces key metrics on a later dimension (e.g. DMS pairs
    // kafka_broker with kafka_instance_id), so try each dimension until one
    // returns a catalog.
    let discoveredMetrics = [];
    let discoveryDim = null;
    for (const dim of dimensions.slice(0, 3)) {
      try {
        const disc = await client.callTool("list_ces_metrics", {
          namespace,
          dimName: dim.name,
          dimValue: dim.value,
          limit: 1000,
        });
        const found = (disc.metrics ?? [])
          .map((m) => m.metric_name ?? m.metricName)
          .filter((name) => typeof name === "string");
        if (found.length > 0) {
          discoveredMetrics = found;
          discoveryDim = dim;
          break;
        }
      }
      catch {
        // try the next dimension
      }
    }
    chain.add({
      kind: "resource_metric_discovery",
      tool: "list_ces_metrics",
      query: { namespace, triedDimensions: dimensions.slice(0, 3), resolvedDimension: discoveryDim?.name ?? null, limit: 1000 },
      summary: discoveredMetrics.length > 0
        ? `Discovered ${discoveredMetrics.length} metrics for the alarmed resource (via dimension ${discoveryDim?.name}); relevance-scored candidates feed the metric step.`
        : "Metric discovery returned no catalog for this resource's dimensions; falling back to the alarm metric.",
      data: { total: discoveredMetrics.length, metrics: discoveredMetrics.slice(0, 40) },
    });
    // Candidates: the alarm's own metric first, then keyword-scored discovery
    // results, then the legacy per-namespace list as a discovery fallback.
    const KEYWORDS = [
      ["qps", 9], ["tps", 9], ["cpu", 8], ["slow", 8],
      ["error", 5], ["fail", 5], ["timeout", 5], ["latency", 5],
      ["conn", 4], ["mem", 4], ["wait", 4], ["drop", 4], ["lag", 4],
      ["usage", 3], ["util", 3], ["queue", 3], ["thread", 3], ["hit", 3], ["retry", 3],
    ];
    const alarmMetric = target.metric?.metricName ?? null;
    const scored = discoveredMetrics
      .filter((m) => m !== alarmMetric)
      .map((m) => {
        const lower = m.toLowerCase();
        let score = 0;
        for (const [keyword, weight] of KEYWORDS) {
          if (lower.includes(keyword)) {
            score += weight;
          }
        }
        return { m, score };
      })
      .sort((a, b) => b.score - a.score)
      .filter((e) => e.score > 0)
      .map((e) => e.m);
    const fallback = NAMESPACE_METRICS[namespace] ?? [];
    const metricNames = [...new Set([alarmMetric, ...scored, ...fallback].filter(Boolean))].slice(0, 8);
    const metricFrom = baselineStart;
    const metricTo = windowEnd;
    for (const metricName of metricNames) {
      try {
        const resp = await client.callTool("query_ces_metric_data", {
          namespace,
          metricName,
          dimensions,
          filter: "average",
          period: 60,
          from: metricFrom,
          to: metricTo,
        });
        const points = (resp.datapoints ?? resp.dataPoints ?? []).map((p) => [p.timestamp, p.average ?? null]);
        metricSeries[metricName] = { unit: (resp.datapoints ?? resp.dataPoints)[0]?.unit ?? null, points };
      }
      catch (error) {
        metricSeries[metricName] = { error: String(error?.message ?? error) };
      }
    }
    chain.add({
      kind: "resource_metrics",
      tool: "query_ces_metric_data",
      query: { namespace, dimensions, metrics: metricNames, from: metricFrom, to: metricTo, period: 60 },
      summary: `Resource ${resourceId} minute-level metrics across baseline+alarm window (${metricNames.join(", ")}).`,
      data: metricSeries,
    });
    // Generic, name-driven findings: the first half of each series is the
    // baseline window, the second half the alarm window.
    const values = (series) => series.map((p) => p[1]).filter((v) => v !== null);
    let metricFindings = 0;
    for (const [metricName, series] of Object.entries(metricSeries)) {
      if (metricFindings >= 3 || !Array.isArray(series.points) || series.points.length < 4) {
        continue;
      }
      const half = Math.floor(series.points.length / 2);
      const baselineVals = values(series.points.slice(0, half));
      const windowVals = values(series.points.slice(half));
      if (baselineVals.length === 0 || windowVals.length === 0) {
        continue;
      }
      const baselineMax = Math.max(...baselineVals);
      const baselineAvg = baselineVals.reduce((a, b) => a + b, 0) / baselineVals.length;
      const windowMax = Math.max(...windowVals);
      const lower = metricName.toLowerCase();
      if (lower.includes("cpu") && windowMax >= 80) {
        findings.push({
          id: `F${findings.length + 1}`,
          statement: `Resource metric ${metricName} peaked at ${windowMax.toFixed(1)} during the alarm window.`,
          evidenceRefs: [chain.steps.length],
          severity: "high",
        });
        metricFindings++;
      }
      else if (lower.includes("slow") && windowMax >= 2 * Math.max(baselineMax, 1)) {
        findings.push({
          id: `F${findings.length + 1}`,
          statement: `Slow indicator ${metricName} jumped (window max ${windowMax} vs baseline max ${baselineMax}).`,
          evidenceRefs: [chain.steps.length],
          severity: "high",
        });
        metricFindings++;
      }
      else if ((lower.includes("qps") || lower.includes("tps")) && baselineAvg > 0 && windowMax / baselineAvg < 1.5) {
        findings.push({
          id: `F${findings.length + 1}`,
          statement: `Throughput ${metricName} stayed flat (window max ${windowMax.toFixed(0)} vs baseline avg ${baselineAvg.toFixed(0)}): the degradation is execution-side, not traffic-side.`,
          evidenceRefs: [chain.steps.length],
          severity: "medium",
        });
        metricFindings++;
      }
    }
  }

  // ---- Step 9: AOM infrastructure events around the window ----
  try {
    const durationMin = Math.max(1, Math.ceil((windowEnd - baselineStart) / 60000));
    const eventsResp = await client.callTool("list_aom_events", {
      timeRange: `${baselineStart}.${windowEnd}.${durationMin}`,
      limit: 50,
    });
    const events = eventsResp.events ?? [];
    const byName = new Map();
    for (const e of events) {
      const name = e.metadata?.event_name ?? e.metadata?.name ?? "unknown";
      byName.set(name, (byName.get(name) ?? 0) + 1);
    }
    const notable = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    chain.add({
      kind: "aom_events",
      tool: "list_aom_events",
      query: { timeRange: `${baselineStart}.${windowEnd}.${durationMin}`, limit: 50 },
      summary: events.length === 0
        ? "No AOM infrastructure events in the baseline+alarm window."
        : `${events.length} AOM events in the window; top: ${notable.map(([n, c]) => `${n}(${c})`).join(", ")}.`,
      data: {
        total: events.length,
        byName: Object.fromEntries(notable),
        events: events.slice(0, 10).map((e) => ({
          startsAt: e.starts_at,
          severity: e.metadata?.event_severity ?? null,
          kind: e.metadata?.kind ?? null,
          namespace: e.metadata?.namespace ?? null,
          name: e.metadata?.name ?? null,
          eventName: e.metadata?.event_name ?? null,
          message: e.annotations?.message ?? null,
        })),
      },
    });
    const suspicious = events.filter((e) => {
      const text = `${e.metadata?.event_name ?? ""} ${e.annotations?.message ?? ""}`;
      return /OOM|Evict|Failed|Kill|Crash|BackOff|Unhealthy|Scheduling/iu.test(text);
    });
    if (suspicious.length > 0) {
      findings.push({
        id: `F${findings.length + 1}`,
        statement: `${suspicious.length} suspicious infrastructure event(s) in the window (e.g. ${suspicious[0].metadata?.event_name ?? "unknown"} on ${suspicious[0].metadata?.name ?? "?"}).`,
        evidenceRefs: [chain.steps.length],
        severity: "medium",
      });
    }
  }
  catch {
    // AOM events are supplementary; absence never fails the diagnosis.
  }

  // ---- Conclusion (rule-based) ----
  const sqlSuspicious = sqlAnalysis?.suspicious === true;
  const flatTraffic = findings.some((f) => f.statement.includes("stayed flat"));
  const rootCause = sqlSuspicious
    ? `A non-sargable SQL pattern on the dominant endpoint saturated the ${namespace} resource; the CES alarm is the downstream symptom.`
    : flatTraffic
      ? `The ${namespace} resource degraded under unchanged traffic; inspect the recorded metrics and trace SQL for the execution-side cause.`
      : `Correlated application slowdown around the ${namespace} alarm; see findings and evidence for the dominant endpoint.`;
  const recommendations = [];
  if (sqlSuspicious) {
    recommendations.push("Rewrite the captured SQL to a sargable form (prefix LIKE / dedicated index) and add a query timeout.");
  }
  recommendations.push(`Add a CES alarm on slow-query count for resource ${resourceId ?? "(resource)"} for earlier warning than CPU.`);
  recommendations.push("Review the evidence chain with a code-diagnosis service for a second opinion.");

  return finish({
    chain,
    findings,
    incident: {
      title: target.alarmName,
      severity: target.alarmLevel === 1 ? "critical" : target.alarmLevel === 2 ? "major" : "minor",
      status: target.alarmStatus,
      detectedAt: formatLocalTime(windowStart),
      recoveredAt: formatLocalTime(windowEnd),
    },
    context: {
      source: "ces-alarm",
      resource: { type: namespace, id: resourceId, dimensions },
      business,
      environments: environments.slice(0, 10),
      timeWindow: {
        alarm: [formatLocalTime(windowStart), formatLocalTime(windowEnd)],
        baseline: [formatLocalTime(baselineStart), formatLocalTime(baselineEnd)],
        baseline2: [formatLocalTime(baselineStart - windowMs), formatLocalTime(baselineStart)],
      },
    },
    config,
    params,
    client,
    conclusion: { rootCause, confidence: sqlSuspicious ? "high" : "medium", recommendations },
  });
}

async function finish({ chain, findings, incident, context, config, params, client, conclusion }) {
  const provenance = {
    mcpServer: config.serverUrl,
    generatedAt: new Date().toISOString(),
    generator: GENERATOR,
    schema: "dpom-evidence-chain/" + EVIDENCE_CHAIN_SCHEMA_VERSION,
  };
  const full = chain.build({ incident, context, findings, conclusion, provenance });
  const compact = {
    ...full,
    evidence: full.evidence.map((step) => ({ ...step, data: trimForCompact(step.data, 5) })),
  };
  let outputPath = null;
  if (typeof params.outputPath === "string" && params.outputPath.trim() !== "") {
    const resolved = path.resolve(process.cwd(), params.outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, JSON.stringify(full, null, 2), "utf-8");
    outputPath = resolved;
  }
  await client.close().catch(() => {});
  return {
    summary: {
      incident: incident.title,
      status: incident.status,
      business: context.business?.name ?? null,
      rootCause: conclusion.rootCause,
      findings: findings.length,
      evidenceSteps: full.evidence.length,
    },
    chain: compact,
    outputPath,
  };
}
