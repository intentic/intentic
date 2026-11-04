import type { SealPerson } from "@intentic/sandbox-contract/schemas/seal";
import { computed, type ComputedRef } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { useAccess } from "../../../client/sandbox/access/useAccess";
import { useMembers } from "../../../client/sandbox/useMembers";
import { presenceOthers } from "../../../workbench/presence/usePresence";

// WHO A READER CAN ADD TO A PRIVATE CONVERSATION: the sandbox's people, as this reader can know them. The roster
// (GET /members) where their access reads it, the owner it names, and whoever is here now with the name they signed in
// with, so a writer who cannot read the roster still finds the colleague working beside them. Never the reader
// themselves, and never someone who already reads it. An address typed in full is always offered too (SealReaders).

const fold = (email: string): string => email.trim().toLowerCase();

export const useSealCandidates = (taken: () => readonly string[]): ComputedRef<readonly SealPerson[]> => {
    const access = useAccess();
    const { members, owner } = useMembers({ enabled: computed(() => access.can(`GET /members`)) });
    const { user } = useAuth();
    return computed(() => {
        const out = new Map<string, SealPerson>();
        const add = (email: string | undefined, name?: string): void => {
            if (email === undefined || email === ``) {
                return;
            }
            const key = fold(email);
            const person: SealPerson = { email: key };
            const named = name ?? out.get(key)?.name;
            if (named !== undefined) {
                person.name = named;
            }
            out.set(key, person);
        };
        add(owner.value);
        for (const member of members.value) {
            add(member.email);
        }
        for (const here of presenceOthers.value) {
            add(here.email, here.name);
        }
        const skip = new Set([...taken().map(fold), fold(user.value?.email ?? ``)]);
        return [...out.values()].filter((person) => !skip.has(person.email)).toSorted((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
    });
};

/** Whether what was typed is a whole address, which is offered as a person of its own. */
export const typedAddress = (text: string): string | undefined => {
    const folded = fold(text);
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(folded) ? folded : undefined;
};
