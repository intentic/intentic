import { emit } from "@tauri-apps/api/event";
import { deviceKey, removeStoredValue, storedValue, storeValue } from "@intentic/ui/storage";

/* AGENTS ON THIS COMPUTER, as the dev stand-in answers for the app (src-tauri/src/host_agents.rs, read by
   src/agents/hostAgents.ts): the reader's yes, off until the page's own press turns it on, and a first message the app would
   hold for this window's folder. Both are kept for the tab's reloads. `?agents=on|off` and `?agentDraft=1` on the dev
   address pick a case; they are read as this module loads, while the address still carries them (the page rewrites it
   before anything asks). */

const ACCEPTED_KEY = deviceKey(`intentic.local.devAgentsAccepted`);
const DRAFT_KEY = deviceKey(`intentic.local.devAgentDraft`);
const SAMPLE_DRAFT = `The sandbox "shop" on this computer stopped answering. Find out why, and tell me what you would change before you change anything.`;

const asked = new URL(window.location.href).searchParams;
if (asked.has(`agents`)) {
    storeValue(ACCEPTED_KEY, asked.get(`agents`) === `on` ? `yes` : `no`, `session`);
}
if (asked.get(`agentDraft`) === `1`) {
    storeValue(DRAFT_KEY, SAMPLE_DRAFT, `session`);
}

const state = () => ({ accepted: storedValue(ACCEPTED_KEY, `session`) === `yes`, running: 0 });

/** The app's answer to one of the agents' commands; undefined for any other command. */
export const agentsVerb = (command: string): ReturnType<typeof state> | string | null | undefined => {
    if (command === `host_agents_state`) {
        return state();
    }
    if (command === `host_agents_accept`) {
        storeValue(ACCEPTED_KEY, `yes`, `session`);
        void emit(`desktop://host-agents`, state());
        return state();
    }
    if (command === `host_agents_take_draft`) {
        const held = storedValue(DRAFT_KEY, `session`) ?? null;
        removeStoredValue(DRAFT_KEY, `session`);
        return held;
    }
    return undefined;
};
