import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import { useApprovals } from "../../src/features/approvals/approvals-context.tsx";
import { useConversations } from "../../src/features/conversations/conversations-context.tsx";
import { useText } from "../../src/runtime/context.tsx";
import { GlassScope } from "../../src/theme/glass.tsx";
import { TabBar } from "../../src/ui/tab-bar.tsx";

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];
function AppTabBar({ state, navigateToTab }: TabBarProps) {
  const t = useText(),
    approvals = useApprovals(),
    conversations = useConversations();
  return (
    <TabBar
      current={state.routes[state.index]?.name ?? "chat"}
      onSelect={(name) => {
        const route = state.routes.find((item) => item.name === name);
        if (route) navigateToTab(route.key);
      }}
      tabs={[
        // Unread chats are one blue dot (the sidebar mark); pending approvals a violet count.
        { name: "chat", label: t("chat"), icon: "message", badge: conversations.unread.size > 0 },
        { name: "todos", label: t("todos"), icon: "calendar" },
        { name: "tasks", label: t("tasks"), icon: "clock" },
        {
          name: "approvals",
          label: t("approvals"),
          icon: "inbox",
          // Group plans waiting for a choice count like approvals: both wait for the person.
          badge: approvals.waiting,
        },
        { name: "devices", label: t("devices"), icon: "laptop" },
      ]}
    />
  );
}
export default function TabLayout() {
  return (
    <GlassScope>
      {/* Android back on another tab returns to Chats; back on Chats leaves the app. */}
      <Tabs
        backBehavior="firstRoute"
        screenOptions={{ headerShown: false }}
        tabBar={(props) => <AppTabBar {...props} />}
      >
        <Tabs.Screen name="chat" />
        <Tabs.Screen name="todos" />
        <Tabs.Screen name="tasks" />
        <Tabs.Screen name="approvals" />
        <Tabs.Screen name="devices" />
      </Tabs>
    </GlassScope>
  );
}
