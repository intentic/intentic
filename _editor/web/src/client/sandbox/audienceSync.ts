import { sandboxScopeGuard } from "@intentic/extension-api";
import { audienceOfMode } from "@intentic/sandbox-contract/schemas/sandbox-mode";
import type { MemberAudience } from "@intentic/sandbox-contract/schemas/settings";
import { computed, effectScope, watch } from "vue";
import { rpcQuery } from "./rpcQuery";
import { sandboxRpc } from "./sandboxRpc";
import { useSandboxQuery } from "./useSandboxQuery";
import { supportsRoute } from "./useDaemonRoutes";
import { rpcKey } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";
import { adoptSandboxWords, type Audience, keepAudienceWith, type SandboxWords, useAudience } from "../../app/useAudience";

// Keeps the reader's words with the sandbox. The sandbox answers what this person reads there (`settings.audience`):
// their own choice when they made one, otherwise what its mode speaks, plain on a hands-off sandbox and git's on a
// hands-on one. This window takes that answer whole. A choice made here goes to the sandbox as this person's own, and
// null forgets it. Nothing is offered any more: the words a browser was last told are no answer for a sandbox it has not
// heard from. Started once per window (main.ts).

// A daemon older than these routes is never asked: this browser's last words stay on screen there.
const daemonKeeps = (): boolean => supportsRoute(`settings.audience`) && supportsRoute(`settings.setAudience`);

const audienceKey = rpcKey(`settings.audience`);

// What a read says this person sees. A daemon from before the mode keeps only a person's own choice and says no mode;
// with nothing kept there, this browser's last words stand, as they always did against it.
const wordsOf = (kept: MemberAudience): SandboxWords | undefined => {
    if (kept.mode === undefined) {
        return kept.audience === undefined ? undefined : { audience: kept.audience, override: kept.audience };
    }
    return { audience: kept.audience ?? audienceOfMode(kept.mode), override: kept.override, mode: kept.mode };
};

// Tells the sandbox; a refusal leaves the choice on this screen until the next read brings the sandbox's words back.
const send = async (audience: Audience | null): Promise<void> => {
    if (!daemonKeeps()) {
        return;
    }
    const current = sandboxScopeGuard();
    try {
        const state = await sandboxRpc.settings.setAudience({ audience });
        if (!current()) {
            return;
        }
        adoptSandboxWords({ audience: state.audience, override: state.override, mode: useAudience().mode.value });
        await queryClient.invalidateQueries({ queryKey: audienceKey });
    } catch {
        // allow(silent-catch): a choice the sandbox could not take stays on this screen, and the next read says what it keeps.
    }
};

/** Read the words again, after something that changes them for everyone: the sandbox's mode switched. */
export const refreshSandboxWords = (): Promise<void> => queryClient.invalidateQueries({ queryKey: audienceKey });

let started = false;

export const startAudienceSync = (): void => {
    if (started) {
        return;
    }
    started = true;
    keepAudienceWith((value) => void send(value));
    // Detached: the read lives as long as the window, not as long as whichever screen first asked for words.
    effectScope(true).run(() => {
        const { query } = useSandboxQuery({ ...rpcQuery(`settings.audience`, undefined, { background: true }), enabled: computed(daemonKeeps) });
        watch(
            () => query.data.value,
            (kept) => {
                const words = kept === undefined ? undefined : wordsOf(kept);
                if (words !== undefined) {
                    adoptSandboxWords(words);
                }
            },
            { immediate: true },
        );
    });
};
