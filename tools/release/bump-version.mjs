#!/usr/bin/env node
// Bumps the Pi Bot release version across all shipped app manifests and scaffolds
// apps/desktop/release-notes/<version>.json if it does not exist yet.
//
//   node tools/release/bump-version.mjs 0.1.1
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const version = process.argv[2]?.trim();

if (!version || !/^(0|[1-9]\d?)\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/u.test(version)) {
  console.error("Usage: node tools/release/bump-version.mjs <major.minor.patch>");
  console.error("Each version component must be 0..99 (required by mobile build-number encoding).");
  process.exit(1);
}

const manifests = [
  "package.json",
  "apps/desktop/package.json",
  "apps/mobile/package.json",
  "apps/runner/package.json",
];

for (const relative of manifests) {
  const full = join(root, relative);
  const raw = readFileSync(full, "utf8");
  const updated = raw.replace(/("version":\s*)"[^"]+"/u, `$1"${version}"`);
  if (updated === raw) {
    console.log(`unchanged: ${relative} (already ${version})`);
  } else {
    writeFileSync(full, updated);
    console.log(`updated:   ${relative} -> ${version}`);
  }
}

const notesPath = join(root, "apps/desktop/release-notes", `${version}.json`);
if (!existsSync(notesPath)) {
  const template = {
    zh: [`v${version} 更新内容（发布前请替换为简洁的中文要点，最多 20 条，每条不超过 300 字）。`],
    en: [
      `v${version} changes (replace with concise English highlights before release; 1-20 lines, max 300 chars each).`,
    ],
  };
  writeFileSync(notesPath, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`created:   apps/desktop/release-notes/${version}.json`);
} else {
  console.log(`exists:    apps/desktop/release-notes/${version}.json`);
}

console.log(`\nNext steps:`);
console.log(`  1. Edit apps/desktop/release-notes/${version}.json`);
console.log(`  2. Run pnpm verify`);
console.log(`  3. Sync public repo: pnpm release:sync-public --dry-run`);
console.log(`  4. Push tag v${version}-rc.1 (RC) or v${version} (stable) to trigger GitHub Actions`);
