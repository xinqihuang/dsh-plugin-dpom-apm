/**
 * dsh-plugin-dpom-apm — DeepSeek Harness plugin for DPOMBaseMCPServer APM
 * diagnostics.
 *
 * The plugin mounts three agent tools (see lib/tools.js):
 *   dpom_apm_resolve_context, dpom_apm_call, dpom_apm_diagnose_alarm
 *
 * It exists because the raw MCP server is hard to drive: businessId / envId
 * are unclear, tool arguments are camelCase while the specs read snake_case,
 * and the "region" argument means the resource region, not the APM endpoint
 * region. This plugin resolves all of that deterministically.
 */

import { DpomMcpClient } from "./mcp-client.js";
import { registerTools } from "./tools.js";

/** Stable cordis plugin name. */
export const name = "dpom-apm";

/** Host services this plugin needs: the agent tool registry. */
export const inject = ["tools"];

/** Default configuration; every field can be overridden in the patch entry. */
const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8080",
  resourceRegion: "cn-north-9",
  defaultBusinessId: null,
  requestTimeoutMs: 120000,
  connectTimeoutMs: 10000,
  discoveryCacheTtlMs: 3600000,
};

/**
 * Mount the plugin: build the MCP client and register the three tools.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context
 * @param {object} [config] - entry config from cordis.patch.yml
 */
export async function apply(ctx, config = {}) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) };
  const client = new DpomMcpClient(resolved);
  registerTools(ctx, client, resolved);
  ctx.effect(() => {
    void client.close();
  });
}
