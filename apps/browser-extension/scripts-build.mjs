import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

for (const browser of ["chrome", "firefox"]) {
  const out = `dist/${browser}`;
  await mkdir(out, { recursive: true });
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  const result = await build({
    entryPoints: ["src/background.ts", "src/content.ts", "src/popup.ts"],
    bundle: true,
    format: "iife",
    outdir: out,
    platform: "browser",
    target: "es2022",
    // Stated here rather than read from the repository's tsconfig, so the source package Mozilla
    // rebuilds from (scripts-source.mjs) gives the same output without the workspace around it.
    tsconfigRaw: { compilerOptions: { alwaysStrict: true } },
    write: false,
    define: {
      __PIBOT_BROWSER__: JSON.stringify(browser),
      __PIBOT_VERSION__: JSON.stringify(manifest.version),
    },
  });
  for (const file of result.outputFiles)
    await writeFile(
      file.path,
      // esbuild names each bundled module's path in a comment; pnpm and npm lay node_modules
      // out differently, so the comments go and the same sources give the same bytes.
      file.text.replace(/^[ \t]*\/\/ (?:\.\.\/)*(?:node_modules|packages|src)\/[^\n]*\n/gm, ""),
    );
  if (browser === "firefox") {
    manifest.background = { scripts: ["background.js"] };
    // `key` pins the Chrome extension id; Firefox identifies the add-on by its gecko id instead.
    delete manifest.key;
    // Mozilla requires new add-ons to declare data collection. Pages a Bot reads and the
    // addresses it visits go to the Pi Bot app on this computer (and from there to the model
    // provider the user chose), so both are declared; nothing else leaves the browser.
    manifest.browser_specific_settings.gecko.data_collection_permissions = {
      required: ["websiteContent", "websiteActivity"],
    };
    // Listed on addons.mozilla.org, which delivers updates itself and refuses an update_url.
  } else {
    // Firefox's gecko id means nothing to Chrome or Edge, which warn about it.
    delete manifest.browser_specific_settings;
  }
  await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
  await writeFile(`${out}/popup.html`, await readFile("popup.html"));
  await writeFile(`${out}/popup.css`, await readFile("popup.css"));
  // The app's theme tokens, so the popup uses the same colours, fonts and radii in both themes.
  await writeFile(`${out}/tokens.css`, await readFile("../../packages/ui/src/theme/tokens.css"));
  // The app's own icon (apps/desktop/build/icons), so the toolbar shows the same Pi Bot.
  await cp("_locales", `${out}/_locales`, { recursive: true });
  await cp("icons", `${out}/icons`, { recursive: true });
}
