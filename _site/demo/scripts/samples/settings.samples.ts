import { createHash } from "node:crypto";
import { AI_LITERACY_TEXT } from "@intentic/sandbox-contract/schemas/ai-literacy";
import type { GroupSamples } from "./context.ts";

export const settingsSamples: GroupSamples<`settings`> = () => ({
    get: undefined,
    // The AI notice switched on with its built-in words, so the confirmation below confirms exactly those.
    set: { aiNotice: { show: true, text: `` } },
    gettingStarted: undefined,
    setGettingStarted: { hidden: false },
    savings: {},
    fieldNotes: undefined,
    firings: undefined,
    repoChecks: undefined,
    adoptRepoChecks: { repo: `web`, on: true },
    adoptTimezone: { timezone: `Europe/Warsaw` },
    audience: undefined,
    setAudience: { audience: `developer`, offer: true },
    aiLiteracy: { locale: `en` },
    aiLiteracyConfirmations: undefined,
    confirmAiLiteracy: { version: createHash(`sha256`).update(AI_LITERACY_TEXT.en).digest(`hex`), locale: `en` },
    builtinPrompt: { base: `claude` },
});
