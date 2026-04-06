import { parseArgs } from "@std/cli";
import { exists } from "https://deno.land/std@0.208.0/fs/mod.ts";
import type { Config, McpServerConfig } from "./lootbox-cli/types.ts";
import {
  getUserLootboxToolsDir,
  getUserLootboxWorkflowsDir,
  getUserLootboxScriptsDir
} from "./paths.ts";
import { join, dirname } from "https://deno.land/std@0.208.0/path/mod.ts";

interface ResolvedConfig {
  lootbox_root: string;
  tools_dir: string;
  workflows_dir: string;
  scripts_dir: string;
  port: number;
  lootbox_data_dir: string | null;
  mcp_servers: Record<string, McpServerConfig> | null;
  timeout: number;
  sandbox: boolean;
}

async function loadConfig(): Promise<Config> {
  try {
    const configText = await Deno.readTextFile("lootbox.config.json");
    return JSON.parse(configText);
  } catch {
    return {};
  }
}

export const get_config = async (): Promise<ResolvedConfig> => {
  const args = parseArgs(Deno.args, {
    string: ["lootbox-root", "port", "lootbox-data-dir", "timeout"],
    boolean: ["sandbox", "no-sandbox"],
    alias: {
      "lootbox-root": "r",
      port: "p",
      "lootbox-data-dir": "d",
    },
  });

  // Load config file
  const config = await loadConfig();

  // Priority: flag > config > local .lootbox > home ~/.lootbox
  let lootboxRoot: string;
  let toolsDir: string;
  let workflowsDir: string;
  let scriptsDir: string;

  if (args["lootbox-root"] as string) {
    // Explicit flag takes priority
    lootboxRoot = args["lootbox-root"] as string;
    toolsDir = `${lootboxRoot}/tools`;
    workflowsDir = `${lootboxRoot}/workflows`;
    scriptsDir = `${lootboxRoot}/scripts`;
  } else if (config.lootboxRoot) {
    // Config file value
    lootboxRoot = config.lootboxRoot;
    toolsDir = `${lootboxRoot}/tools`;
    workflowsDir = `${lootboxRoot}/workflows`;
    scriptsDir = `${lootboxRoot}/scripts`;
  } else {
    // Check local .lootbox/tools first
    const localToolsDir = ".lootbox/tools";
    if (await exists(localToolsDir)) {
      lootboxRoot = ".lootbox";
      toolsDir = localToolsDir;
      workflowsDir = `${lootboxRoot}/workflows`;
      scriptsDir = `${lootboxRoot}/scripts`;
    } else {
      // Fallback to home directory
      const homeToolsDir = getUserLootboxToolsDir();
      if (await exists(homeToolsDir)) {
        lootboxRoot = dirname(homeToolsDir);
        toolsDir = homeToolsDir;
        workflowsDir = getUserLootboxWorkflowsDir();
        scriptsDir = getUserLootboxScriptsDir();
      } else {
        // Neither exists - show error and exit
        console.error("\n❌ No lootbox directory found!");
        console.error("\nLooked in:");
        console.error(`  • ${localToolsDir}`);
        console.error(`  • ${homeToolsDir}`);
        console.error("\n💡 Run 'lootbox init' to create a new lootbox project.\n");
        Deno.exit(1);
      }
    }
  }

  const portStr = (args.port as string) || config.port?.toString() || "3000";
  const lootboxDataDir =
    (args["lootbox-data-dir"] as string) || config.lootboxDataDir || null;
  const mcpServers = config.mcpServers || null;

  const port = parseInt(portStr, 10);
  if (isNaN(port)) {
    console.error("Error: --port must be a valid number");
    Deno.exit(1);
  }

  // Resolve timeout: CLI flag > config file > default (10000ms)
  const timeoutStr = args.timeout as string | undefined;
  let timeout = 10000;
  if (timeoutStr) {
    timeout = parseInt(timeoutStr, 10);
    if (isNaN(timeout) || timeout <= 0) {
      console.error("Error: --timeout must be a positive number (milliseconds)");
      Deno.exit(1);
    }
  } else if (config.timeout !== undefined) {
    timeout = config.timeout;
  }

  // Resolve sandbox: --no-sandbox flag > config file > default (true)
  let sandbox = true;
  if (args["no-sandbox"]) {
    sandbox = false;
  } else if (config.sandbox !== undefined) {
    sandbox = config.sandbox;
  }

  return {
    lootbox_root: lootboxRoot,
    tools_dir: toolsDir,
    workflows_dir: workflowsDir,
    scripts_dir: scriptsDir,
    port: port,
    lootbox_data_dir: lootboxDataDir,
    mcp_servers: mcpServers,
    timeout,
    sandbox,
  };
};
