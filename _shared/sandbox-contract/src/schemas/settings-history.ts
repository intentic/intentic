import type { z } from "zod";
import { dropAll, isJsonObject, mapValue, retype } from "../documents/conversions.js";
import type { RuleSchema } from "./settings.js";

// The conversions the settings shape has had, oldest first: what brings any earlier release's settings to
// SandboxSettingsSchema. Two documents carry this shape, the daemon's settings.json and a sandbox.toml's [settings]
// table, and both read through this one list; it sits beside the schema so that neither reader has to reach into the
// other for it. A name retired here stays retired: no later setting may take it to mean something else.

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

export const SETTINGS_HISTORY = [
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
] as const;
