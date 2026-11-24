import { localPath } from "@intentic/sandbox-contract/app-routes";
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { localHost } from "../../app/environments/localHost";

// A FIRST MESSAGE THE APP HOLDS FOR THIS WINDOW'S FOLDER (2026-11-24): written before the window was open (the recovery
// panel's "Ask an agent on this computer", the app's `intentic://agent-here`), handed over once, to this window alone.
// The shell asks as it mounts and whenever the app says one has been written, and takes whatever comes back to the
// Agents page on its address (`?draft=`), where it waits in a blank conversation's composer, unsent (LocalAgents.vue).

/** Asks the app for a held draft now and on its word, and opens the Agents page on whatever it hands over. */
export const useHeldAgentDraft = (): void => {
    const host = localHost().agents;
    const router = useRouter();
    const take = async (): Promise<void> => {
        const draft = await host?.takeDraft();
        if (draft !== undefined && draft !== ``) {
            await router.push({ path: localPath(`agents`), query: { draft } });
        }
    };
    let stop: (() => void) | undefined;
    onMounted(() => {
        void take();
        stop = host?.onDraft(() => void take());
    });
    onUnmounted(() => stop?.());
};
