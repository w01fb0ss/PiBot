import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const outDir = "dist/image-inspiration-plugin";
await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, ".claude-plugin"), { recursive: true });
await cp(".claude-plugin/plugin.json", join(outDir, ".claude-plugin", "plugin.json"));
for (const file of ["README.md", "LICENSE", "NOTICE"]) {
  await cp(file, join(outDir, file));
}

await writeFile(
  join(outDir, ".mcp.json"),
  `${JSON.stringify(
    {
      mcpServers: {
        "image-inspiration": {
          command: "node",
          args: [`\${CLAUDE_PLUGIN_ROOT}/server.mjs`],
          env: {},
          networkDomains: [],
        },
      },
    },
    null,
    2,
  )}\n`,
);

function splitFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) return { frontmatter: "", body: markdown.trim() };
  return { frontmatter: match[1] ?? "", body: (match[2] ?? "").trim() };
}

function field(frontmatter, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
  if (!match?.[1]) return "";
  return match[1].trim().replace(/^"(.*)"$/, "$1");
}

for (const entry of await readdir("skills", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const target = join(outDir, "skills", entry.name);
  await mkdir(target, { recursive: true });
  const zh = splitFrontmatter(await readFile(join("skills", entry.name, "zh", "SKILL.md"), "utf8"));
  const en = splitFrontmatter(await readFile(join("skills", entry.name, "en", "SKILL.md"), "utf8"));
  const description = `${field(en.frontmatter, "description")} / ${field(zh.frontmatter, "description")}`;
  const combined = `---\nname: ${entry.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${en.body}\n\n---\n\n${zh.body}\n`;
  await writeFile(join(target, "SKILL.md"), combined);
}

await build({
  entryPoints: ["server/index.ts"],
  outfile: join(outDir, "server.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
