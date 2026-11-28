import {
  type Bot,
  type BotCategory,
  type BuiltinRoleView,
  type ModelPreference,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import {
  actionError,
  avatarColors,
  avatarShapes,
  useAction,
  useNavigation,
  useRpc,
  useSettings,
  useWorkspace,
} from "@pibot/renderer-kit";
import { useEffect, useState } from "react";
import { useCatalog } from "../profile/catalog.ts";
import { useImageCatalog } from "../profile/image-catalog.ts";
import { normalizedThinking } from "../profile/ModelFields.tsx";
import { useVideoCatalog } from "../profile/video-catalog.ts";

const appearances = avatarShapes.flatMap((avatarShape) =>
  avatarColors.map((avatarColor) => ({ avatarShape, avatarColor })),
);

function rollAppearance(bots: readonly Bot[], previous?: (typeof appearances)[number]) {
  const used = new Set(bots.map((bot) => `${bot.avatarShape}:${bot.avatarColor}`));
  const available = appearances.filter((choice) => choice !== previous);
  const unused = available.filter(
    (choice) => !used.has(`${choice.avatarShape}:${choice.avatarColor}`),
  );
  const choices = unused.length ? unused : available;
  return (
    choices[Math.floor(Math.random() * choices.length)] ?? {
      avatarShape: "blob" as const,
      avatarColor: "violet" as const,
    }
  );
}

/** "New Bot": a built-in role, or a described custom (text or image) Bot. */
export function useNewBot() {
  const { peer } = useRpc();
  const { navigate } = useNavigation();
  const data = useWorkspace();
  const catalog = useCatalog();
  const [category, setCategory] = useState<BotCategory>("chat");
  const images = useImageCatalog(undefined, category === "image");
  const [imageChoice, setImageChoice] = useState("");
  const defaults = useSettings().settings?.defaultModel;
  const task = useAction();
  const [role, setRoleState] = useState<BuiltinRoleView | "custom">();
  const videos = useVideoCatalog(role === "custom");
  const [videoChoice, setVideoChoice] = useState<ModelPreference>();
  const [description, setDescription] = useState("");
  const [appearance, setAppearance] = useState(() => rollAppearance(data.bots));
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [norms, setNorms] = useState("");
  const [choice, setChoice] = useState<string>();
  const [thinkingChoice, setThinking] = useState<Bot["thinkingLevel"]>();
  const [longWait, setLongWait] = useState(false);
  useEffect(() => {
    setLongWait(false);
    if (!task.busy) return;
    const timer = window.setTimeout(() => setLongWait(true), 5_000);
    return () => window.clearTimeout(timer);
  }, [task.busy]);
  const preference =
    thinkingChoice ??
    (defaults?.thinkingPreference === undefined
      ? defaults?.thinkingLevel
      : defaults.thinkingPreference) ??
    null;
  const value = choice ?? (defaults ? JSON.stringify([defaults.provider, defaults.id]) : "");
  const selectedModel = catalog.models.find(
    (model) => JSON.stringify([model.provider, model.id]) === value,
  );
  const thinking = selectedModel ? normalizedThinking(selectedModel, preference) : "off";
  const selectedImageModel = images.models.find(
    (model) => JSON.stringify([model.provider, model.id]) === imageChoice,
  );
  const uncertain = task.error === "workspace.createUncertain";
  const setRole = (next: BuiltinRoleView | "custom" | undefined) => {
    if (task.busy) return;
    if (!uncertain) task.setError(undefined);
    setRoleState(next);
  };
  const createBot = () => {
    const model = category === "image" ? selectedImageModel : selectedModel;
    if (!peer || !model || !description.trim() || uncertain) return;
    void task
      .run(
        () =>
          peer.call(
            "bots.create",
            {
              description: description.trim(),
              ...(name.trim() ? { name: name.trim() } : {}),
              ...(category === "chat" && persona.trim() ? { systemPrompt: persona.trim() } : {}),
              ...(category === "chat" && norms.trim() ? { norms: norms.trim() } : {}),
              category,
              ...appearance,
              model: { provider: model.provider, id: model.id },
              ...(videoChoice ? { defaultVideoModel: videoChoice } : {}),
              ...(category === "chat" && preference !== null ? { thinkingLevel: preference } : {}),
            },
            { timeoutMs: 120_000 },
          ),
        (error) =>
          error instanceof RpcError && error.code === RpcErrorCodes.botNameTaken
            ? "builtin.custom.nameTaken"
            : actionError(error),
      )
      .then((bot) => {
        if (!bot) return;
        navigate({ name: "chat", botId: bot.id });
        void data.refresh();
      });
  };
  return {
    data,
    catalog,
    appearance,
    reroll: () => setAppearance((previous) => rollAppearance(data.bots, previous)),
    category,
    setCategory,
    images,
    imageChoice,
    setImageChoice,
    selectedImageModel,
    videos,
    videoChoice,
    setVideoChoice,
    task,
    role,
    setRole,
    description,
    setDescription,
    name,
    setName,
    persona,
    setPersona,
    norms,
    setNorms,
    value,
    thinking,
    selectedModel,
    changeModel: (value: string, level?: Bot["thinkingLevel"]) => {
      setChoice(value);
      if (level !== undefined) setThinking(level);
    },
    longWait,
    uncertain,
    createBot,
  };
}

export type NewBotState = ReturnType<typeof useNewBot>;
