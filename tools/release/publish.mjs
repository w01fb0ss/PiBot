#!/usr/bin/env node
// Publish a packaged release: installers (and the macOS update zips) go to the R2 bucket
// `pibot-releases` under `<downloadFolder>/`, served by the website Worker at
// https://pibot.space/downloads/<downloadFolder>/<file>.
//
// Supports two upload backends:
//   - R2 S3 API (recommended for CI and >300 MiB installers): set R2_ACCOUNT_ID,
//     R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (and optional R2_BUCKET=pibot-releases).
//   - Wrangler CLI fallback (<=300 MiB objects only): uses the caller's own Wrangler login.
//
// Usage:
//   node tools/release/publish.mjs [--web ../PiBot_web | --out-dir <dir>]
//     [--channel stable|rc] [--tag <folder>] [--dry-run] [--launch]
//     [--desktop-only] [--update-only] [--reuse-large-uploads] [--skip-verify]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertReleaseArtifact } from "../../apps/desktop/scripts/package/release-record.ts";
import {
  absoluteFeed,
  DOWNLOAD_ORIGIN,
  feedValue,
  formatFeed,
  parseFeed,
} from "../../apps/desktop/scripts/package/update-feed.ts";
import { androidFeed } from "./android-feed.mjs";
import { r2ConfigFromEnv, uploadR2Object, verifyPublicObject } from "./r2-s3.mjs";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const channel = option("--channel") ?? "stable";
if (channel !== "stable" && channel !== "rc") {
  throw new Error(`Unexpected --channel ${channel}; expected "stable" or "rc"`);
}
const outDirOption = option("--out-dir");
const outDir = outDirOption ? resolve(root, outDirOption) : undefined;
const webOption = option("--web");
const web = outDir ? (webOption ? resolve(root, webOption) : undefined) : resolve(root, webOption ?? "../PiBot_web");
const dryRun = args.includes("--dry-run");
const launch = args.includes("--launch");
const reuseLargeUploads = args.includes("--reuse-large-uploads");
const skipVerify = args.includes("--skip-verify");
// A desktop hotfix must not relabel an older phone or runner build as the new version.
const desktopOnly = args.includes("--desktop-only");
// --update-only: an urgent fix ships only as an in-app update.
const updateOnly = args.includes("--update-only");
if (updateOnly && launch) throw new Error("--update-only cannot be combined with --launch");
if (channel === "rc" && launch) {
  throw new Error("--launch cannot be combined with --channel rc (RC never moves website buttons)");
}

const version = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected version ${version}`);

const rawTag = option("--tag")?.replace(/^v/u, "");
const downloadFolder = rawTag || version;
if (channel === "rc" && !/^\d+\.\d+\.\d+-rc\.\d+$/u.test(downloadFolder)) {
  throw new Error(
    `RC channel requires --tag <version>-rc.<n> (got "${downloadFolder}"); keeps RC downloads isolated from stable`,
  );
}
if (channel === "stable" && downloadFolder !== version) {
  throw new Error(`Stable channel download folder (${downloadFolder}) must match version ${version}`);
}

// Maintainers 2026-11-13: every published version says what it changes. The app reads the feed's
// releaseNotes as JSON ({ zh: string[], en: string[] }, plain text lines; app-updater.ts).
const notesPath = join(root, "apps/desktop/release-notes", `${version}.json`);
if (!existsSync(notesPath)) throw new Error(`Missing release notes ${notesPath}`);
const notes = JSON.parse(readFileSync(notesPath, "utf8"));
for (const language of ["zh", "en"]) {
  const lines = notes[language];
  if (
    !Array.isArray(lines) ||
    !lines.length ||
    lines.length > 20 ||
    lines.some((line) => typeof line !== "string" || !line.trim() || line.length > 300)
  )
    throw new Error(`Release notes ${language}: 1–20 non-empty lines of at most 300 characters`);
}
// YAML single-quoted scalar on one line: the only escape is a doubled quote.
const releaseNotesYaml = `'${JSON.stringify({ zh: notes.zh, en: notes.en }).replaceAll("'", "''")}'`;
if (web && !existsSync(join(web, "public/releases.json"))) throw new Error(`No website at ${web}`);

const dist = join(root, "apps/desktop/dist/release");
// Only explicit --release builds enter this tree; never fall back to legacy/test dist/ files.
const locate = (folder, name) => [join(dist, folder, name)].find((path) => existsSync(path));
// Manifest key (AppReleaseSchema) → website button key → packaging folder → installer name.
const artifacts = [
  ["darwin-arm64", "mac-arm64", "mac-arm64", `PiBot-${version}-mac-arm64.dmg`],
  ["darwin-x64", "mac-x64", "mac-x64", `PiBot-${version}-mac-x64.dmg`],
  ["win32-x64", "windows", "win-x64", `PiBot-${version}-win-x64.exe`],
  ["linux-x64", "linux", "linux-x64", `PiBot-${version}-linux-x86_64.AppImage`],
  // Ubuntu 24.04+ needs the .deb's AppArmor profile. It is a download button only: installed apps
  // parse the manifest's downloads strictly, and its single linux-x64 entry stays the AppImage.
  [undefined, "linux-deb", "linux-x64", `PiBot-${version}-linux-amd64.deb`, "Linux · .deb"],
]
  .map(([platform, button, folder, name, label]) => ({ platform, button, folder, name, label }))
  .map((artifact) => ({ ...artifact, path: locate(artifact.folder, artifact.name) }))
  .filter((artifact) => artifact.path);
if (!artifacts.length) throw new Error(`No installers for ${version} in ${dist}`);
for (const artifact of artifacts)
  await assertReleaseArtifact(artifact.path, join(dist, artifact.folder), version);

async function sha512(body) {
  const hash = createHash("sha512");
  for await (const chunk of body) hash.update(chunk);
  return hash.digest("base64");
}

function retargetFeed(feed, fromFolder, toFolder) {
  if (fromFolder === toFolder) return feed;
  const fromPrefix = `${DOWNLOAD_ORIGIN}/${fromFolder}/`;
  const toPrefix = `${DOWNLOAD_ORIGIN}/${toFolder}/`;
  const rewrite = ([key, raw]) => {
    if (key !== "url" && key !== "path") return [key, raw];
    const unquoted = raw.replace(/^(['"])(.*)\1$/, "$2");
    return unquoted.startsWith(fromPrefix)
      ? [key, `${toPrefix}${unquoted.slice(fromPrefix.length)}`]
      : [key, raw];
  };
  return { top: feed.top.map(rewrite), files: feed.files.map((file) => file.map(rewrite)) };
}

// electron-updater feeds, one per update channel file; macOS merges both architectures (the
// updater picks the zip whose URL contains arm64 on Apple silicon, the other one on Intel).
const feedSources = {
  "latest.yml": ["win-x64"],
  "latest-mac.yml": ["mac-arm64", "mac-x64"],
  "latest-linux.yml": ["linux-x64"],
};
const uploads = new Map(
  artifacts
    .filter((artifact) => !(updateOnly && artifact.name.endsWith(".dmg")))
    .map((artifact) => [artifact.name, artifact.path]),
);
// An APK is advertised only when this release uploads it.
const apk = join(root, "apps/mobile/android/app/build/outputs/apk/release/app-release.apk");
const apkName = `PiBot-${version}-android.apk`;
let android;
if (!desktopOnly && !updateOnly && existsSync(apk)) {
  android = await androidFeed(
    apk,
    version,
    `${DOWNLOAD_ORIGIN}/${downloadFolder}/${apkName}`,
    process.env.AAPT,
  );
  uploads.set(apkName, apk);
}
const feeds = {};
for (const [name, folders] of Object.entries(feedSources)) {
  const parts = [];
  for (const folder of folders) {
    const path = locate(folder, name);
    if (!path) continue;
    const feed = retargetFeed(
      absoluteFeed(parseFeed(readFileSync(path, "utf8")), version),
      version,
      downloadFolder,
    );
    // dist/ may still hold another build's manifest; only this version's belongs here.
    if (feedValue(feed.top, "version") !== version) continue;
    // Both folders can fall back to the same dist/ manifest; the merge drops duplicate files.
    parts.push(feed);
  }
  if (!parts.length) continue;
  const [first, ...rest] = parts;
  const merged = { top: first.top, files: [...first.files] };
  for (const part of rest)
    for (const file of part.files)
      if (!merged.files.some((known) => feedValue(known, "url") === feedValue(file, "url")))
        merged.files.push(file);
  // An update-only release names no disk image: macOS updates install from the zip.
  if (updateOnly)
    merged.files = merged.files.filter((file) => !(feedValue(file, "url") ?? "").endsWith(".dmg"));
  // Every referenced file must be this release's, present locally and match its checksum.
  for (const file of merged.files) {
    const url = feedValue(file, "url") ?? "";
    const prefix = `${DOWNLOAD_ORIGIN}/${downloadFolder}/`;
    if (!url.startsWith(prefix)) throw new Error(`${name} points outside ${prefix}: ${url}`);
    const fileName = url.slice(prefix.length);
    const local = folders.map((folder) => locate(folder, fileName)).find(Boolean);
    if (!local) throw new Error(`${name} lists ${fileName}, which is not in ${dist}`);
    if (String(statSync(local).size) !== feedValue(file, "size"))
      throw new Error(`${fileName} size differs from ${name}`);
    if ((await sha512(createReadStream(local))) !== feedValue(file, "sha512"))
      throw new Error(`${fileName} checksum differs from ${name}`);
    await assertReleaseArtifact(local, resolve(local, ".."), version);
    uploads.set(fileName, local);
  }
  merged.top = [
    ...merged.top.filter(([key]) => key !== "releaseNotes"),
    ["releaseNotes", releaseNotesYaml],
  ];
  feeds[name] = formatFeed(merged);
}

// electron-updater fetches `<file>.blockmap` of both the installed and the new version to
// download only the changed blocks; without them every update is the full installer.
for (const [name, path] of [...uploads])
  if ((name.endsWith(".exe") || name.endsWith(".zip")) && existsSync(`${path}.blockmap`)) {
    await assertReleaseArtifact(`${path}.blockmap`, resolve(path, ".."), version);
    uploads.set(`${name}.blockmap`, `${path}.blockmap`);
  }

// Maintainers 2026-11-13: the runner ships next to the desktop and phone builds.
const runnerDist = join(root, "dist/runner");
const runnerFiles = desktopOnly
  ? []
  : [
      [
        "runner-windows",
        join(runnerDist, "installer", `Pi Bot Runner Setup ${version}.exe`),
        `PiBot-Runner-${version}-win-x64.exe`,
      ],
      [
        "runner-linux",
        join(runnerDist, "installer", `pibot-runner_${version}_amd64.deb`),
        `PiBot-Runner-${version}-linux-x64.deb`,
      ],
    ];
const prebuiltRunnerMacZip = join(runnerDist, `PiBot-Runner-${version}-mac-x64.zip`);
const runnerApp = join(runnerDist, "darwin-x64", "Pi Bot Runner.app");
const runnerAppVersion = () => {
  const plist = join(runnerApp, "Contents", "Info.plist");
  if (!existsSync(plist)) return undefined;
  if (process.platform !== "darwin") return undefined;
  const read = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", plist],
    { encoding: "utf8" },
  );
  return read.status === 0 ? read.stdout.trim() : undefined;
};
if (!desktopOnly && existsSync(prebuiltRunnerMacZip)) {
  runnerFiles.push(["runner-mac", prebuiltRunnerMacZip, `PiBot-Runner-${version}-mac-x64.zip`]);
} else {
  const runnerAppCurrent = !desktopOnly && existsSync(runnerApp) && runnerAppVersion() === version;
  if (!desktopOnly && existsSync(runnerApp) && !runnerAppCurrent)
    console.warn(
      `The runner-mac build is ${runnerAppVersion() ?? "of unknown version"}, not ${version}; its download stays as it is.`,
    );
  if (runnerAppCurrent) {
    if (!dryRun || !existsSync(prebuiltRunnerMacZip)) {
      // ditto keeps the bundle's symlinks and signature; a plain zip would break the app.
      const result = spawnSync(
        "/usr/bin/ditto",
        ["-c", "-k", "--keepParent", runnerApp, prebuiltRunnerMacZip],
        { stdio: "inherit" },
      );
      if (result.status !== 0) throw new Error(`zipping ${runnerApp} failed`);
    }
    runnerFiles.push(["runner-mac", prebuiltRunnerMacZip, `PiBot-Runner-${version}-mac-x64.zip`]);
  }
}
const runners = [];
for (const [button, path, name] of runnerFiles) {
  if (!existsSync(path)) {
    console.warn(`No ${button} build for ${version} (${path}); its download stays as it is.`);
    continue;
  }
  uploads.set(name, path);
  runners.push({ button, name });
}

const origin = DOWNLOAD_ORIGIN;
const r2S3 = r2ConfigFromEnv();
const wrangler = (command) => {
  console.log(`$ wrangler ${command.join(" ")}`);
  if (dryRun) return;
  if (!web) throw new Error("Wrangler fallback requires --web or R2 S3 credentials");
  const result = spawnSync("npx", ["wrangler", ...command], {
    cwd: web,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.status !== 0) throw new Error(`wrangler failed (${result.status})`);
};

function contentTypeFor(name) {
  return name.endsWith(".apk")
    ? "application/vnd.android.package-archive"
    : name.endsWith(".exe")
      ? "application/vnd.microsoft.portable-executable"
      : name.endsWith(".dmg")
        ? "application/x-apple-diskimage"
        : name.endsWith(".zip")
          ? "application/zip"
          : name.endsWith(".deb")
            ? "application/vnd.debian.binary-package"
            : "application/octet-stream";
}

const verificationReceipts = [];
for (const [name, path] of uploads) {
  const size = statSync(path).size;
  const key = `${downloadFolder}/${name}`;
  const url = `${origin}/${key}`;
  const type = contentTypeFor(name);

  if (r2S3) {
    if (dryRun) {
      console.log(`$ r2-s3 put ${r2S3.bucket}/${key} (${(size / (1024 * 1024)).toFixed(1)} MiB)`);
      continue;
    }
    if (reuseLargeUploads) {
      const existing = await verifyPublicObject({ filePath: path, url, size }).catch(() => ({
        ok: false,
      }));
      if (existing.ok) {
        console.log(`Verified existing R2 object: ${url} (${existing.verifiedBy})`);
        verificationReceipts.push({ name, url, size, ...existing });
        continue;
      }
    }
    await uploadR2Object({ config: r2S3, key, filePath: path, contentType: type });
    if (!skipVerify) {
      const verified = await verifyPublicObject({ filePath: path, url, size });
      if (!verified.ok) throw new Error(`Public R2 verification failed for ${url}`);
      console.log(`Verified uploaded R2 object: ${url} (${verified.verifiedBy})`);
      verificationReceipts.push({ name, url, size, ...verified });
    }
    continue;
  }

  const oversized = size > 300 * 1024 * 1024;
  if (oversized && !reuseLargeUploads)
    throw new Error(
      `${name} exceeds the Wrangler 300 MiB limit; set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY for automatic S3 multipart upload, or pass --reuse-large-uploads`,
    );
  if (reuseLargeUploads && !dryRun) {
    const existing = await verifyPublicObject({ filePath: path, url, size }).catch(() => ({
      ok: false,
    }));
    if (existing.ok) {
      console.log(`Verified staged upload: ${url} (${existing.verifiedBy})`);
      verificationReceipts.push({ name, url, size, ...existing });
      continue;
    }
    if (oversized) throw new Error(`The staged R2 object does not match ${name}`);
  } else if (oversized) {
    console.log(`Verify multipart upload: ${url}`);
    continue;
  }
  wrangler([
    "r2",
    "object",
    "put",
    `pibot-releases/${key}`,
    "--file",
    path,
    "--content-type",
    type,
    "--remote",
  ]);
  if (!dryRun && !skipVerify) {
    const verified = await verifyPublicObject({ filePath: path, url, size });
    if (!verified.ok) throw new Error(`Public R2 verification failed for ${url}`);
    verificationReceipts.push({ name, url, size, ...verified });
  }
}

const downloads = {};
for (const artifact of artifacts)
  if (artifact.platform) downloads[artifact.platform] = `${origin}/${downloadFolder}/${artifact.name}`;

const platformEntries = {};
if (android) {
  platformEntries.android = {
    url: android.url,
    label: "Android",
    detail: `v${version}`,
    version,
  };
}
for (const artifact of artifacts) {
  platformEntries[artifact.button] = {
    ...(artifact.label ? { label: artifact.label } : {}),
    url: `${origin}/${downloadFolder}/${artifact.name}`,
    detail: `v${version}`,
    version,
  };
}
for (const runner of runners) {
  platformEntries[runner.button] = {
    url: `${origin}/${downloadFolder}/${runner.name}`,
    detail: `v${version}`,
    version,
  };
}

const manifest = { version, ...(channel === "rc" ? { tag: downloadFolder } : {}), downloads };
const androidManifest = android ? JSON.stringify(android, null, 2) : undefined;
const updatesSubdir = channel === "rc" ? "updates/rc" : "updates";
const manifestName = channel === "rc" ? "rc.json" : "stable.json";

const generatedUpdateFiles = {};
if (!updateOnly) {
  generatedUpdateFiles[`${updatesSubdir}/${manifestName}`] = `${JSON.stringify(manifest, null, 2)}\n`;
}
for (const [name, text] of Object.entries(feeds)) {
  generatedUpdateFiles[`${updatesSubdir}/${name}`] = text;
}
if (androidManifest) {
  generatedUpdateFiles[`${updatesSubdir}/android.json`] = `${androidManifest}\n`;
}

console.log(JSON.stringify(manifest, null, 2));
if (androidManifest) console.log(`--- ${updatesSubdir}/android.json\n${androidManifest}`);
for (const [name, text] of Object.entries(feeds)) console.log(`--- ${updatesSubdir}/${name}\n${text}`);
if (!Object.keys(feeds).length)
  console.warn("No update feeds for this version; in-app updates will not see it.");

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const [relPath, content] of Object.entries(generatedUpdateFiles)) {
    const dest = join(outDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  const toMB = (filePath) => (filePath ? Math.round(statSync(filePath).size / (1024 * 1024)) : null);
  const macZip =
    locate("mac-arm64", `PiBot-${version}-mac-arm64.zip`) ??
    locate("mac-x64", `PiBot-${version}-mac-x64.zip`);
  const winExe = locate("win-x64", `PiBot-${version}-win-x64.exe`);
  const updatedComponents = [
    "desktop",
    ...(android ? ["android"] : []),
    ...(runners.length ? ["runner"] : []),
  ];
  const dispatchPayload = {
    channel,
    version,
    downloadFolder,
    launch: channel === "stable" && launch,
    updateOnly,
    updatedComponents,
    sizesMB: {
      mac: toMB(macZip),
      windows: toMB(winExe),
    },
    releaseNotes: { zh: notes.zh, en: notes.en },
    platforms: platformEntries,
    files: generatedUpdateFiles,
  };
  writeFileSync(
    join(outDir, "web-dispatch.json"),
    `${JSON.stringify(dispatchPayload, null, 2)}\n`,
  );
  if (verificationReceipts.length) {
    writeFileSync(
      join(outDir, "cloudflare-verification.json"),
      `${JSON.stringify(verificationReceipts, null, 2)}\n`,
    );
  }
  console.log(`Wrote release feeds and web-dispatch.json to ${outDir}`);
}

if (!dryRun && web) {
  if (launch && channel === "stable") {
    const releases = JSON.parse(readFileSync(join(web, "public/releases.json"), "utf8"));
    releases.status = "available";
    releases.version = version;
    for (const [button, entry] of Object.entries(platformEntries)) {
      const previous = releases.platforms[button];
      releases.platforms[button] = {
        ...previous,
        ...entry,
        ...(previous?.version !== version ? { status: "testing" } : {}),
      };
    }
    writeFileSync(join(web, "public/releases.json"), `${JSON.stringify(releases, null, 2)}\n`);
  }
  for (const [relPath, content] of Object.entries(generatedUpdateFiles)) {
    const dest = join(web, "public", relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  console.log(
    `Wrote ${launch && channel === "stable" ? "releases.json and " : ""}${Object.keys(generatedUpdateFiles).join(", ")} in ${web}; deploy the website next.`,
  );
}
