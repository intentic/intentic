import type { GettingStarted } from "@intentic/sandbox-contract/schemas/settings";
import { freshEdition } from "../../mode";
import {
    adoptRepoChecks,
    adoptTimezone,
    aiLiteracy,
    aiLiteracyConfirmations,
    answerAudience,
    answerCommitIdentity,
    builtinPrompt,
    confirmAiLiteracy,
    currentSettings,
    readAudience,
    readCommitIdentity,
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
    commitIdentity: readCommitIdentity,
    setCommitIdentity: answerCommitIdentity,
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
    // No rule has ever fired in a recorded demo; an empty table is the honest answer.
    firings: () => ({}),
    // What the two repositories in this workspace declare for themselves, in the three states the group has to be
    // able to show: running, waiting on the owner, and held because the file changed under an adoption.
    repoChecks: readRepoChecks,
    adoptRepoChecks: (input) => okAfter(() => adoptRepoChecks(input)),
} satisfies Doors<`settings`>;
