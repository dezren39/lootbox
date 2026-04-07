/**
 * McpIntegrationManager
 *
 * Manages MCP (Model Context Protocol) integration.
 * Handles:
 * - MCP client lifecycle via McpClientManager
 * - Health monitoring via McpHealthMonitor
 * - Schema fetching via McpSchemaFetcher
 * - MCP tool and resource calls
 * - Providing schemas to type generation
 */

import { McpClientManager, type McpServerHealth } from "../../external-mcps/mcp_client_manager.ts";
import type { McpConfigFile } from "../../external-mcps/mcp_config.ts";
import {
  McpHealthMonitor,
  type McpHealthGlobalDefaults,
} from "../../external-mcps/mcp_health_monitor.ts";
import { McpSchemaFetcher } from "../../external-mcps/mcp_schema_fetcher.ts";
import type { McpServerSchemas } from "../../external-mcps/mcp_schema_fetcher.ts";
import { executeMcpResource, executeMcpTool } from "../execute_mcp.ts";

/** Overall MCP subsystem health status for the deep health endpoint. */
export interface McpHealthStatus {
  status: "ok" | "degraded" | "unhealthy";
  servers: Record<string, McpServerHealth>;
}

export class McpIntegrationManager {
  private state: {
    clientManager: McpClientManager;
    schemaFetcher: McpSchemaFetcher;
    healthMonitor: McpHealthMonitor;
    mcpConfig: McpConfigFile;
  } | null = null;

  /**
   * Initialize MCP integration with provided configuration.
   *
   * @param mcpConfig        Parsed MCP server configuration.
   * @param mcpClientName    Identity string sent to MCP servers.
   * @param healthDefaults   Global health-check defaults from resolved config.
   */
  async initialize(
    mcpConfig: McpConfigFile,
    mcpClientName?: string,
    healthDefaults?: McpHealthGlobalDefaults,
  ): Promise<void> {
    console.error("Initializing MCP integration...");

    const clientManager = new McpClientManager(mcpClientName ?? "lootbox");
    await clientManager.initializeClients(mcpConfig.mcpServers);

    const schemaFetcher = new McpSchemaFetcher();
    for (const serverName of clientManager.getConnectedServerNames()) {
      const client = clientManager.getClient(serverName);
      if (client) {
        await schemaFetcher.fetchSchemas(client, serverName);
      }
    }

    // Set up health monitoring
    const defaults: McpHealthGlobalDefaults = healthDefaults ?? {
      checkInterval: 30_000,
      maxReconnectAttempts: 5,
      reconnectBackoffBase: 2_000,
      maxReconnectBackoff: 60_000,
      checkTimeout: 5_000,
    };
    const healthMonitor = new McpHealthMonitor(clientManager, defaults);

    // When a server reconnects, automatically re-fetch its schemas
    healthMonitor.onEvent(async (event) => {
      if (event.type === "server:reconnected") {
        const client = clientManager.getClient(event.serverName);
        if (client) {
          try {
            await schemaFetcher.fetchSchemas(client, event.serverName);
            console.error(
              `[McpIntegrationManager] Re-fetched schemas for ${event.serverName} after reconnect`,
            );
          } catch (err) {
            console.error(
              `[McpIntegrationManager] Failed to re-fetch schemas for ${event.serverName}:`,
              err,
            );
          }
        }
      }
    });

    // Start monitoring (uses per-server health configs from the McpConfigFile)
    healthMonitor.start(mcpConfig.mcpServers);

    this.state = { clientManager, schemaFetcher, healthMonitor, mcpConfig };
    console.error("MCP integration initialized successfully");
  }

  /**
   * Shutdown MCP integration and disconnect all clients
   */
  async shutdown(): Promise<void> {
    if (this.state) {
      this.state.healthMonitor.stop();
      await this.state.clientManager.disconnectAll();
      this.state = null;
      console.error("MCP integration shut down");
    }
  }

  /**
   * Handle MCP tool or resource call
   * Method format: mcp_ServerName.operationName
   * Resource operations start with "resource_"
   */
  async handleMcpCall(
    method: string,
    args: unknown,
    rpcTimeout?: number,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    if (!this.state) {
      return {
        success: false,
        error: "MCP is not initialized",
      };
    }

    // Parse method: mcp_ServerName.operationName
    const parts = method.split(".");
    if (parts.length !== 2) {
      return {
        success: false,
        error: `Invalid MCP method format: ${method}`,
      };
    }

    const serverNameWithPrefix = parts[0]; // mcp_ServerName
    const operationName = parts[1];

    // Remove mcp_ prefix to get actual server name
    if (!serverNameWithPrefix.startsWith("mcp_")) {
      return {
        success: false,
        error: `Invalid MCP method format: ${method}`,
      };
    }

    const serverName = serverNameWithPrefix.substring(4); // Remove "mcp_"

    // Check if it's a resource call (starts with resource_)
    if (operationName.startsWith("resource_")) {
      const resourceName = operationName.substring(9); // Remove "resource_"
      return await executeMcpResource(
        this.state.clientManager,
        this.state.schemaFetcher,
        serverName,
        resourceName,
        args,
        rpcTimeout,
      );
    } else {
      // It's a tool call
      return await executeMcpTool(
        this.state.clientManager,
        this.state.schemaFetcher,
        serverName,
        operationName,
        args,
        rpcTimeout,
      );
    }
  }

  /**
   * Get all MCP schemas for type generation
   */
  async getSchemas(): Promise<McpServerSchemas[]> {
    if (!this.state) {
      return [];
    }
    const schemas: McpServerSchemas[] = [];
    for (
      const serverName of this.state.clientManager.getConnectedServerNames()
    ) {
      const client = this.state.clientManager.getClient(serverName);
      if (client) {
        schemas.push(
          await this.state.schemaFetcher.fetchSchemas(client, serverName),
        );
      }
    }
    return schemas;
  }

  /**
   * Get list of connected MCP server names
   */
  getConnectedServers(): string[] {
    if (!this.state) {
      return [];
    }
    return this.state.clientManager.getConnectedServerNames();
  }

  /**
   * Check if MCP integration is enabled
   */
  isEnabled(): boolean {
    return this.state !== null;
  }

  /**
   * Get the aggregate MCP health status for the deep health endpoint.
   *
   * Returns per-server health snapshots and an overall status:
   *   "ok"        — all servers connected
   *   "degraded"  — some servers unhealthy/reconnecting but at least one is connected
   *   "unhealthy" — all servers are down
   */
  getHealthStatus(): McpHealthStatus {
    if (!this.state) {
      return { status: "ok", servers: {} };
    }

    const servers = this.state.clientManager.getServerHealth();
    const names = Object.keys(servers);

    if (names.length === 0) {
      return { status: "ok", servers };
    }

    const connectedCount = names.filter(
      (n) => servers[n].status === "connected",
    ).length;

    let status: "ok" | "degraded" | "unhealthy";
    if (connectedCount === names.length) {
      status = "ok";
    } else if (connectedCount > 0) {
      status = "degraded";
    } else {
      status = "unhealthy";
    }

    return { status, servers };
  }
}
