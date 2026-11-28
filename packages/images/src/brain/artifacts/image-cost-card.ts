import type {
  ApprovalFact,
  ImageGenerationOptions,
  ImageMode,
  ImageModelInfo,
  ImageUnitPrice,
} from "@pibot/images-contract/full";
import { mediaEn, mediaZh } from "@pibot/images-contract/i18n";

export function imageCostCard(
  options: ImageGenerationOptions,
  count: number,
  models: ImageModelInfo[],
  mode: ImageMode,
  referenceCount: number,
) {
  const requestsPerModel = options.kind === "batch" ? count : 1;
  const estimates = models.map((model) => {
    const price = mode === "image-to-image" ? model.editPrice : model.generationPrice;
    const amount =
      price && (price.perImage + (price.perReference ?? 0) * referenceCount) * requestsPerModel;
    return { model, price, amount: model.workflowOutput ? undefined : amount };
  });
  const workflowRequests = models.filter((model) => model.workflowOutput).length * requestsPerModel;
  return (language: "zh" | "en") => {
    const text = language === "zh" ? mediaZh : mediaEn;
    const money = (currency: ImageUnitPrice["currency"], amount: number) =>
      new Intl.NumberFormat(language, {
        style: "currency",
        currency,
        currencyDisplay: "code",
        maximumFractionDigits: 6,
      }).format(amount);
    const totals = new Map<ImageUnitPrice["currency"], number>();
    let allKnown = true;
    const facts: ApprovalFact[] = estimates.map(({ model, price, amount }) => {
      let cost: string = text["media.multi.costUnknown"];
      if (price && amount !== undefined && Number.isFinite(amount)) {
        cost = money(price.currency, amount);
        totals.set(price.currency, (totals.get(price.currency) ?? 0) + amount);
      } else allKnown = false;
      return {
        kind: "warning",
        label: language === "zh" ? "模型" : "Model",
        value: [
          model.name,
          model.id,
          model.origin ?? model.recipient,
          model.size,
          model.aspectRatio,
          cost,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });
    if (workflowRequests)
      facts.push({
        kind: "warning",
        label: text["media.multi.workflowCount"],
        value: String(workflowRequests),
      });
    if (count > workflowRequests)
      facts.push({
        kind: "warning",
        label: text["media.multi.imageCount"],
        value: String(count - workflowRequests),
      });
    if (options.size)
      facts.push({ kind: "warning", label: text["media.multi.size"], value: options.size });
    if (options.ratio)
      facts.push({ kind: "warning", label: text["media.multi.ratio"], value: options.ratio });
    facts.push({
      kind: "warning",
      label: text["media.multi.cost"],
      value: allKnown
        ? [...totals].map(([currency, amount]) => money(currency, amount)).join(" + ")
        : text["media.multi.costUnknown"],
    });
    return {
      title: text[`media.${options.kind}.title`],
      lead: text["media.multi.send"],
      facts,
    };
  };
}
