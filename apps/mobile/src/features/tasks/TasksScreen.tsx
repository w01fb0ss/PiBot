import { useRouter } from "expo-router";
import { RefreshControl, ScrollView, View } from "react-native";
import type { MobileKey } from "../../i18n/messages.ts";
import { useLinkState, useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { ErrorLine, FootNote, SectionTitle } from "../../ui/controls.tsx";
import { HeaderPill, OfflineBanner, TabHeader } from "../../ui/headers.tsx";
import { StatRow } from "../../ui/stats.tsx";
import { useTabBarInset } from "../../ui/tab-bar.tsx";
import { useToast } from "../../ui/toast.tsx";
import { useApprovals } from "../approvals/approvals-context.tsx";
import { latestFinished, routineCounts, routineRuns } from "./counts.ts";
import type { RoutineRun } from "./pages.ts";
import { RoutinesSection } from "./RoutinesSection.tsx";
import { RoutineRow, Rows } from "./TaskRows.tsx";
import { useTaskCenter } from "./tasks-context.tsx";

export function TasksScreen() {
  const colors = useColors(),
    t = useText(),
    toast = useToast(),
    router = useRouter(),
    mobile = useLinkState(),
    tasks = useTaskCenter(),
    tabInset = useTabBarInset(),
    approvals = useApprovals();
  const online = mobile.status === "online";
  const disabled = !online || tasks.write.busy;
  const center = tasks.center;
  const routines = routineRuns(center);
  const act = async (work: Promise<unknown>, message: MobileKey) => {
    if ((await work) !== undefined) toast(t(message));
  };
  const routineRow = (run: RoutineRun) => (
    <RoutineRow
      run={run}
      disabled={disabled}
      onRunNow={() => run.routineId && void act(tasks.runNow(run.routineId), "ranNowToast")}
      onOpen={() =>
        router.push({ pathname: "/task/[kind]/[id]", params: { kind: "routine", id: run.id } })
      }
    />
  );
  const error = tasks.write.error ?? tasks.action.error;
  const counts = routineCounts(center, approvals.waiting);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader
        title={t("tasks")}
        tab="tasks"
        actions={
          // The computer's run records, read-only, last 3 days.
          <HeaderPill icon="audit" title={t("records")} onPress={() => router.push("/records")} />
        }
      >
        <StatRow
          stats={[
            { label: t("summaryRunning"), value: counts.working },
            { label: t("summaryWaiting"), value: counts.waiting, warn: true },
            { label: t("summaryDone"), value: counts.doneToday },
          ]}
        />
      </TabHeader>
      <ScrollView
        contentContainerStyle={{ paddingBottom: tabInset }}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => void tasks.load()}
            tintColor={colors.text2}
          />
        }
      >
        {!online && (
          <View style={{ marginHorizontal: 16, marginTop: 2 }}>
            <OfflineBanner text={t("tasksOffline")} />
          </View>
        )}
        <ErrorLine text={error && t(error)} />
        {/* Counts live in the section title, as on the desktop task panel. */}
        <SectionTitle title={t("sectionActiveCount", { count: routines.active.length })} />
        <Rows
          rows={routines.active}
          empty={t(tasks.loading ? "loading" : "noActive")}
          keyOf={(run) => run.id}
          render={routineRow}
        />
        <RoutinesSection center={center} tasks={tasks} disabled={disabled} act={act} />
        <SectionTitle title={t("sectionDone")} />
        <Rows
          rows={latestFinished(routines.finished).slice(0, 30)}
          empty={t(tasks.loading ? "loading" : "noDone")}
          keyOf={(run) => run.id}
          render={routineRow}
        />
        <FootNote text={t("tasksFoot")} />
      </ScrollView>
    </View>
  );
}
