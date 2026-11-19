import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { supervisorOf } from "../../../auth/principal.js";
import type { PersistedAgent } from "../../../conversations/registry/agents-store.js";

// Whether a turn is told to proceed without asking (settings `proceedWithoutAsking`, guidance.ts `proceed`): the
// conversation's own answer, else the nearest answer up the conversations that started it, else the sandbox's. A child
// inherits its parent's answer this way, read as each of its turns is planned, so a parent switched on for the night
// carries its subagents with it without a word in their prompts and without its spawn path copying anything.

type Entry = Pick<PersistedAgent, "postures" | "identity">;

// Further up than any nesting the settings allow (subagentDepth), so a loop in the records cannot hold a turn.
const MAX_HOPS = 16;

export const proceedsWithoutAsking = (
    settings: Pick<SandboxSettings, "proceedWithoutAsking">,
    entry: Entry | undefined,
    entryOf: (id: string) => Entry | undefined,
): boolean => {
    let current = entry;
    for (let hop = 0; current !== undefined && hop < MAX_HOPS; hop += 1) {
        if (current.postures.proceed !== undefined) {
            return current.postures.proceed;
        }
        const parent = supervisorOf(current.identity);
        current = parent === undefined ? undefined : entryOf(parent);
    }
    return settings.proceedWithoutAsking;
};
