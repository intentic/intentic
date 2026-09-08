import { toValue } from "vue";
import { useChat } from "../../features/chat/run/useChat";
import { onScreen } from "../../shell/window/onScreen";
import { queryClient } from "../../lib/queryPersistence";
import { useSandbox } from "../../features/sandbox/client/useSandbox";
import { browserPace, runBackgroundLoader, type LoaderGates } from "./backgroundLoader";
import { agentsWarmSource } from "./sources/agentsWarm";
import { changesWarmSource } from "./sources/changesWarm";
import { extensionsWarmSource } from "./sources/extensionsWarm";
import { railWarmSource } from "./sources/railWarm";
import { terminalsWarmSource } from "./sources/terminalsWarm";
import { registerWarmSource, warmPlan } from "./warmPlan";

// Wires the loop (backgroundLoader.ts) to the real app: what `paused`, `busy` and `the plan` mean here.
// The loop itself knows none of this, which keeps it testable. Started by the signed-in session
// (WorkspaceRuntime.vue): a user on /setup or an invite link still benefits from a warm board on arrival.

const { reachable } = useSandbox();
const { conversations } = useChat();

// Registration order is warmPlan's tie-break within a band: nearest need first.
const SOURCES = [terminalsWarmSource, changesWarmSource, agentsWarmSource, railWarmSource, extensionsWarmSource];

const gates: LoaderGates = {
    // Paused when this window isn't visible, or the daemon is unreachable (reachable).
    paused: () => !onScreen.value || !toValue(reachable),
    // Busy when any query is fetching (something on screen is waiting) or a conversation is streaming.
    busy: () => queryClient.isFetching() > 0 || conversations.value.some((conversation) => conversation.streaming.value),
};

let running = false;
let disposers: (() => void)[] = [];

export const startBackgroundLoader = (): void => {
    if (running) {
        return;
    }
    running = true;
    disposers = SOURCES.map((source) => registerWarmSource(source));
    void runBackgroundLoader(warmPlan, gates, browserPace, () => !running);
};

export const stopBackgroundLoader = (): void => {
    running = false;
    for (const dispose of disposers) {
        dispose();
    }
    disposers = [];
};
