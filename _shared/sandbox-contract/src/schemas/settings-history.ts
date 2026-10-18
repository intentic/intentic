import { z } from "zod";
import { at, drop, dropAll, fold, isJsonObject, type JsonObject, mapValue, retype, transform } from "../documents/conversions.js";
import { type ModelRole, ModelRoleSchema } from "../models/model-roles.js";
import { setupsFromRoleLists } from "../models/model-setups.js";
import { ModelPinSchema, type ModelPin } from "./agent.js";
import { RESTORE_POINT_KEEP_DAYS_DEFAULT } from "./data-protection.js";
import type { KeepWarmSettings, RuleSchema } from "./settings.js";

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

// An owner's rule at the `turn.ending` moment reads and runs nothing, since only the checks a repository declares run
// there (its moment and the `verify-ui-edits` built-in stay in the read schema so a file written before reads); dropped,
// so it stops showing as a rule the owner has and stops travelling with the settings.
const isInertRule = (rule: unknown): boolean =>
    isJsonObject(rule) &&
    (rule["moment"] === "turn.ending" || (isJsonObject(rule["action"]) && rule["action"]["kind"] === "builtin" && rule["action"]["name"] === "verify-ui-edits"));

const holdsInertRule = (value: unknown): value is readonly unknown[] => Array.isArray(value) && value.some(isInertRule);

// keep-warm's four top-level settings (2026-09-26), folded into the one `keepWarm` object; a value of the wrong type is
// left out, for the schema's own default to fill.
const KEEP_WARM_FLAT = ["keepWarm", "keepWarmHours", "keepWarmMinTokens", "keepWarmReserve"] as const;
const FlatSwitch = z.boolean();
const FlatNumber = z.number();
const keepWarmObject = fold("folds keepWarm, keepWarmHours, keepWarmMinTokens and keepWarmReserve into one keepWarm object", {
    from: KEEP_WARM_FLAT,
    into: "keepWarm",
    applies: (settings) => FlatSwitch.safeParse(settings["keepWarm"]).success || KEEP_WARM_FLAT.slice(1).some((key) => Object.hasOwn(settings, key)),
    convert: ({ keepWarm, keepWarmHours, keepWarmMinTokens, keepWarmReserve }): Partial<KeepWarmSettings> => {
        const folded: Partial<KeepWarmSettings> = {};
        const auto = FlatSwitch.safeParse(keepWarm);
        const hours = FlatNumber.safeParse(keepWarmHours);
        const minTokens = FlatNumber.safeParse(keepWarmMinTokens);
        const reserve = FlatNumber.safeParse(keepWarmReserve);
        if (auto.success) {
            folded.auto = auto.data;
        }
        if (hours.success) {
            folded.hours = hours.data;
        }
        if (minTokens.success) {
            folded.minTokens = minTokens.data;
        }
        if (reserve.success) {
            folded.reserve = reserve.data;
        }
        return folded;
    },
});

// The Refactors job (2026-10-09): a refactor started from a repository's Health tab used to name no job and opened on
// whatever model the composer last held. A file from before it inherits the Maintenance chores list, the job nearest in
// kind, so the owner's choice for work they start carries over instead of the new job opening empty. Only while the key
// is absent: an owner who later empties it stores [], which this leaves alone.
type RolesWithChores = JsonObject & { readonly "maintenance-chore": readonly unknown[] };
const holdsChoresWithoutRefactors = (roles: JsonObject): roles is RolesWithChores =>
    !Object.hasOwn(roles, "refactor-run") && Array.isArray(roles["maintenance-chore"]) && roles["maintenance-chore"].length > 0;
const refactorsFromChores = transform(
    "gives the new Refactors job the Maintenance chores list",
    holdsChoresWithoutRefactors,
    (roles): JsonObject => ({ ...roles, "refactor-run": roles["maintenance-chore"] }),
);

// Setups (2026-10-12): a job no longer holds a model list of its own (`modelRoles`) beside one default list
// (`modelDefault`); it runs on a named setup it shares with other jobs. Jobs that held the same list share one setup, a
// list most of whose jobs are suggested a preset becomes that preset, and a job that held none, or an empty one, is on
// none, which runs it exactly as before: not at all. A list that does not read (a role this version does not know, a malformed pin) is left out rather than refusing
// the whole file, the same reading the schema gave it.
const PinList = z.array(ModelPinSchema);
const holdsRoleLists = (settings: JsonObject): settings is JsonObject => Object.hasOwn(settings, "modelRoles") || Object.hasOwn(settings, "modelDefault");
const roleListsIntoSetups = transform("folds modelRoles and modelDefault into setups (modelSetups, roleSetups)", holdsRoleLists, (settings): JsonObject => {
    const { modelRoles, modelDefault, ...rest } = settings;
    const fallback = PinList.safeParse(modelDefault);
    const lists: Partial<Record<ModelRole, ModelPin[]>> = {};
    for (const role of ModelRoleSchema.options) {
        const own = isJsonObject(modelRoles) ? PinList.safeParse(modelRoles[role]) : undefined;
        const list = own?.success === true ? own.data : fallback.success && fallback.data.length > 0 ? fallback.data : undefined;
        if (list !== undefined) {
            lists[role] = list;
        }
    }
    const { modelSetups, roleSetups } = setupsFromRoleLists(lists);
    return { ...rest, modelSetups, roleSetups };
});

const restorePointsKept = fold("carries restorePointDays into restorePointKeepDays, a stored zero taking the 30-day default", {
    from: ["restorePointDays"],
    into: "restorePointKeepDays",
    applies: (retention) => Object.hasOwn(retention, "restorePointDays"),
    convert: ({ restorePointDays }, retention) => {
        // A file that already names the new key (a definition written for both) keeps it.
        const kept = FlatNumber.safeParse(retention["restorePointKeepDays"]);
        if (kept.success) {
            return kept.data;
        }
        const chosen = FlatNumber.safeParse(restorePointDays);
        return chosen.success && chosen.data > 0 ? chosen.data : RESTORE_POINT_KEEP_DAYS_DEFAULT;
    },
});

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
        "sidecars",
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
    retype(
        "rules",
        holdsInertRule,
        (rules) => rules.filter((rule) => !isInertRule(rule)) as z.input<typeof RuleSchema>[],
        "drops rules at the retired turn.ending moment (and the verify-ui-edits built-in), which run nothing",
    ),
    keepWarmObject,
    // Where the check after landing ran (2026-09-27): nothing checks work after it lands any more, CI does.
    at("offload", drop("landCheck")),
    // The model list for the fix a refused push offered (2026-09-28): a refused push now says why and offers nothing.
    at("modelRoles", drop("pre-push-fix")),
    // The short guidance form (2026-10-06): it lost its A/B to the full one, which every turn now gets.
    ...dropAll(["leanGuidance", "leanGuidanceHoldout"]),
    // Tool-result clearing (2026-10-12): it lost its A/B, rewriting more of the cache than it saved and failing more calls.
    ...dropAll(["toolResultClearing", "toolResultClearingHoldout"]),
    at("modelRoles", refactorsFromChores),
    roleListsIntoSetups,
    // Restore points kept 30 days by default (2026-10-18). `restorePointDays` held zero both where the owner chose to keep
    // every point and where the settings page had saved the old default, which no reading could tell apart: the key is
    // retired, a positive choice carries over, and a stored zero takes the new default.
    at("retention", restorePointsKept),
] as const;
