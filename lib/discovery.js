/**
 * APM CMDB discovery chain with caching: the fix for "businessId / envId
 * don't know how to fill them".
 *
 * The chain mirrors the DPOMBaseMCPServer specs:
 *   list_apm_business -> business_id -> search_apm_application -> env_id
 *
 * Two traps this module neutralizes:
 *   1. MCP tool arguments are camelCase (businessId), while the specs and
 *      human habit say snake_case (business_id). Callers of this module use
 *      plain camelCase and never touch raw MCP arguments.
 *   2. search_apm_application's region is the RESOURCE region (where the
 *      monitored apps run, e.g. cn-north-9), NOT the APM endpoint region
 *      (cn-north-4). Passing the wrong one silently returns zero apps.
 */

/** Score how well a candidate string matches the wanted tokens. */
function scoreCandidate(candidate, tokens) {
  const haystack = candidate.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (token.length < 3) {
      continue;
    }
    if (haystack === token) {
      score += 10;
    }
    else if (haystack.includes(token)) {
      score += 5;
    }
    else if (token.includes(haystack) && haystack.length >= 4) {
      score += 3;
    }
  }
  return score;
}

/**
 * Extract business-name candidate tokens from a CES alarm name and its SMN
 * notification topics. Example: "P2风险告警-智能光伏-RDS-CPU使用率" plus
 * "SmartPVMS_critical_alarm" yields ["smartpvms"] via the topic, because the
 * Chinese display name usually does not appear in APM business names.
 */
export function extractBusinessTokens({ alarmName = "", smnTopics = [] }) {
  const tokens = new Set();
  for (const topic of smnTopics) {
    const base = String(topic).split(":").pop() ?? "";
    for (const part of base.split(/[^A-Za-z0-9]+/u)) {
      if (part.length >= 3 && !/^critical$|^major$|^minor$|^alarm$|^notice$|^warning$/iu.test(part)) {
        tokens.add(part.toLowerCase());
      }
    }
  }
  for (const segment of String(alarmName).split(/[-_\s]+/u)) {
    if (/^[A-Za-z][A-Za-z0-9]{2,}$/u.test(segment)) {
      tokens.add(segment.toLowerCase());
    }
  }
  return [...tokens];
}

export class ApmDiscovery {
  /** @type {{ at: number, businesses: object[] } | null} */
  #businessCache = null;
  /** @type {Map<string, { at: number, apps: object[] }>} keyed by businessId */
  #appCache = new Map();

  /**
   * @param {import("./mcp-client.js").DpomMcpClient} client
   * @param {object} config
   * @param {string} config.resourceRegion - region where monitored resources run, e.g. cn-north-9
   * @param {number} [config.discoveryCacheTtlMs=3600000] - cache TTL for business/app lists
   */
  constructor(client, config) {
    this.client = client;
    this.resourceRegion = config.resourceRegion;
    this.cacheTtlMs = config.discoveryCacheTtlMs ?? 3600000;
  }

  #businesses() {
    return this.#businessCache;
  }

  /**
   * List all APM businesses (cached). Each entry: { id, name, displayName, isDefault, epsId }.
   * @param {boolean} [force=false] - bypass the cache
   * @returns {Promise<object[]>}
   */
  async listBusinesses(force = false) {
    const cached = this.#businesses();
    if (!force && cached !== null && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.businesses;
    }
    const response = await this.client.callTool("list_apm_business", {});
    const businesses = (response.business_nodes ?? []).map((node) => ({
      id: node.id,
      name: node.name,
      displayName: node.display_name ?? node.name,
      isDefault: node.is_default ?? node.default ?? false,
      epsId: node.eps_id ?? null,
    }));
    this.#businessCache = { at: Date.now(), businesses };
    return businesses;
  }

  /**
   * Resolve a business id from any of: explicit id, exact name, or tokens
   * extracted from a CES alarm name / SMN topic. Returns the match method so
   * callers can surface how the id was derived.
   *
   * @param {object} input
   * @param {number} [input.businessId]
   * @param {string} [input.businessName]
   * @param {string} [input.alarmName]
   * @param {string[]} [input.smnTopics]
   * @returns {Promise<{ businessId: number, name: string, matchMethod: string } | null>}
   */
  async resolveBusiness({ businessId, businessName, alarmName, smnTopics = [] }) {
    const businesses = await this.listBusinesses();
    if (typeof businessId === "number") {
      const hit = businesses.find((b) => b.id === businessId);
      if (hit) {
        return { businessId: hit.id, name: hit.name, matchMethod: "explicit-id" };
      }
      return null;
    }
    if (typeof businessName === "string" && businessName.trim() !== "") {
      const wanted = businessName.trim().toLowerCase();
      const hit = businesses.find((b) => b.name.toLowerCase() === wanted || b.displayName.toLowerCase() === wanted);
      if (hit) {
        return { businessId: hit.id, name: hit.name, matchMethod: "name-match" };
      }
    }
    const tokens = extractBusinessTokens({ alarmName, smnTopics });
    if (tokens.length === 0) {
      return null;
    }
    let best = null;
    let bestScore = 0;
    for (const business of businesses) {
      const score = scoreCandidate(business.name, tokens) + scoreCandidate(business.displayName, tokens);
      if (score > bestScore) {
        bestScore = score;
        best = business;
      }
    }
    if (best !== null && bestScore >= 3) {
      return { businessId: best.id, name: best.name, matchMethod: "alarm-token-match" };
    }
    return null;
  }

  /**
   * List apps/environments of one business in the RESOURCE region (cached).
   * Each entry: { appName, appId, envName, envId, onlineCount, disableCount, offlineCount }.
   *
   * @param {number} businessId
   * @param {boolean} [force=false] - bypass the cache
   * @returns {Promise<object[]>}
   */
  async listApps(businessId, force = false) {
    const key = String(businessId);
    const cached = this.#appCache.get(key);
    if (!force && cached !== undefined && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.apps;
    }
    const response = await this.client.callTool("search_apm_application", {
      businessId,
      region: this.resourceRegion,
      page: 1,
      pageSize: 100,
    });
    const apps = (response.app_info_list ?? []).map((app) => ({
      appName: app.app_name,
      appId: app.app_id,
      envName: app.env_name,
      envId: app.env_id,
      onlineCount: app.online_count ?? 0,
      disableCount: app.disable_count ?? 0,
      offlineCount: app.offline_count ?? 0,
    }));
    this.#appCache.set(key, { at: Date.now(), apps });
    return apps;
  }

  /**
   * Resolve the environment to diagnose: by exact env name, else the env
   * with the most online probes.
   *
   * @param {number} businessId
   * @param {string} [envName]
   * @returns {Promise<{ envId: number, envName: string, appName: string, onlineCount: number } | null>}
   */
  async resolveEnv(businessId, envName) {
    const apps = await this.listApps(businessId);
    if (apps.length === 0) {
      return null;
    }
    if (typeof envName === "string" && envName.trim() !== "") {
      const wanted = envName.trim().toLowerCase();
      const hit = apps.find((app) => app.envName.toLowerCase() === wanted);
      if (hit) {
        return this.#envOf(hit);
      }
    }
    const best = [...apps].sort((a, b) => b.onlineCount - a.onlineCount)[0];
    return this.#envOf(best);
  }

  #envOf(app) {
    return {
      envId: app.envId,
      envName: app.envName,
      appName: app.appName,
      onlineCount: app.onlineCount,
    };
  }
}
