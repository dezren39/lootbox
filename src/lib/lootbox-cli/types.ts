// ── Execution response ───────────────────────────────────────────────
export interface ExecResponse {
  result?: string;
  error?: string;
  id?: string;
}

// ── MCP server configuration ─────────────────────────────────────────
export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// ── Permissions ──────────────────────────────────────────────────────
/**
 * Flexible permission specification for user-script execution.
 *
 * Accepted shapes:
 *
 *   true          – apply the default permission set (--allow-net)
 *   false | null  – no extra permissions (fully sandboxed)
 *   "all"         – grant --allow-all
 *   string        – comma-separated permission tokens, e.g.
 *                   "--allow-net,--allow-read=/tmp"
 *   string[]      – ordered list of permission tokens
 *   object        – fine-grained control (see PermissionsObject)
 */
export type PermissionsConfig =
  | boolean
  | null
  | "all"
  | string
  | string[]
  | PermissionsObject;

/**
 * Object form of permissions.
 *
 *   defaults  – if true, prepend the built-in default flags first
 *   allow     – list of --allow-* tokens (shorthand: "net" => "--allow-net")
 *   deny      – list of --deny-* tokens  (shorthand: "write" => "--deny-write")
 */
export interface PermissionsObject {
  defaults?: boolean;
  allow?: string[];
  deny?: string[];
}

// ── Config file shape ("lootbox.config.json") ────────────────────────
//
// Top-level keys:
//   server   – settings consumed only by the server process
//   client   – settings consumed only by the client / exec CLI
//   global   – settings consumed by both sides
//   hazmat   – internal overrides (not documented in help/examples)
//
// All keys are optional; sensible defaults live in constants.ts.

/** Server-specific configuration. */
export interface ServerConfig {
  port?: number;
  lootboxRoot?: string;
  lootboxDataDir?: string;
  mcpServers?: Record<string, McpServerConfig>;
  /** Script-execution timeout in ms (default 10 000). */
  timeout?: number;
  /** Deno permissions for user-script execution (default true = sandbox). */
  permissions?: PermissionsConfig;
  /** RPC function-call timeout inside worker subprocesses in ms (default 30 000). */
  rpcTimeout?: number;
}

/** Client-specific configuration. */
export interface ClientConfig {
  serverUrl?: string;
  /**
   * Client-side WebSocket response timeout in ms.
   * Default: max(timeout + clientTimeoutBuffer, 30 000).
   * When set explicitly this value is used as-is.
   */
  clientTimeout?: number;
  /**
   * Buffer added to the server timeout to derive the default client timeout.
   * May be negative. Default 5 000.
   */
  clientTimeoutBuffer?: number;
  /** Delay in ms before auto-disconnecting after all calls finish (default 100). */
  autoDisconnectDelay?: number;
}

/** Settings that apply to both server and client. */
export interface GlobalConfig {
  /** Default port (used to derive serverUrl on client side). */
  port?: number;
}

/** Hazmat (internal) overrides – mirrors the same structure. */
export interface HazmatConfig {
  server?: Partial<ServerConfig & HazmatServerExtras>;
  client?: Partial<ClientConfig & HazmatClientExtras>;
  global?: Partial<GlobalConfig & HazmatGlobalExtras>;
}

/**
 * Extra fields that are only valid inside hazmat.server.
 * Placing these in the normal `server` block will trigger
 * strict-validation errors/warnings.
 */
export interface HazmatServerExtras {
  /** Max time to wait for workers to become ready in ms (default 30 000). */
  workerReadyTimeout?: number;
  /** Grace period in ms before force-killing a worker on reload (default 500). */
  workerShutdownGrace?: number;
  /** Debounce delay in ms for file-watcher events (default 100). */
  fileWatchDebounce?: number;
  /** Maximum backoff cap in ms for worker restart (default 30 000). */
  maxWorkerBackoff?: number;
  /** Circuit breaker: max worker restart attempts; 0 = unlimited (default 0). */
  maxWorkerRestarts?: number;
  /** Base value in ms for exponential worker-restart backoff (default 1 000). */
  workerBackoffBase?: number;
  /** Delay in ms after HTTP start before spawning workers (default 100). */
  serverStartDelay?: number;
  /** Polling interval in ms while waiting for worker readiness (default 100). */
  workerPollInterval?: number;
  /** SQLite database filename (default "lootbox.db"). */
  dbFilename?: string;
  /** WebSocket path for worker connections (default "/worker-ws"). */
  workerWsPath?: string;
  /** Health-check endpoint path (default "/health"). */
  healthPath?: string;
  /** File extension for tool discovery (default ".ts"). */
  toolFileExtension?: string;
  /** Title for the OpenAPI spec (default "Lootbox API"). */
  openApiTitle?: string;
  /** MCP client identity string (default "lootbox"). */
  mcpClientName?: string;
}

/**
 * Extra fields that are only valid inside hazmat.client.
 */
export interface HazmatClientExtras {
  /** Filename for persisted workflow state (default ".lootbox-workflow.json"). */
  workflowStateFile?: string;
  /** Delay in ms before client attempts reconnection (default 1 000). */
  reconnectDelay?: number;
}

/**
 * Extra fields that are only valid inside hazmat.global.
 */
export interface HazmatGlobalExtras {
  /** WebSocket endpoint path for client connections (default "/ws"). */
  wsPath?: string;
  /** Config filename (default "lootbox.config.json"). */
  configFilename?: string;
}

/** Root config file schema. */
export interface Config {
  server?: ServerConfig;
  client?: ClientConfig;
  global?: GlobalConfig;
  hazmat?: HazmatConfig;

  // ── Legacy flat keys (still read for backward compat) ──────────────
  port?: number;
  serverUrl?: string;
  lootboxRoot?: string;
  lootboxDataDir?: string;
  mcpServers?: Record<string, McpServerConfig>;
  timeout?: number;
  /** @deprecated Use `server.permissions` instead. */
  sandbox?: boolean;
}

// ── Resolved config (output of get_config) ───────────────────────────
/** Fully resolved, validated configuration used at runtime. */
export interface ResolvedConfig {
  // Paths
  lootbox_root: string;
  tools_dir: string;
  workflows_dir: string;
  scripts_dir: string;

  // Server
  port: number;
  lootbox_data_dir: string | null;
  mcp_servers: Record<string, McpServerConfig> | null;
  timeout: number;
  rpc_timeout: number;
  worker_ready_timeout: number;

  /**
   * Pre-computed Deno CLI flags for user-script permissions.
   * e.g. ["--allow-net", "--allow-import=localhost:3000"]
   * An empty array means no extra permissions.
   * Contains "--allow-all" when full access is requested.
   */
  permission_flags: string[];

  // Server – hazmat (resolved, not behind .hazmat)
  worker_shutdown_grace: number;
  file_watch_debounce: number;
  max_worker_backoff: number;
  max_worker_restarts: number;
  worker_backoff_base: number;
  server_start_delay: number;
  worker_poll_interval: number;
  db_filename: string;
  worker_ws_path: string;
  health_path: string;
  tool_file_extension: string;
  openapi_title: string;
  mcp_client_name: string;

  // Client
  server_url: string;
  client_timeout: number;
  auto_disconnect_delay: number;

  // Client – hazmat (resolved)
  workflow_state_file: string;
  reconnect_delay: number;

  // Global – hazmat (resolved)
  ws_path: string;
}

// ── Workflow state ───────────────────────────────────────────────────
export interface FlowState {
  file: string;
  section: number;
  loopIteration?: number;
  sessionId?: string;
}
