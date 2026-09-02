import type { ArrivalItem, Automation, Capability, SkillDraft } from "@intentic/sandbox-contract";
import { AutomationSchema, CapabilitySchema, SkillDraftSchema } from "@intentic/sandbox-contract";
import { Cron } from "croner";
import { isBakedSkill } from "../settings/skills.js";
import { parseSkillFile } from "../settings/skill-file.js";

/* WHAT EVERY SOURCE ADAPTER SHARES, the tolerant readers, the name shaping, and the one translation both
 * ecosystems spell identically (a folder of SKILL.md skills). An adapter's job is the judgment particular to
 * its source; everything here is the part that must NOT vary between them, because two adapters disagreeing on
 * what a valid id or a credential-shaped key is would make the same archive import differently by source. */

// What one planned item DOES at apply, held beside the wire item, never serialized to the browser. Secret
// values ride here (they are already in the held archive's memory); `secretFields` names the config keys to
// strip when the owner withheld secrets, so a capability still lands, keyless, rather than not at all.
export type ItemApply =
    | { readonly target: "memory"; readonly fence: string; readonly body: string }
    | { readonly target: "skill"; readonly skill: SkillDraft }
    | { readonly target: "automation"; readonly automation: Automation }
    | { readonly target: "capability"; readonly capability: Capability; readonly secretFields: readonly string[] }
    | { readonly target: "secret"; readonly key: string; readonly value: string }
    // One ticked row may land several files (a folder of daily notes), the checklist stays readable while the
    // bytes stay complete.
    | { readonly target: "file"; readonly files: readonly { readonly relPath: string; readonly content: Buffer }[] };

/* The checklist row an adapter writes, which is an arrival row MINUS `applicable`. An assistant's home
 * directory has no notion of an inapplicable row: an adapter that cannot take something refuses it during the
 * walk, with a line in `refused` naming the file and the reason. So the field would read `true` on every one
 * of the thirty literals below and in the two adapters, saying nothing thirty times; it is filled once, where
 * the plan is assembled (assistants.ts). The other two flags are NOT constant here and stay on the literals:
 * `recommended` is the adapter's judgment, `secrets` is what the row would store. */
export type AdapterRow = Omit<ArrivalItem, "applicable">;

export interface PlannedItem {
    readonly item: AdapterRow;
    readonly apply: ItemApply;
}

export interface SourcePlan {
    readonly planned: readonly PlannedItem[];
    readonly refused: readonly string[];
    readonly needsAction: readonly { readonly subject: string; readonly detail: string }[];
}

export type Files = ReadonlyMap<string, Buffer>;

export const text = (files: Files, path: string): string | undefined => files.get(path)?.toString("utf8");

// ---- tolerant readers over parsed YAML/JSON ----
export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
export const asArray = (value: unknown): readonly unknown[] | undefined => (Array.isArray(value) ? value : undefined);

// ---- name shaping ----
// A capability/automation id: ^[a-zA-Z0-9][a-zA-Z0-9_-]*$, ≤60.
export const entryId = (raw: string): string => {
    const cleaned = raw
        .replaceAll(/[^a-zA-Z0-9_-]+/g, "-")
        .replaceAll(/-{2,}/g, "-")
        .replace(/^[_-]+/, "")
        .replace(/[_-]+$/, "")
        .slice(0, 60);
    return cleaned === "" ? "imported" : cleaned;
};
// A skill name: ^[a-z0-9][a-z0-9-]*$.
export const skillName = (raw: string): string => {
    const cleaned = raw
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]+/g, "-")
        .replaceAll(/-{2,}/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
        .slice(0, 48);
    return cleaned === "" || !/^[a-z0-9]/.test(cleaned) ? `imported-${cleaned}`.replace(/-+$/, "") : cleaned;
};

// A pool that keeps generated ids unique within one plan without the adapters each re-inventing the suffixing.
export const idPool = (): ((raw: string) => string) => {
    const taken = new Set<string>();
    return (raw) => {
        let id = raw;
        while (taken.has(id)) {
            id = `${id.slice(0, 57)}-2`;
        }
        taken.add(id);
        return id;
    };
};

export const localhost = (url: string): boolean => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/.test(url);

// Whether an env key reads as a credential rather than tuning, the default-tick heuristic, never a gate.
// `noise` names the source tool's own variable prefixes (timeouts, plumbing), whatever their suffix says.
export const credential = (key: string, noise: readonly string[]): boolean =>
    /(_API_KEY|_TOKEN|_SECRET|_SID|_PASSWORD)$/.test(key) && !noise.some((prefix) => key.startsWith(prefix));

// Bootstrap files this size are a mistake at the source too (both tools cap injected context far lower),
// truncating keeps one runaway export from swamping the memory files every turn reads.
export const MEMORY_FILE_CHAR_LIMIT = 20000;
export const clipped = (body: string): string =>
    body.length <= MEMORY_FILE_CHAR_LIMIT
        ? body
        : `${body.slice(0, MEMORY_FILE_CHAR_LIMIT)}\n\n*(truncated on import, the rest was ${body.length - MEMORY_FILE_CHAR_LIMIT} characters)*`;

/* Every SKILL.md under a prefix, flattened into skill items, the one mapping both ecosystems share verbatim,
 * agent-skills format on both sides. Baked-tool collisions are renamed rather than shadowed (a skill called
 * `lsp` would claim the built-in's switch), and the taken-set is the CALLER's so two scanned locations (a
 * workspace skills folder and a managed one) resolve their collisions in the caller's precedence order. */
export const planSkillFiles = (files: Files, prefix: string, sourceLabel: string, taken: Set<string>, refused: string[]): PlannedItem[] => {
    const planned: PlannedItem[] = [];
    for (const path of [...files.keys()].filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith("/SKILL.md")).toSorted()) {
        const dirName = path.split("/").at(-2) ?? "skill";
        const parsed = parseSkillFile(text(files, path) ?? "");
        if (parsed.body.trim() === "") {
            refused.push(`${path} (empty skill)`);
            continue;
        }
        let name = skillName(dirName);
        if (isBakedSkill(name)) {
            name = `${name}-imported`;
        }
        if (taken.has(name)) {
            refused.push(`${path} (a "${name}" skill was already taken from a higher-precedence folder)`);
            continue;
        }
        taken.add(name);
        const siblings = [...files.keys()].filter((candidate) => candidate.startsWith(path.slice(0, -"SKILL.md".length)) && candidate !== path);
        const skill = SkillDraftSchema.safeParse({
            name,
            description:
                parsed.description?.trim() !== "" && parsed.description !== undefined
                    ? parsed.description
                    : `Imported from ${sourceLabel} (${dirName}).`,
            body: parsed.body,
        });
        if (!skill.success) {
            refused.push(`${path} (does not fit a skill: ${skill.error.issues[0]?.message ?? "invalid"})`);
            continue;
        }
        planned.push({
            item: {
                id: `skill:${name}`,
                group: "skill",
                label: `Skill, ${name}`,
                ...(siblings.length > 0
                    ? { detail: `Only the skill text moves; ${siblings.length} other file${siblings.length === 1 ? "" : "s"} in its folder did not.` }
                    : {}),
                recommended: true,
                secrets: [],
            },
            apply: { target: "skill", skill: skill.data },
        });
    }
    return planned;
};

/* One secret item per env-shaped key, deduped across a plan's several sources (.env, an auth file, inline
 * channel tokens), first origin wins, which is why callers feed the most authoritative store first. The
 * checklist line and the default tick are decided here so every source's secrets read identically. */
export const secretPlanner = (
    planned: PlannedItem[],
    refused: string[],
    noise: readonly string[],
): { readonly plan: (key: string, value: string, origin: string) => void; readonly has: (key: string) => boolean } => {
    const taken = new Set<string>();
    return {
        has: (key) => taken.has(key),
        plan: (key, value, origin) => {
            if (taken.has(key) || value === "") {
                return;
            }
            // A `${VAR}` value is a POINTER at an env store, not a credential, the real value arrives via the
            // store it points at, and importing the pointer would store a literal dollar-string as a secret.
            if (/^\$\{[^}]+\}$/.test(value)) {
                return;
            }
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 128) {
                refused.push(`${origin}: ${key} (not an env-shaped name)`);
                return;
            }
            taken.add(key);
            planned.push({
                item: {
                    id: `secret:${key}`,
                    group: "secret",
                    label: `Secret, ${key}`,
                    ...(credential(key, noise)
                        ? {}
                        : { detail: "Looks like tuning rather than a credential, take it only if something here will read it." }),
                    recommended: credential(key, noise),
                    secrets: [key],
                },
                apply: { target: "secret", key, value },
            });
        },
    };
};

/* One source cron job into one held-for-approval automation. `requireApproval` on every imported job,
 * deliberately: these prompts were written for a different agent on a different machine, and the first few
 * fires should be read, not discovered. `enabled` follows the source, a job they switched off stays off. */
export const automationPlanner = (
    sourcePrefix: string,
    planned: PlannedItem[],
    refused: string[],
): ((rawName: string, entry: Record<string, unknown>, origin: string, override?: { cron?: string; prompt?: string }) => void) => {
    const nextId = idPool();
    return (rawName, entry, origin, override) => {
        const cron = override?.cron ?? asString(entry["schedule"]) ?? asString(entry["cron"]) ?? asString(entry["expression"]);
        const prompt =
            override?.prompt ?? asString(entry["prompt"]) ?? asString(entry["message"]) ?? asString(entry["task"]) ?? asString(entry["text"]);
        if (cron === undefined || prompt === undefined) {
            return;
        }
        // The job's OWN name wherever it declared one, a refusal that says "cron-2" makes the owner count
        // list entries to learn which job it meant.
        const name = asString(entry["name"]) ?? asString(entry["id"]) ?? rawName;
        try {
            new Cron(cron).nextRun();
        } catch {
            refused.push(`${origin}: "${name}" (cron expression "${cron}" is not readable)`);
            return;
        }
        const id = nextId(entryId(`${sourcePrefix}-${name}`));
        const automation = AutomationSchema.safeParse({
            id,
            trigger: { kind: "schedule", cron },
            prompt,
            requireApproval: true,
            enabled: entry["enabled"] !== false,
        });
        if (!automation.success) {
            refused.push(`${origin}: "${name}" (${automation.error.issues[0]?.message ?? "invalid"})`);
            return;
        }
        planned.push({
            item: {
                id: `automation:${id}`,
                group: "automation",
                label: `Automation, ${id} (${cron})`,
                detail: "Fires are held for your approval until you relax that on its card.",
                recommended: true,
                secrets: [],
            },
            apply: { target: "automation", automation: automation.data },
        });
    };
};

/* One MCP server entry into an mcp capability when it is URL-served, a needs-action when it is command-run,
 * both ecosystems declare them the same way, down to the `sse+` transport prefix some spell into the scheme. */
export const planMcpEntry = (
    name: string,
    server: Record<string, unknown> | undefined,
    origin: string,
    capabilityId: (raw: string) => string,
    out: { planned: PlannedItem[]; refused: string[]; needsAction: { subject: string; detail: string }[] },
): void => {
    const url = asString(server?.["url"])?.replace(/^sse\+/, "");
    if (url === undefined || !/^https?:\/\//.test(url)) {
        if (asString(server?.["command"]) !== undefined) {
            out.needsAction.push({
                subject: `MCP server "${name}"`,
                detail: "It ran as a local command on your old machine. Intentic reaches MCP servers over a URL, host it behind HTTP, or skip it.",
            });
        } else {
            out.refused.push(`${origin} (no usable URL)`);
        }
        return;
    }
    const bearer = asString(asRecord(server?.["headers"])?.["Authorization"])?.match(/^Bearer\s+(.+)$/)?.[1];
    const id = capabilityId(entryId(name));
    const capability = CapabilitySchema.safeParse({ id, kind: "mcp", config: { url, ...(bearer === undefined ? {} : { token: bearer }) } });
    if (!capability.success) {
        out.refused.push(`${origin} (${capability.error.issues[0]?.message ?? "invalid"})`);
        return;
    }
    const local = localhost(url);
    out.planned.push({
        item: {
            id: `capability:mcp:${id}`,
            group: "capability",
            label: `MCP server, ${name}`,
            detail: local ? `${url}, that address points at your old machine, not here.` : url,
            recommended: !local,
            secrets: bearer === undefined ? [] : [`${id}/token`],
        },
        apply: { target: "capability", capability: capability.data, secretFields: bearer === undefined ? [] : ["token"] },
    });
};

// The provider line both tools need translated: which native account to connect, or "point an endpoint at it".
export const PROVIDER_HINTS: Record<string, string> = {
    anthropic: "connect a Claude account here",
    openai: "connect an OpenAI account here",
    google: "connect a Gemini account here",
    gemini: "connect a Gemini account here",
    xai: "connect a Grok account here",
    grok: "connect a Grok account here",
    moonshot: "connect a Kimi account here",
    kimi: "connect a Kimi account here",
};
