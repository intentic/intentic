import { sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { computed, effectScope, watch } from "vue";
import { rpcQuery } from "../features/sandbox/client/rpcQuery";
import { sandboxRpc } from "../features/sandbox/client/sandboxRpc";
import { useSandboxQuery } from "../features/sandbox/client/useSandboxQuery";
import { supportsRoute } from "../features/sandbox/overview/useDaemonRoutes";
import { rpcKey } from "../lib/queryKeys";
import { queryClient } from "../lib/queryPersistence";
import { adoptAudience, type Audience, audienceStep, keepAudienceWith, useAudience } from "./useAudience";

// Keeps the reader's audience with the sandbox, per member (`settings.audience`), so every device they open it on reads
// the same words: the desktop app said "Accept" and a browser tab "Land now" for one card while each browser kept its
// own answer. Their kept answer wins wherever there is one; with none kept, this browser's answer is handed over once,
// as an offer taken only while there is still none, so a second device never overwrites the first. Another member's
// answer is theirs and never read here. Started once per window (main.ts).

// Whether this sandbox has been handed this browser's answer already, so it is offered once per switch, not per read.
const offered = sandboxValue(() => false);

// A daemon older than these routes is never asked: this browser's answer stays in charge there, as it always was.
const daemonKeeps = (): boolean => supportsRoute(`settings.audience`) && supportsRoute(`settings.setAudience`);

const audienceKey = rpcKey(`settings.audience`);

// Tells the sandbox; a refusal leaves this browser's answer standing for this browser alone, which is all it was before.
const send = async (audience: Audience, offer: boolean): Promise<void> => {
    if (!daemonKeeps()) {
        return;
    }
    const current = sandboxScopeGuard();
    try {
        const state = await sandboxRpc.settings.setAudience({ audience, offer });
        if (!current()) {
            return;
        }
        if (state.adopted) {
            await queryClient.invalidateQueries({ queryKey: audienceKey });
            return;
        }
        // Declined: another of this person's devices answered first, and those words are theirs here.
        adoptAudience(state.audience);
    } catch {
        // allow(silent-catch): an answer the sandbox could not take stays in this browser, as every answer did before.
    }
};

let started = false;

export const startAudienceSync = (): void => {
    if (started) {
        return;
    }
    started = true;
    keepAudienceWith((value) => void send(value, false));
    // Detached: the read lives as long as the window, not as long as whichever screen first asked for words.
    effectScope(true).run(() => {
        const { query } = useSandboxQuery({ ...rpcQuery(`settings.audience`, undefined, { background: true }), enabled: computed(daemonKeeps) });
        const { audience, chosen } = useAudience();
        watch(
            () => query.data.value,
            (kept) => {
                if (kept === undefined) {
                    return;
                }
                const step = audienceStep(kept.audience, audience.value, chosen.value);
                if (step === `adopt` && kept.audience !== undefined) {
                    adoptAudience(kept.audience);
                } else if (step === `offer` && !offered.value) {
                    offered.value = true;
                    void send(audience.value, true);
                }
            },
            { immediate: true },
        );
    });
};
