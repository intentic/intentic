import type { GettingStarted } from "@intentic/sandbox-contract/schemas/settings";
import { freshEdition } from "../../mode";
import { STARTED_AT } from "../board/roster";
import {
    adoptRepoChecks,
    adoptTimezone,
    aiLiteracy,
    aiLiteracyConfirmations,
    answerAudience,
    builtinPrompt,
    confirmAiLiteracy,
    currentSettings,
    readAudience,
    readRepoChecks,
    writeSettings,
} from "./preferences";
import { DEMO_SAVINGS } from "./settings";
import { type Doors, okAfter } from "../doors";

// What the visitor said about the getting-started checklist, for this page load: put away, steps passed over. Every
// recording but the fresh one is an established sandbox whose owner put the list away long ago, so screenshots of it
// carry no beginner's ring; `?mode=fresh` is where the list is seen.
let gettingStarted: GettingStarted = freshEdition ? {} : { hidden: true };

export const settingsDoors = {
    // The sandbox's settings as this page load has written them (preferences.ts): a press sticks until a reload.
    get: currentSettings,
    set: (settings) => okAfter(() => writeSettings(settings)),
    adoptTimezone,
    audience: readAudience,
    setAudience: answerAudience,
    aiLiteracy,
    confirmAiLiteracy,
    aiLiteracyConfirmations,
    builtinPrompt,
    gettingStarted: () => gettingStarted,
    setGettingStarted: (choices) => {
        gettingStarted = choices;
        return gettingStarted;
    },
    savings: () => DEMO_SAVINGS,
    // A brief that exists, is maintained, and does not entirely fit the budget: the state the row has the most to say
    // about, and the only one where "ranks 1-5 of 12" means anything.
    fieldNotes: () => ({
        present: true,
        writtenAt: STARTED_AT - 19 * 24 * 60 * 60_000,
        ranksSent: 5,
        ranksTotal: 12,
        chars: 2_784,
        automation: `enabled`,
        nextRunAt: STARTED_AT + 11 * 24 * 60 * 60_000,
    }),
    // No rule has ever fired in a recorded demo; an empty table is the honest answer.
    firings: () => ({}),
    // What the two repositories in this workspace declare for themselves, in the three states the group has to be
    // able to show: running, waiting on the owner, and held because the file changed under an adoption.
    repoChecks: readRepoChecks,
    adoptRepoChecks: (input) => okAfter(() => adoptRepoChecks(input)),
} satisfies Doors<`settings`>;
