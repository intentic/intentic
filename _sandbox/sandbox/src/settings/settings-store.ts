import { type RuleSchema, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import type { z } from "zod";
import { dropAll, isJsonObject, mapValue, retype } from "../store/conversions.js";
import { defineDocument } from "../store/documents.js";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";
import { stateRelPath } from "../state-paths.js";

// The sandbox-owned agent-settings manifest (<workspace>/.intentic/config/settings.json). Mirrors the automations
// store: a small JSON file the /settings routes edit and streamAgent reads. No secrets, so not on the denylist.

// Rules at a moment or with an action a later version withdrew (the `push.starting` moment, `instruct` actions, three
// built-in checks) can never run, and one of them made the whole file unreadable, every setting in it with it.
const RETIRED_MOMENTS: ReadonlySet<unknown> = new Set(["push.starting"]);
const RETIRED_ACTIONS: ReadonlySet<unknown> = new Set(["instruct"]);
const RETIRED_BUILTINS: ReadonlySet<unknown> = new Set(["verify-edits", "verify-removals", "verify-tests"]);

const isRetiredRule = (rule: unknown): boolean => {
    if (!isJsonObject(rule)) {
        return false;
    }
    const action = isJsonObject(rule["action"]) ? rule["action"] : {};
    return RETIRED_MOMENTS.has(rule["moment"]) || RETIRED_ACTIONS.has(action["kind"]) || (action["kind"] === "builtin" && RETIRED_BUILTINS.has(action["name"]));
};

const holdsRetiredRule = (value: unknown): value is readonly unknown[] => Array.isArray(value) && value.some(isRetiredRule);

export const settingsDocument = defineDocument({
    path: stateRelPath(".intentic/config/settings.json"),
    schema: SandboxSettingsSchema,
    history: [
        // Every setting a release since 2026-08-10 had and this one does not (read off the contract lock's history):
        // retired, so passthrough stops carrying them, a definition naming one still applies, and no later setting may
        // take one of these names to mean something else.
        ...dropAll([
            "agentRunEffort",
            "agentRunModel",
            "agentRunModels",
            "autoFastModels",
            "autoTier",
            "autoTierEagerness",
            "commandJudgeModels",
            "commandRules",
            "contextShelf",
            "dependencyFreshness",
            "explainCommands",
            "iqContext",
            "iqContextHoldout",
            "moveAfterLimit",
            "quickModel",
            "resumeAfterLimit",
            "resumeAfterOutage",
            "terseHoldout",
            "terseOutput",
            "testFaultDetection",
        ]),
        retype(
            "rules",
            holdsRetiredRule,
            // What survives the filter is every rule this version can read; the parse after the chain says so.
            (rules) => rules.filter((rule) => !isRetiredRule(rule)) as z.input<typeof RuleSchema>[],
            "drops rules at a withdrawn moment or with a withdrawn action (push.starting, instruct, three built-in checks)",
        ),
        // suggest, the old default, becomes the new default: routing on.
        mapValue("personaRouting", { off: false, suggest: true, auto: true }),
    ],
});

export interface SandboxSettingsStore {
    readonly get: () => Promise<SandboxSettings>;
    // `get` plus whether the value stands in for a file this build could not read; boot acts on nothing it did not read.
    readonly load: () => Promise<{ readonly settings: SandboxSettings; readonly unreadable: boolean }>;
    readonly set: (settings: SandboxSettings) => Promise<void>;
}

export const fileSandboxSettingsStore = (path: string): SandboxSettingsStore => {
    const file = jsonFile<SandboxSettings>(path, {
        // `objectParse` rather than a bare safeParse: this is the manifest a person is most likely to open and
        // edit, and a misspelled flag would otherwise be stripped in silence and simply never take effect.
        parse: objectParse(SandboxSettingsSchema),
        // Applied when the file is absent or unreadable. The defaults live on the schema (every flag is opt-in,
        // so all default off), so parsing an empty object is the schema's OWN answer for "nothing was written
        // yet" rather than a second copy of the shape that could drift from it. A manifest that predates a flag
        // keeps every pick it DOES carry, the missing key reads as that flag's default.
        fallback: () => SandboxSettingsSchema.parse({}),
        // The one manifest the owner edits by hand: a version this build cannot parse is theirs to fix, never replaced.
        onUnreadable: "refuse",
        document: settingsDocument,
    });
    return {
        get: file.read,
        load: async () => {
            const { value, unreadable } = await file.state();
            return { settings: value, unreadable };
        },
        set: async (settings) => {
            await file.update(() => settings);
        },
    };
};
