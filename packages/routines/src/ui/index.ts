/**
 * Routines, UI entry: the routines page, the task editor, proposal cards, the run
 * timeline and the pieces other pages embed (Bot profile list, topic label, inbox and settings
 * sections). It uses the app shell only through `@pibot/renderer-kit`; what it borrows from other
 * parts of the app comes in through `RoutinesUiProvider` (see `shell/ports.tsx`).
 */
export { BotRoutines, RoutineTopicLabel, RoutineTopicLabelProvider } from "./bot/BotRoutines.tsx";
export { RoutineOverlay } from "./editor/RoutineOverlay.tsx";
export { usePages } from "./page/paging.ts";
export { RoutinesPage } from "./page/RoutinesPage.tsx";
export { invalidReasonKey, operationText } from "./preauth/preauth.ts";
export { MessageRoutineProposals } from "./proposals/MessageRoutineProposals.tsx";
export { RoutineProposalInbox } from "./proposals/RoutineProposalInbox.tsx";
export { GlobalRoutineSettings } from "./settings/GlobalSettings.tsx";
export { routineRunTarget, routineTarget } from "./shell/locate.ts";
export { type RoutinePrefill, useRoutineNavigation } from "./shell/navigation.ts";
export { type RoutinesUiPorts, RoutinesUiProvider } from "./shell/ports.tsx";
export { routineError, useRoutineAction, useRoutineRefresh } from "./shell/remote.ts";
export { routineSummary } from "./shell/summary.ts";
export { routineTopicTitle } from "./shell/topic.ts";
