/**
 * Minimal MCP client over the SSE transport, tailored for DPOMBaseMCPServer.
 *
 * Zero runtime dependencies: uses the host process global fetch. The client
 * keeps one SSE session alive, reconnects transparently after a broken
 * stream or a timed-out request, and resolves each JSON-RPC response by id.
 */

const JSONRPC_PROTOCOL_VERSION = "2024-11-05";

/** Error raised when an MCP tool call returns an upstream error payload. */
export class McpToolError extends Error {
  /**
   * @param {string} message - human-readable description
   * @param {object} payload - the upstream ErrorResponse object
   */
  constructor(message, payload) {
    super(message);
    this.name = "McpToolError";
    this.payload = payload;
  }
}

export class DpomMcpClient {
  /** @type {string} */
  #base;
  /** @type {number} */
  #requestTimeoutMs;
  /** @type {number} */
  #connectTimeoutMs;
  /** @type {string | null} session message endpoint, e.g. /mcp/messages?sessionId=... */
  #endpoint = null;
  /** @type {Map<number, (msg: object) => void>} */
  #pending = new Map();
  /** @type {AbortController | null} */
  #controller = null;
  /** @type {Promise<void> | null} */
  #pump = null;
  /** @type {Promise<void> | null} */
  #connecting = null;
  /** @type {number} */
  #nextId = 1;

  /**
   * @param {object} options
   * @param {string} options.serverUrl - MCP server base URL, e.g. http://127.0.0.1:8080
   * @param {number} [options.requestTimeoutMs=120000] - per JSON-RPC request timeout
   * @param {number} [options.connectTimeoutMs=10000] - SSE endpoint handshake timeout
   */
  constructor({ serverUrl, requestTimeoutMs = 120000, connectTimeoutMs = 10000 }) {
    if (typeof serverUrl !== "string" || !/^https?:\/\//u.test(serverUrl)) {
      throw new Error(`dpom-apm: serverUrl must be an http(s) URL, got ${JSON.stringify(serverUrl)}`);
    }
    this.#base = serverUrl.replace(/\/+$/u, "");
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
  }

  /**
   * Ensure a live SSE session; connect at most once concurrently.
   * @returns {Promise<void>}
   */
  async #ensureSession() {
    if (this.#endpoint !== null && this.#controller !== null && !this.#controller.signal.aborted) {
      return;
    }
    if (this.#connecting === null) {
      this.#connecting = this.#connect().finally(() => {
        this.#connecting = null;
      });
    }
    await this.#connecting;
  }

  async #connect() {
    await this.#disposeSession();
    const controller = new AbortController();
    this.#controller = controller;
    const response = await fetch(`${this.#base}/sse`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!response.ok || response.body === null) {
      throw new Error(`dpom-apm: cannot open SSE stream at ${this.#base}/sse (HTTP ${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    this.#pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            this.#handleFrame(frame);
            index = buffer.indexOf("\n\n");
          }
        }
        this.#failAllPending(new Error("dpom-apm: MCP SSE stream closed by server"));
      }
      catch (error) {
        if (error?.name !== "AbortError") {
          this.#failAllPending(new Error(`dpom-apm: MCP SSE stream failed: ${String(error?.message ?? error)}`));
        }
      }
    })();
    const deadline = Date.now() + this.#connectTimeoutMs;
    while (this.#endpoint === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.#endpoint === null) {
      await this.#disposeSession();
      throw new Error("dpom-apm: no endpoint event from MCP server within connect timeout");
    }
    await this.#rpc("initialize", {
      protocolVersion: JSONRPC_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dsh-plugin-dpom-apm", version: "0.1.0" },
    }, this.#connectTimeoutMs);
    await fetch(`${this.#base}${this.#endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
  }

  #handleFrame(frame) {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      }
      else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }
    if (event === "endpoint") {
      this.#endpoint = data;
      return;
    }
    if (event !== "message" || data === "") {
      return;
    }
    let message;
    try {
      message = JSON.parse(data);
    }
    catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null && this.#pending.has(id)) {
      this.#pending.get(id)(message);
      this.#pending.delete(id);
    }
  }

  #failAllPending(error) {
    for (const resolve of this.#pending.values()) {
      resolve({ error: { code: -32000, message: error.message } });
    }
    this.#pending.clear();
  }

  async #rpc(method, params, timeoutMs = this.#requestTimeoutMs) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`dpom-apm: MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      fetch(`${this.#base}${this.#endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }).catch((cause) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error(`dpom-apm: MCP request ${method} failed: ${String(cause?.message ?? cause)}`));
      });
    });
  }

  /**
   * Call one MCP tool and return its parsed result. Text content blocks are
   * joined and parsed as JSON when possible; upstream error payloads raise
   * {@link McpToolError}; transport errors retry once on a fresh session.
   *
   * @param {string} name - MCP tool name, e.g. list_apm_business
   * @param {object} args - tool arguments (camelCase, as the MCP schema declares)
   * @returns {Promise<object>} parsed tool result
   */
  async callTool(name, args = {}) {
    let response;
    try {
      await this.#ensureSession();
      response = await this.#rpc("tools/call", { name, arguments: args });
    }
    catch (error) {
      if (error instanceof McpToolError) {
        throw error;
      }
      // One transparent reconnect for transport-level failures.
      await this.#disposeSession();
      await this.#ensureSession();
      response = await this.#rpc("tools/call", { name, arguments: args });
    }
    if (response.error) {
      throw new McpToolError(`dpom-apm: MCP ${name} failed: ${response.error.message}`, response.error);
    }
    const result = response.result;
    if (result?.isError) {
      throw new McpToolError(`dpom-apm: MCP ${name} returned an error result`, this.#parseContent(result));
    }
    return this.#parseContent(result);
  }

  #parseContent(result) {
    const text = (result?.content ?? []).map((block) => block.text ?? "").join("");
    try {
      return JSON.parse(text);
    }
    catch {
      return { raw: text };
    }
  }

  async #disposeSession() {
    const controller = this.#controller;
    this.#controller = null;
    this.#endpoint = null;
    if (controller !== null) {
      controller.abort();
    }
    const pump = this.#pump;
    this.#pump = null;
    await pump?.catch(() => {});
    this.#failAllPending(new Error("dpom-apm: session disposed"));
  }

  /** Close the SSE session, if any. Safe to call repeatedly. */
  async close() {
    await this.#disposeSession();
  }
}
