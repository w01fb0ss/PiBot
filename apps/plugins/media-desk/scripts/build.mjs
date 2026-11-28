import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = "dist/media-desk-plugin";
await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, ".claude-plugin"), { recursive: true });
await cp(".claude-plugin/plugin.json", join(outDir, ".claude-plugin", "plugin.json"));
for (const file of ["README.md", "LICENSE", "NOTICE"]) {
  await cp(file, join(outDir, file));
}

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
  const combined = `---\nname: ${entry.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${en.body.replaceAll("`style-presets.md`", "`en/style-presets.md`")}\n\n---\n\n${zh.body.replaceAll("`style-presets.md`", "`zh/style-presets.md`")}\n`;
  await writeFile(join(target, "SKILL.md"), combined);
  for (const locale of ["zh", "en"]) {
    const dir = join("skills", entry.name, locale);
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (!file.isFile() || file.name === "SKILL.md") continue;
      await mkdir(join(target, locale), { recursive: true });
      await cp(join(dir, file.name), join(target, locale, file.name));
    }
  }
}
