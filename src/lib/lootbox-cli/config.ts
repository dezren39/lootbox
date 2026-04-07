import type { Config } from "./types.ts";
import { DEFAULT_CONFIG_FILENAME } from "../constants.ts";

/**
 * Load the lootbox configuration file.
 *
 * If `path` is provided it is used directly; otherwise falls back to
 * the default filename in the current working directory.
 * Returns an empty Config object when the file is absent (unless an
 * explicit path was given, in which case the process exits with an
 * error).
 */
export async function loadConfig(path?: string): Promise<Config> {
  const filePath = path || DEFAULT_CONFIG_FILENAME;
  try {
    const configText = await Deno.readTextFile(filePath);
    return JSON.parse(configText) as Config;
  } catch {
    if (path) {
      console.error(`Error: could not read config file: ${filePath}`);
      Deno.exit(1);
    }
    return {};
  }
}
