// Prepares deterministic fake demo inputs and an isolated Pi Bot data directory for v0.1.0.
// Usage: node tools/demo-data/make.ts <empty-dir>
import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateChatGptExport } from "./chatgpt.ts";
import { generateLocalAgentFixtures } from "./local-agents.ts";
import { generateShopRepo } from "./shop-repo.ts";

function usage(): string {
  return [
    "Usage: node tools/demo-data/make.ts <empty-dir>",
    "",
    "Prepares deterministic fake inputs and an isolated empty PIBOT_DATA_DIR:",
    "  <dir>/chatgpt-export/chatgpt-export.zip   40 fake ChatGPT conversations + memories + custom instructions",
    "  <dir>/codex-home/                         8 fake Codex rollout sessions + memories/MEMORY.md (CODEX_HOME)",
    "  <dir>/claude-config/                      6 fake Claude Code sessions + memory/*.md (CLAUDE_CONFIG_DIR)",
    "  <dir>/shop/                               fake TypeScript git repo (~shop) with README.md & AGENTS.md",
    "  <dir>/pibot-data/                         isolated empty Pi Bot data directory (no hand-written SQLite)",
    "  <dir>/manifest.json                       generated paths, counts and launch environment variables",
  ].join("\n");
}

async function ensureEmptyTarget(rawDir: string): Promise<string> {
  const target = resolve(rawDir);
  let exists = false;
  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      throw new Error(`Target exists and is not a directory: ${target}`);
    }
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (exists) {
    const entries = await readdir(target);
    if (entries.length > 0) {
      throw new Error(
        `Target directory must be empty (${entries.length} existing entries): ${target}`,
      );
    }
  } else {
    await mkdir(target, { recursive: true });
  }
  return realpath(target);
}

export async function makeDemoData(rawDir: string) {
  const root = await ensureEmptyTarget(rawDir);

  // Isolated Pi Bot data dir (0700). Never writes SQLite directly — Pi Bot initializes it on launch.
  const pibotDataDir = join(root, "pibot-data");
  await mkdir(pibotDataDir, { recursive: true, mode: 0o700 });

  const shop = await generateShopRepo(root);
  const [chatgpt, localAgents] = await Promise.all([
    generateChatGptExport(root),
    generateLocalAgentFixtures(root, shop.shopPath),
  ]);

  const manifest = {
    version: "0.1.0-demo",
    deterministic: true,
    root,
    env: {
      PIBOT_DATA_DIR: pibotDataDir,
      CODEX_HOME: localAgents.codexHome,
      CLAUDE_CONFIG_DIR: localAgents.claudeConfigDir,
    },
    artifacts: {
      pibotDataDir,
      shopRepo: shop,
      chatgptExport: chatgpt,
      localAgents,
    },
    commands: {
      launchDev: `PIBOT_DATA_DIR=${JSON.stringify(pibotDataDir)} CODEX_HOME=${JSON.stringify(localAgents.codexHome)} CLAUDE_CONFIG_DIR=${JSON.stringify(localAgents.claudeConfigDir)} pnpm dev`,
      driveStates: `node tools/demo-data/drive.ts ${JSON.stringify(root)}`,
    },
  };

  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, manifest };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length !== 1 || !positionals[0]) {
    console.log(usage());
    process.exit(values.help ? 0 : 1);
  }
  const { manifestPath, manifest } = await makeDemoData(positionals[0]);
  console.log(
    JSON.stringify(
      {
        ok: true,
        manifest: manifestPath,
        env: manifest.env,
        counts: {
          chatgptConversations: manifest.artifacts.chatgptExport.conversations,
          chatgptMemories: manifest.artifacts.chatgptExport.memories,
          codexSessions: manifest.artifacts.localAgents.codexSessions,
          claudeSessions: manifest.artifacts.localAgents.claudeSessions,
          shopFiles: manifest.artifacts.shopRepo.files,
          shopHeadCommit: manifest.artifacts.shopRepo.headCommit,
        },
        nextSteps: [
          "1. Launch an isolated test copy with the env vars above (see tools/demo-data/README.md).",
          `2. Drive historical demo states via RPC: ${manifest.commands.driveStates}`,
        ],
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
