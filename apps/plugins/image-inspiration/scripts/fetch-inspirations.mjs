import { execFileSync } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

const repo = "freestylefly/awesome-gpt-image-2";
const repoUrl = `https://github.com/${repo}`;
const commit = "0999cbfa1f860086db384602ee5ee5485671cb58";
const license = "MIT";
const templatePath = "data/style-library.json";
const upstream = `https://raw.githubusercontent.com/${repo}/${commit}`;
const output = new URL("../data/inspirations.json", import.meta.url);
const temporary = new URL(`inspirations.${process.pid}.tmp`, output);

// Only the project's own template recipes are licensed here. The community cases
// are collected from third parties under separate terms.
const CREDENTIAL_PATTERN =
  /(?:sk-(?:ant-)?|xai-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AIza|gsk_|hf_)[A-Za-z0-9_-]{19,}/;

const MAX_PROMPT_CHARS = 1800;

function curlText(url) {
  return execFileSync("curl", ["-q", "-fsS", "--connect-timeout", "8", "--max-time", "30", url], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function cleanText(value, maxChars) {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!maxChars || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

const LAYOUT_RULES = [
  [
    "grid",
    /\b(grid|2x2|3x3|4-panel|quadrant|multi-panel|contact sheet|bento)\b|九宫格|四宫格|分格/i,
  ],
  [
    "split-screen",
    /\b(split[- ]screen|before[- ]and[- ]after|side[- ]by[- ]side|comparison|diptych|two[- ]panel)\b|对比|分屏/i,
  ],
  ["storyboard", /\b(storyboard|comic|manga|sequential|frames?|panels?)\b|分镜|漫画/i],
  [
    "poster",
    /\b(poster|key visual|movie poster|editorial poster|cover art|magazine cover)\b|海报|封面/i,
  ],
  ["cover", /\b(cover|thumbnail|hero image|book cover|album cover|negative space)\b|封面|头图/i],
  ["banner", /\b(banner|ad creative|billboard|hero banner|promotional)\b|横幅|广告/i],
  [
    "infographic",
    /\b(infographic|diagram|chart|flowchart|timeline|exploded view|cutaway|anatomy|cheatsheet|map)\b|信息图|流程图|结构图|地图/i,
  ],
  [
    "ui-screen",
    /\b(ui|interface|dashboard|app screen|webpage|website|mobile screen|screenshot|hud)\b|界面|仪表盘|截图/i,
  ],
  [
    "card",
    /\b(card|trading card|tarot|ticket|badge|stamp|sticker|polaroid|postcard)\b|卡片|明信片|贴纸|拍立得/i,
  ],
  [
    "character-sheet",
    /\b(character sheet|turnaround|front view|side view|back view|expression sheet|reference sheet)\b|设定图|三视图/i,
  ],
  [
    "product-showcase",
    /\b(product photography|packaging|studio shot|e-?commerce|commercial product|bottle|cosmetic)\b|产品|电商|包装/i,
  ],
  ["isometric", /\b(isometric|diorama|miniature|cutaway room|3d cross[- ]section)\b|等距|微缩/i],
  ["flat-lay", /\b(flat[- ]lay|top[- ]down|overhead|knolling|bird'?s[- ]eye)\b|俯拍|平铺/i],
  [
    "portrait",
    /\b(portrait|headshot|close[- ]up|half[- ]body|editorial portrait|fashion portrait)\b|人像|肖像|特写/i,
  ],
  [
    "landscape",
    /\b(widescreen|16:9|panoramic|wide shot|landscape|cinematic wide)\b|横版|全景|风景/i,
  ],
  ["vertical", /\b(vertical|9:16|3:4|4:5|2:3|tall format)\b|竖版/i],
  ["collage", /\b(collage|scrapbook|moodboard|zine|editorial spread)\b|拼贴|杂志内页/i],
];

const EXTRA_STYLE_RULES = [
  ["Editorial", /\b(editorial|magazine|vogue|kinfolk|art direction)\b|杂志/i],
  ["Minimalist", /\b(minimalist|minimalism|clean negative space|swiss style|bauhaus)\b|极简/i],
  ["Anime", /\b(anime|manga|cel[- ]shaded|ghibli|ukiyo-e)\b|动漫|日漫|浮世绘/i],
  ["Watercolor", /\b(watercolor|gouache|ink wash|sumi-e|hand[- ]painted)\b|水彩|水墨/i],
  [
    "Vintage",
    /\b(vintage|retro|film grain|35mm|analog|kodak|nostalgic|1970s|1980s|1990s)\b|复古|胶片/i,
  ],
  ["Cinematic", /\b(cinematic|film still|dramatic lighting|chiaroscuro|anamorphic)\b|电影感/i],
  ["Typography", /\b(typography|lettering|calligraphy|kinetic type|bold headline)\b|字体|排版/i],
  [
    "Vector",
    /\b(flat vector|vector illustration|line art|doodle|pen-and-ink|sketch)\b|矢量|线稿|涂鸦/i,
  ],
  ["Cyberpunk", /\b(cyberpunk|neon|futuristic|sci-fi|synthwave)\b|赛博|霓虹|科幻/i],
];

function inferLayouts(text, defaults = []) {
  const found = [...defaults];
  for (const [label, pattern] of LAYOUT_RULES) {
    if (pattern.test(text)) found.push(label);
  }
  return uniqueStrings(found.length ? found : ["editorial"]);
}

function inferStyles(baseStyles, text) {
  const found = [...baseStyles];
  for (const [label, pattern] of EXTRA_STYLE_RULES) {
    if (pattern.test(text)) found.push(label);
  }
  return uniqueStrings(found);
}

function parseTemplates(styleLibrary) {
  if (!Array.isArray(styleLibrary.templates) || !styleLibrary.templates.length)
    throw new Error("Expected upstream style templates");
  const entries = [];

  for (const tpl of styleLibrary.templates) {
    const titleEn = cleanText(tpl.title?.en ?? tpl.id, 120);
    const titleZh = cleanText(tpl.title?.zh ?? "", 120);
    const descEn = cleanText(tpl.description?.en ?? "", 260);
    const descZh = cleanText(tpl.description?.zh ?? "", 260);
    const guidanceEn = Array.isArray(tpl.guidance?.en)
      ? tpl.guidance.en.map((g) => cleanText(g, 200))
      : [];
    const guidanceZh = Array.isArray(tpl.guidance?.zh)
      ? tpl.guidance.zh.map((g) => cleanText(g, 200))
      : [];
    const pitfallsEn = Array.isArray(tpl.pitfalls?.en)
      ? tpl.pitfalls.en.map((p) => cleanText(p, 200))
      : [];
    const useWhenEn = cleanText(tpl.useWhen?.en ?? "", 220);
    const promptBody = [
      `Style Template: ${titleEn}`,
      useWhenEn ? `Use when: ${useWhenEn}` : "",
      guidanceEn.length ? `Prompt recipe:\n- ${guidanceEn.join("\n- ")}` : "",
      pitfallsEn.length ? `Avoid:\n- ${pitfallsEn.join("\n- ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const combinedText = `${titleEn} ${titleZh} ${descEn} ${tpl.category ?? ""} ${(tpl.tags ?? []).join(" ")} ${promptBody}`;
    if (CREDENTIAL_PATTERN.test(combinedText)) continue;

    entries.push({
      id: `ff-tpl-${tpl.id}`,
      kind: "template",
      title: titleEn,
      ...(titleZh ? { titleZh } : {}),
      styles: inferStyles(tpl.styles ?? [], combinedText),
      layouts: inferLayouts(combinedText),
      themes: uniqueStrings([tpl.category, ...(tpl.scenes ?? [])]),
      tags: uniqueStrings([...(tpl.tags ?? []), ...(tpl.styles ?? []), ...(tpl.scenes ?? [])]),
      summary: cleanText(descZh ? `${descEn} / ${descZh}` : descEn, 220),
      prompt: cleanText(promptBody, MAX_PROMPT_CHARS),
      guidance: guidanceEn,
      ...(guidanceZh.length ? { guidanceZh } : {}),
      ...(pitfallsEn.length ? { pitfalls: pitfallsEn } : {}),
      sourceRepo: repoUrl,
      sourceUrl: `${repoUrl}/blob/${commit}/${templatePath}`,
      commit,
      license,
    });
  }

  return entries;
}

const normalize = (text) => text.trim().replace(/\s+/g, " ");
const bundledLicense = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
if (normalize(curlText(`${upstream}/LICENSE`)) !== normalize(bundledLicense))
  throw new Error("Upstream license differs from the bundled notice");

const items = parseTemplates(JSON.parse(curlText(`${upstream}/${templatePath}`))).filter(
  (entry) => !CREDENTIAL_PATTERN.test(JSON.stringify(entry)),
);
if (!items.length || new Set(items.map(({ id }) => id)).size !== items.length)
  throw new Error("Expected a non-empty catalog of unique template IDs");

const dataset = {
  schemaVersion: 1,
  sources: [{ name: repo, url: repoUrl, commit, license }],
  items,
};
try {
  await writeFile(temporary, `${JSON.stringify(dataset, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
console.log(`Wrote ${items.length} MIT templates from ${commit}`);
