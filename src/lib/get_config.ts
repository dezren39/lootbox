import { parseArgs } from "@std/cli";
import { exists } from "https://deno.land/std@0.208.0/fs/mod.ts";
import type {
  Config,
  HazmatServerExtras,
  McpServerConfig,
  PermissionsConfig,
  ResolvedConfig,
  ServerConfig,
} from "./lootbox-cli/types.ts";
import {
  getUserLootboxToolsDir,
  getUserLootboxWorkflowsDir,
  getUserLootboxScriptsDir,
} from "./paths.ts";
import { dirname } from "https://deno.land/std@0.208.0/path/mod.ts";
import {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_WORKER_READY_TIMEOUT_MS,
  DEFAULT_CLIENT_TIMEOUT_BUFFER_MS,
  CLIENT_TIMEOUT_FLOOR_MS,
  DEFAULT_PERMISSION_FLAGS,
  DEFAULT_CONFIG_FILENAME,
} from "./constants.ts";

// ── Config file loading ──────────────────────────────────────────────

async function loadConfigFile(path?: string): Promise<Config> {
  const filePath = path || DEFAULT_CONFIG_FILENAME;
  try {
    const text = await Deno.readTextFile(filePath);
    return JSON.parse(text) as Config;
  } catch {
    // If an explicit --config was given and failed, that is an error.
    if (path) {
      console.error(`Error: could not read config file: ${filePath}`);
      Deno.exit(1);
    }
    return {};
  }
}

// ── Permission parsing ───────────────────────────────────────────────

/**
 * Normalise a single permission token into a proper Deno CLI flag.
 *
 *   "net"              -> "--allow-net"
 *   "--allow-net"      -> "--allow-net"
 *   "--deny-write=/x"  -> "--deny-write=/x"
 *   "read=/tmp"        -> "--allow-read=/tmp"
 *   "allow-read"       -> "--allow-read"
 *   "deny-env"         -> "--deny-env"
 */
function normalisePermissionToken(token: string): string {
  const t = token.trim();
  if (!t) return "";
  // Already a full flag
  if (t.startsWith("--")) return t;
  // Starts with allow- or deny- but missing --
  if (t.startsWith("allow-") || t.startsWith("deny-")) return `--${t}`;
  // Bare name, possibly with =value  e.g. "read=/tmp"
  return `--allow-${t}`;
}

/**
 * Parse a PermissionsConfig value into an ordered list of Deno CLI flags.
 * Returns an empty array for "no permissions".
 */
function parsePermissions(
  perm: PermissionsConfig | undefined,
): string[] {
  if (perm === undefined || perm === true) {
    return [...DEFAULT_PERMISSION_FLAGS];
  }
  if (perm === false || perm === null) {
    return [];
  }
  if (perm === "all") {
    return ["--allow-all"];
  }
  if (typeof perm === "string") {
    return perm
      .split(",")
      .map(normalisePermissionToken)
      .filter(Boolean);
  }
  if (Array.isArray(perm)) {
    return perm.map(normalisePermissionToken).filter(Boolean);
  }
  // Object form
  const flags: string[] = [];
  if (perm.defaults) {
    flags.push(...DEFAULT_PERMISSION_FLAGS);
  }
  if (perm.allow) {
    for (const a of perm.allow) {
      const n = normalisePermissionToken(a);
      if (n) flags.push(n);
    }
  }
  if (perm.deny) {
    for (const d of perm.deny) {
      const t = d.trim();
      if (!t) continue;
      if (t.startsWith("--")) {
        flags.push(t);
      } else if (t.startsWith("deny-")) {
        flags.push(`--${t}`);
      } else {
        flags.push(`--deny-${t}`);
      }
    }
  }
  return flags;
}

/**
 * Parse CLI permission flags (--allow-*, --deny-*, --no-sandbox) from
 * raw Deno.args and append them to the base permission list.
 *
 * --no-sandbox replaces everything with ["--allow-all"].
 */
function applyCLIPermissions(
  base: string[],
  rawArgs: string[],
): string[] {
  // Check for --no-sandbox first – it wins over everything
  if (rawArgs.includes("--no-sandbox")) {
    return ["--allow-all"];
  }

  const extra: string[] = [];
  for (const arg of rawArgs) {
    if (
      arg.startsWith("--allow-") ||
      arg.startsWith("--deny-")
    ) {
      extra.push(arg);
    }
  }
  if (extra.length === 0) return base;
  return [...base, ...extra];
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveNumber(
  cliStr: string | undefined,
  ...configValues: (number | undefined)[]
): number | undefined {
  if (cliStr !== undefined) {
    const n = parseInt(cliStr, 10);
    if (!isNaN(n)) return n;
  }
  for (const v of configValues) {
    if (v !== undefined) return v;
  }
  return undefined;
}

// ── Main export ──────────────────────────────────────────────────────

export const get_config = async (): Promise<ResolvedConfig> => {
  // --- Parse CLI args -------------------------------------------------
  const args = parseArgs(Deno.args, {
    string: [
      "lootbox-root",
      "port",
      "lootbox-data-dir",
      "timeout",
      "rpc-timeout",
      "client-timeout",
      "client-timeout-buffer",
      "config",
      "server-url",
    ],
    boolean: ["no-sandbox"],
    alias: {
      "lootbox-root": "r",
      port: "p",
      "lootbox-data-dir": "d",
    },
  });

  // --- Load config file -----------------------------------------------
  const config = await loadConfigFile(args.config as string | undefined);

  // --- Merge structured + legacy + hazmat ---------------------------------
  //   Priority (highest first):
  //   CLI flag > hazmat.server/client/global > server/client/global > legacy flat keys > defaults
  //
  //   Type boundaries enforce which keys belong where at compile time;
  //   unknown JSON keys are simply ignored at runtime (no manual key lists).
  const srv = config.server ?? {};
  const cli_ = config.client ?? {};
  const glb = config.global ?? {};
  const haz = config.hazmat ?? {};
  const hazSrv = (haz.server ?? {}) as Partial<ServerConfig & HazmatServerExtras>;
  const hazCli = haz.client ?? {};
  const hazGlb = haz.global ?? {};

  // --- Port -----------------------------------------------------------
  const port = (() => {
    const n = resolveNumber(
      args.port as string | undefined,
      hazGlb.port ?? hazSrv.port,
      glb.port ?? srv.port,
      config.port,
    );
    if (n !== undefined) return n;
    return DEFAULT_PORT;
  })();

  if (isNaN(port)) {
    console.error("Error: --port must be a valid number");
    Deno.exit(1);
  }

  // --- Lootbox root / dirs -------------------------------------------
  let lootboxRoot: string;
  let toolsDir: string;
  let workflowsDir: string;
  let scriptsDir: string;

  const explicitRoot =
    (args["lootbox-root"] as string) ||
    hazSrv.lootboxRoot ||
    srv.lootboxRoot ||
    config.lootboxRoot;

  if (explicitRoot) {
    lootboxRoot = explicitRoot;
    toolsDir = `${lootboxRoot}/tools`;
    workflowsDir = `${lootboxRoot}/workflows`;
    scriptsDir = `${lootboxRoot}/scripts`;
  } else {
    const localToolsDir = ".lootbox/tools";
    if (await exists(localToolsDir)) {
      lootboxRoot = ".lootbox";
      toolsDir = localToolsDir;
      workflowsDir = `${lootboxRoot}/workflows`;
      scriptsDir = `${lootboxRoot}/scripts`;
    } else {
      const homeToolsDir = getUserLootboxToolsDir();
      if (await exists(homeToolsDir)) {
        lootboxRoot = dirname(homeToolsDir);
        toolsDir = homeToolsDir;
        workflowsDir = getUserLootboxWorkflowsDir();
        scriptsDir = getUserLootboxScriptsDir();
      } else {
        console.error("\n\u274C No lootbox directory found!");
        console.error("\nLooked in:");
        console.error(`  \u2022 ${localToolsDir}`);
        console.error(`  \u2022 ${homeToolsDir}`);
        console.error(
          "\n\uD83D\uDCA1 Run 'lootbox init' to create a new lootbox project.\n",
        );
        Deno.exit(1);
      }
    }
  }

  // --- Data dir -------------------------------------------------------
  const lootboxDataDir =
    (args["lootbox-data-dir"] as string) ||
    hazSrv.lootboxDataDir ||
    srv.lootboxDataDir ||
    config.lootboxDataDir ||
    null;

  // --- MCP servers ----------------------------------------------------
  const mcpServers: Record<string, McpServerConfig> | null =
    hazSrv.mcpServers ?? srv.mcpServers ?? config.mcpServers ?? null;

  // --- Timeout --------------------------------------------------------
  const timeout = (() => {
    const n = resolveNumber(
      args.timeout as string | undefined,
      hazSrv.timeout,
      srv.timeout,
      config.timeout,
    );
    if (n !== undefined) {
      if (n <= 0) {
        console.error(
          "Error: --timeout must be a positive number (milliseconds)",
        );
        Deno.exit(1);
      }
      return n;
    }
    return DEFAULT_TIMEOUT_MS;
  })();

  // --- RPC timeout ----------------------------------------------------
  const rpcTimeout = (() => {
    const n = resolveNumber(
      args["rpc-timeout"] as string | undefined,
      hazSrv.rpcTimeout,
      srv.rpcTimeout,
    );
    return n ?? DEFAULT_RPC_TIMEOUT_MS;
  })();

  // --- Worker ready timeout -------------------------------------------
  const workerReadyTimeout = (() => {
    const n = resolveNumber(
      undefined, // no CLI flag for this – hazmat only
      hazSrv.workerReadyTimeout,
    );
    return n ?? DEFAULT_WORKER_READY_TIMEOUT_MS;
  })();

  // --- Permissions ----------------------------------------------------
  // Resolve from config (structured > legacy sandbox)
  let permConfig: PermissionsConfig | undefined =
    hazSrv.permissions ?? srv.permissions;

  if (permConfig === undefined && config.sandbox !== undefined) {
    // Legacy: sandbox:true => default permissions, sandbox:false => "all"
    permConfig = config.sandbox ? true : "all";
  }

  let permissionFlags = parsePermissions(permConfig);

  // Append dynamic --allow-import for the server port
  // (always needed so user scripts can import the generated client)
  const allowImport = `--allow-import=localhost:${port}`;
  if (
    !permissionFlags.includes("--allow-all") &&
    !permissionFlags.some((f) => f.startsWith("--allow-import"))
  ) {
    permissionFlags.push(allowImport);
  }

  // Apply CLI overrides (--no-sandbox, --allow-*, --deny-*)
  permissionFlags = applyCLIPermissions(permissionFlags, Deno.args);

  // Re-add --allow-import if --no-sandbox / --allow-all replaced everything
  // (--allow-all already covers imports, but keep it explicit for clarity)
  if (
    !permissionFlags.includes("--allow-all") &&
    !permissionFlags.some((f) => f.startsWith("--allow-import"))
  ) {
    permissionFlags.push(allowImport);
  }

  // --- Client timeout -------------------------------------------------
  const clientTimeoutBuffer = (() => {
    const n = resolveNumber(
      args["client-timeout-buffer"] as string | undefined,
      hazCli.clientTimeoutBuffer,
      cli_.clientTimeoutBuffer,
    );
    return n ?? DEFAULT_CLIENT_TIMEOUT_BUFFER_MS;
  })();

  const clientTimeout = (() => {
    const explicit = resolveNumber(
      args["client-timeout"] as string | undefined,
      hazCli.clientTimeout,
      cli_.clientTimeout,
    );
    if (explicit !== undefined) return explicit;
    return Math.max(timeout + clientTimeoutBuffer, CLIENT_TIMEOUT_FLOOR_MS);
  })();

  // --- Server URL (client-side) ---------------------------------------
  const serverUrl = (() => {
    if (args["server-url"]) return args["server-url"] as string;
    if (hazCli.serverUrl) return hazCli.serverUrl;
    if (cli_.serverUrl) return cli_.serverUrl;
    if (config.serverUrl) return config.serverUrl;
    return `ws://localhost:${port}/ws`;
  })();

  // --- Return ---------------------------------------------------------
  return {
    lootbox_root: lootboxRoot,
    tools_dir: toolsDir,
    workflows_dir: workflowsDir,
    scripts_dir: scriptsDir,
    port,
    lootbox_data_dir: lootboxDataDir,
    mcp_servers: mcpServers,
    timeout,
    rpc_timeout: rpcTimeout,
    worker_ready_timeout: workerReadyTimeout,
    permission_flags: permissionFlags,
    server_url: serverUrl,
    client_timeout: clientTimeout,
  };
};
