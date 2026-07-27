import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const image = process.argv[2];
if (!image) {
  throw new Error(
    "Uso: node scripts/smoke-test-image.mjs <nome-immagine>",
  );
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const containerName = `plex-mcp-smoke-${suffix}`;
const tempDirectory = mkdtempSync(
  path.join(tmpdir(), "plex-mcp-image-smoke-"),
);
const configPath = path.join(tempDirectory, "config.json");

const config = {
  mcpProxy: {
    baseURL: "http://127.0.0.1:19090",
    addr: ":19090",
    name: "Plex MCP image smoke test",
    version: "1.0.0",
    type: "streamable-http",
    options: {
      panicIfInvalid: true,
      logEnabled: true,
    },
  },
  mcpServers: {
    plex: {
      command: "node",
      args: ["/opt/plex-mcp-server/build/plex-mcp-server.js"],
      env: {
        PLEX_URL: "http://127.0.0.1:32400",
        PLEX_TOKEN: "smoke-test-token",
      },
      options: {
        panicIfInvalid: true,
        logEnabled: true,
      },
    },
  },
};

writeFileSync(configPath, JSON.stringify(config, null, 2));

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function dockerWithInput(args, input) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function waitForStableContainer() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const running = docker([
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]);
    if (running !== "true") {
      throw new Error(`Il container si è arrestato:\n${docker([
        "logs",
        containerName,
      ])}`);
    }
  }
}

function jsonRpcResponses(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function verifyTriliumSchema(output) {
  const response = jsonRpcResponses(output).find(
    (entry) => entry.id === 2,
  );
  if (!response || response.error) {
    throw new Error(`tools/list Trilium non riuscito: ${output}`);
  }
  const tools = response.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("tools/list Trilium non contiene tools");
  }
  const search = tools.find((tool) => tool.name === "search_notes");
  if (!search) {
    throw new Error("search_notes assente dal binario Trilium incorporato");
  }
  const properties = search.inputSchema?.properties;
  const orderBy = properties?.order_by?.enum;
  const direction = properties?.order_direction?.enum;
  if (
    JSON.stringify(orderBy) !==
      JSON.stringify(["dateModified", "utcDateModified"]) ||
    JSON.stringify(direction) !== JSON.stringify(["asc", "desc"])
  ) {
    throw new Error(
      `schema search_notes inatteso: ${JSON.stringify(properties)}`,
    );
  }
}

try {
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "image-smoke", version: "1.0.0" },
    },
  });
  const initialized = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const toolsList = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  const triliumOutput = dockerWithInput(
    [
      "run",
      "--rm",
      "--interactive",
      "--env",
      "TRILIUM_URL=http://127.0.0.1:9999",
      "--env",
      "TRILIUM_TOKEN=smoke-test-token",
      "--entrypoint",
      "/usr/local/bin/trilium-mcp",
      image,
    ],
    `${initialize}\n${initialized}\n${toolsList}\n`,
  );
  verifyTriliumSchema(triliumOutput);

  docker([
    "run",
    "--detach",
    "--name",
    containerName,
    "--volume",
    `${configPath}:/config/config.json:ro`,
    image,
  ]);

  await waitForStableContainer();

  docker([
    "exec",
    containerName,
    "sh",
    "-ec",
    [
      "test -x /main",
      "test -x /usr/local/bin/trilium-mcp",
      "test -f /opt/plex-mcp-server/build/plex-mcp-server.js",
      "test -d /opt/plex-mcp-server/node_modules",
      "cd /opt/plex-mcp-server",
      "node --check build/plex-mcp-server.js",
      'node -e "import(\'@modelcontextprotocol/sdk/server/index.js\')"',
    ].join(" && "),
  ]);

  console.log(`Smoke test superato per ${image}`);
} catch (error) {
  let logs = "";
  try {
    logs = docker(["logs", containerName]);
  } catch {
    // Il container potrebbe non essere stato creato.
  }
  if (logs) console.error(logs);
  throw error;
} finally {
  try {
    docker(["rm", "--force", containerName]);
  } catch {
    // Nessun container da rimuovere.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
}
