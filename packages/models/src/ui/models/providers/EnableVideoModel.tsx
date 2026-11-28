import type { BuiltinVideoCatalogModel, BuiltinVideoProviderId } from "@pibot/models-contract/full";
import { setupStyles as styles, TaskStatus, useRpc, useT, useTask } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { requirePeer } from "../../setup/operations.ts";
import detailStyles from "./provider-detail.module.css";

export function VideoModelPrice({ model }: { model: BuiltinVideoCatalogModel }) {
  const t = useT();
  const usd = (amount: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 6,
    }).format(amount);
  const rates = Object.entries(model.priceUsdPerSecondBySize ?? {});
  const price =
    model.priceUsdPerClip !== undefined
      ? t("video.catalogPricePerClip", { price: usd(model.priceUsdPerClip) })
      : model.priceUsdPerSecond !== undefined
        ? t("video.catalogPricePerSecond", { price: usd(model.priceUsdPerSecond) })
        : rates.length
          ? rates
              .map(
                ([size, amount]) =>
                  t("video.catalogPricePerSecond", { price: usd(amount) }) + ` (${size})`,
              )
              .join(" · ")
          : undefined;
  return (
    <small className={styles.note}>
      {price === undefined
        ? t("video.catalogPriceUnknown")
        : model.cachedPricing
          ? t("video.catalogPriceCached", { price })
          : price}
    </small>
  );
}

export function EnableVideoModel({
  providerId,
  model,
  disabled,
}: {
  providerId: BuiltinVideoProviderId;
  model: BuiltinVideoCatalogModel;
  disabled?: boolean;
}) {
  const t = useT();
  const { peer } = useRpc();
  const task = useTask();
  return (
    <div className={styles.stack}>
      <div className={detailStyles.switchRow}>
        <span>
          {model.id}
          <br />
          <VideoModelPrice model={model} />
        </span>
        <Button
          variant="secondary"
          disabled={!peer || disabled || task.busy || !!task.success}
          onClick={() =>
            void task.run(async () => {
              await requirePeer(peer).call("providers.setVideoModel", {
                providerId,
                modelId: model.id,
                enabled: true,
              });
              task.setSuccess(t("video.modelEnabled"));
            })
          }
        >
          {t("video.enableModel")}
        </Button>
      </div>
      <TaskStatus task={task} />
    </div>
  );
}
