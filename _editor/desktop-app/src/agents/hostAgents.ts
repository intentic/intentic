import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LocalAgentsHost } from "@intentic/web/local-host";
import { ref } from "vue";

// THE AGENTS THAT RUN ON THIS COMPUTER ITSELF, as the app answers for them (src-tauri/src/host_agents.rs): whether the
// reader has turned them on, how many turns run now in any window, and a first message the app holds for this window's
// folder. The turns themselves are the sidecar's (_devices/host-agents, served beside the folder's files); only what
// must not be a page's own word goes through the app: the reader's yes, which the sidecar holds every turn to.

// What `host_agents_state`, `host_agents_accept` and the `desktop://host-agents` event all carry.
interface HostAgentsState {
    readonly accepted: boolean;
    readonly running: number;
}

const STATE_EVENT = `desktop://host-agents`;
// The app holds a first message for some window's folder: each window asks whether it is its own.
const DRAFT_EVENT = `desktop://host-agents-draft`;

export const hostAgentsHost = (): LocalAgentsHost => {
    const accepted = ref(false);
    const running = ref(0);
    const take = (state: HostAgentsState): void => {
        accepted.value = state.accepted;
        running.value = state.running;
    };
    // Heard from the first ask on, as Repair's session is: a window that never opens Agents listens for nothing.
    let following: Promise<void> | undefined;
    const follow = (): Promise<void> => {
        following ??= (async () => {
            await listen<HostAgentsState>(STATE_EVENT, (event) => take(event.payload));
            take(await invoke<HostAgentsState>(`host_agents_state`));
        })();
        return following;
    };
    return {
        accepted,
        running,
        follow,
        accept: async () => {
            take(await invoke<HostAgentsState>(`host_agents_accept`));
        },
        takeDraft: async () => (await invoke<string | null>(`host_agents_take_draft`)) ?? undefined,
        onDraft: (listener: () => void) => {
            const heard = listen(DRAFT_EVENT, () => listener());
            return () => {
                // allow(silent-catch): a listener that never attached has nothing to detach
                void heard.then((stop) => stop()).catch(() => undefined);
            };
        },
    };
};
