import { imageQualityPromptPrompts } from "./prompts/image-quality-prompt.ts";

/** Keep whole lines of the Bot's norms within the space left by the request. */
function normsSection(norms: string | undefined, label: string, budget: number) {
  if (!norms || budget <= label.length) return "";
  const kept: string[] = [];
  let length = label.length;
  for (const raw of norms.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (length + line.length + 1 > budget) break;
    kept.push(line);
    length += line.length + 1;
  }
  return kept.length ? [label, ...kept].join("\n") : "";
}

/** The image API receives one prompt. Lead with the request and keep guidance secondary. */
export function imageQualityPrompt(request: string, language: "zh" | "en", norms?: string) {
  const quality = imageQualityPromptPrompts.QUALITY[language];
  const guidance = request.length > quality.length + 2 ? quality : "";
  const extra = normsSection(
    norms,
    imageQualityPromptPrompts.normsSection[language],
    Math.min(64, Math.floor(request.length / 2) - guidance.length - 4),
  );
  const text = [request, guidance, extra].filter(Boolean).join("\n\n");
  return {
    text,
    lengths: {
      promptChars: text.length,
      requestChars: request.length,
      normsChars: extra.length,
      guidanceChars: guidance.length,
    },
  };
}
