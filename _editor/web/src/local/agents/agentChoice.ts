import { localPath } from "@intentic/sandbox-contract/app-routes";
import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { computerAgents } from "../../client/sandbox/useDaemonRoutes";
import { composeAgent } from "../../models/fleet/agentActions";

// WHERE AN AGENT ASKED FOR FROM THIS FOLDER RUNS (2026-11-24). A folder window had one answer, a sandbox of the
// folder's own: contained, reviewed, and minutes away the first time. Where this computer runs agents itself there is a
// second, instant one, and the press that asks for an agent offers both, each saying what it is: on this computer (not
// sandboxed), which opens the Agents page on a blank conversation, or in a sandbox, which is the press as it was.

interface Asked {
    /** What the composer opens holding, unsent; blank for the folder as a whole. */
    readonly draft: string;
    /** The press as it was before there was a choice. */
    readonly sandbox: () => void;
}

export const useAgentChoice = () => {
    const router = useRouter();
    const menu = ref<{ show: (event: Event) => void }>();
    const asked = ref<Asked>();

    const here = (): void => {
        const draft = asked.value?.draft ?? ``;
        // A blank one has no word for the address to carry: the blank conversation is opened here, then the page.
        if (draft === ``) {
            composeAgent(``);
        }
        void router.push(draft === `` ? { path: localPath(`agents`) } : { path: localPath(`agents`), query: { draft } });
    };
    const items = computed<MenuItem[]>(() => [
        { label: t(`local.agents.choice.here`), icon: `desktop`, command: here },
        { label: t(`local.agents.choice.sandbox`), icon: `box`, command: () => asked.value?.sandbox() },
    ]);

    /** The press: the two answers where this computer runs agents itself, else the sandbox's straight away. */
    const offer = (event: Event | undefined, ask: Asked): void => {
        if (!computerAgents.value || event === undefined || menu.value === undefined) {
            ask.sandbox();
            return;
        }
        asked.value = ask;
        menu.value.show(event);
    };
    return { menu, items, offer };
};
