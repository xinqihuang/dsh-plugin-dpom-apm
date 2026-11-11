/**
 * Evidence chain builder: the fixed, replayable format in which a diagnosis
 * packages every observation it made.
 *
 * The format (schema/evidence-chain.schema.json) has one design goal: a
 * downstream code-diagnosis service must be able to (a) audit every step —
 * which MCP tool ran, with which arguments, what came back — without access
 * to the original MCP server, and (b) re-derive or challenge each finding
 * from the recorded raw data. Findings therefore reference evidence steps by
 * index instead of embedding their own copies of the data.
 */

export const EVIDENCE_CHAIN_SCHEMA_VERSION = "1.0";

export class EvidenceChainBuilder {
  constructor() {
    /** @type {object[]} */
    this.steps = [];
  }

  /**
   * Record one evidence step.
   *
   * @param {object} input
   * @param {string} input.kind - machine-readable step kind, e.g. "ces_alarm"
   * @param {string} input.tool - MCP tool name that produced the data
   * @param {object} input.query - the exact arguments the tool received
   * @param {string} input.summary - one-sentence human summary of what this step shows
   * @param {object} input.data - the raw (possibly trimmed) tool result
   * @returns {number} the 1-based step index, for findings to reference
   */
  add({ kind, tool, query, summary, data }) {
    this.steps.push({
      step: this.steps.length + 1,
      kind,
      tool,
      query,
      summary,
      data,
    });
    return this.steps.length;
  }

  /**
   * Assemble the final chain document.
   *
   * @param {object} input
   * @param {object} input.incident - { title, severity, status, detectedAt, recoveredAt }
   * @param {object} input.context - { source, resource, business, environments, timeWindow }
   * @param {object[]} input.findings - { id, statement, evidenceRefs: number[], severity }
   * @param {object} input.conclusion - { rootCause, confidence, recommendations: string[] }
   * @param {object} input.provenance - { mcpServer, generatedAt, generator }
   * @returns {object} the complete evidence chain document
   */
  build({ incident, context, findings, conclusion, provenance }) {
    return {
      schema: "dpom-evidence-chain/" + EVIDENCE_CHAIN_SCHEMA_VERSION,
      incident,
      context,
      evidence: this.steps,
      findings,
      conclusion,
      provenance,
    };
  }
}

/**
 * Trim a raw tool result for the compact in-conversation representation:
 * keep the top N items of every array plus totals, drop nothing else.
 *
 * @param {object} data - parsed tool result
 * @param {number} [topN=5] - keep at most this many leading array items
 * @returns {object} trimmed copy
 */
export function trimForCompact(data, topN = 5) {
  const trim = (value) => {
    if (Array.isArray(value)) {
      const kept = value.slice(0, topN);
      const rest = value.length - kept.length;
      const mapped = kept.map(trim);
      return rest > 0 ? [...mapped, { trimmed: rest }] : mapped;
    }
    if (value !== null && typeof value === "object") {
      const out = {};
      for (const [key, member] of Object.entries(value)) {
        out[key] = trim(member);
      }
      return out;
    }
    return value;
  };
  return trim(data);
}

/**
 * Detect non-sargable SQL predicates in a captured SQL statement — the most
 * common root cause pattern this plugin looks for.
 *
 * @param {string} sql
 * @returns {{ suspicious: boolean, reasons: string[] }}
 */
export function analyzeSqlPattern(sql) {
  const reasons = [];
  const text = String(sql).toLowerCase();
  if (/instr\s*\(/u.test(text)) {
    reasons.push("instr() on a column prevents index use (full table scan)");
  }
  if (/like\s+'%[^']*'/u.test(text)) {
    reasons.push("leading-wildcard LIKE cannot use an index");
  }
  if (/\b(not\s+)?in\s*\(/u.test(text)) {
    reasons.push("IN / NOT IN list can disable index range scans");
  }
  if (/\bselect\b[^;]*\bfrom\b[^;]*$/iu.test(text) && (text.match(/,/gu) ?? []).length > 10) {
    reasons.push("very wide SELECT list increases scan cost");
  }
  return { suspicious: reasons.length > 0, reasons };
}
