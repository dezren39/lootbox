/**
 * Default constants for lootbox configuration.
 *
 * All hardcoded values that were previously scattered across the codebase
 * are centralized here. These serve as the base defaults; they can be
 * overridden via lootbox.config.json (or --config <path>) and CLI flags.
 *
 * "hazmat" overrides in the config can replace any of these at the user's
 * own risk.
 */

// ── Server defaults ──────────────────────────────────────────────────
/** TCP port the WebSocket RPC server listens on. */
export const DEFAULT_PORT = 3000;

/** Script-execution timeout in milliseconds (server-side). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** RPC function-call timeout inside worker processes, in milliseconds. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Maximum time to wait for all workers to become ready, in milliseconds. */
export const DEFAULT_WORKER_READY_TIMEOUT_MS = 30_000;

// ── Client defaults ──────────────────────────────────────────────────
/**
 * Additional milliseconds added on top of `timeout` for the client-side
 * WebSocket response timeout.  The effective client timeout is:
 *
 *   max(timeout + clientTimeoutBuffer, CLIENT_TIMEOUT_FLOOR_MS)
 *
 * May be negative to shrink the client timeout below the server timeout
 * (not recommended).
 */
export const DEFAULT_CLIENT_TIMEOUT_BUFFER_MS = 5_000;

/**
 * Absolute floor for the client timeout so that even a very small
 * server timeout does not make the client give up too early.
 */
export const CLIENT_TIMEOUT_FLOOR_MS = 30_000;

// ── Permissions defaults ─────────────────────────────────────────────
/**
 * Default Deno permission flags applied to user-script execution when
 * `permissions` is unset or `true` in the config.
 *
 * These mirror the original "sandbox" behaviour: network access only,
 * plus the dynamic `--allow-import=localhost:<port>`.
 */
export const DEFAULT_PERMISSION_FLAGS: readonly string[] = ["--allow-net"];

/**
 * Config file name searched for in the current working directory
 * when no --config flag is supplied.
 */
export const DEFAULT_CONFIG_FILENAME = "lootbox.config.json";

