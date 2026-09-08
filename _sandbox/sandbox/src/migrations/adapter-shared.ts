import type { ArrivalItem, Automation, Capability, SkillDraft } from "@intentic/sandbox-contract";
import { AutomationSchema, CapabilitySchema, SkillDraftSchema } from "@intentic/sandbox-contract";
import { Cron } from "croner";
import { isBakedSkill } from "../settings/skills.js";
import { parseSkillFile } from "../settings/skill-file.js";

// Shared across every source adapter: tolerant readers, name shaping, and the one translation both ecosystems spell
// identically (a SKILL.md folder). An adapter's own judgment stays out of here; two adapters disagreeing on a valid id
// would make one archive import differently by source.

// Automation minus `models`: the model ladder names providers THIS sandbox has connected, which an archive from another
// machine cannot know. Adapters plan without it; apply.ts (with services) fills it in, still held for approval.
export type MigratedAutomation = Omit<Automation, "models">;

// What one planned item does at apply; held server-side, never serialized to the browser (secret values ride here).
// `secretFields` lets a capability land keyless when the owner withholds secrets.
export type ItemApply =
    | { readonly target: "memory"; readonly fence: string; readonly body: string }
    | { readonly target: "skill"; readonly skill: SkillDraft }
    | { readonly target: "automation"; readonly automation: MigratedAutomation }
    | { readonly target: "capability"; readonly capability: Capability; readonly secretFields: readonly string[] }
    | { readonly target: "secret"; readonly key: string; readonly value: string }
    // One ticked row can land several files (e.g. a folder of daily notes) while the checklist stays one line.
    | { readonly target: "file"; readonly files: readonly { readonly relPath: string; readonly content: Buffer }[] };

// Arrival row minus `applicable`: an adapter that can't take an item refuses it during the walk, so this is filled once
// at plan assembly, not repeated on every literal. `recommended` and `secrets` still do.
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

// Capability/automation id: ^[a-zA-Z0-9][a-zA-Z0-9_-]*$, at most 60 characters.
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

// Heuristic for the default tick, never a hard gate: does an env key read as a credential rather than tuning? `noise`
// lists a source tool's own prefixes (timeouts, plumbing) to exclude regardless of suffix.
export const credential = (key: string, noise: readonly string[]): boolean =>
    /(_API_KEY|_TOKEN|_SECRET|_SID|_PASSWORD)$/.test(key) && !noise.some((prefix) => key.startsWith(prefix));

// Both source tools cap injected context far lower than this; truncating a runaway export keeps it from swamping every
// turn's memory files.
export const MEMORY_FILE_CHAR_LIMIT = 20000;
export const clipped = (body: string): string =>
    body.length <= MEMORY_FILE_CHAR_LIMIT
        ? body
        : `${body.slice(0, MEMORY_FILE_CHAR_LIMIT)}\n\n*(truncated on import, the rest was ${body.length - MEMORY_FILE_CHAR_LIMIT} characters)*`;

// Flattens every SKILL.md under a prefix, the mapping both ecosystems share verbatim. A name colliding with a baked
// tool is renamed, not shadowed; `taken` is the caller's, so scanned locations resolve collisions in its order.
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

// One secret item per env-shaped key, deduped across a plan's sources: first origin wins, so callers feed the most
// authoritative store first. The checklist line and default tick are decided here so every source reads the same.
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
            // A `${VAR}` value points at another env store; importing it would store the literal placeholder as a
            // secret.
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

// One source cron job becomes one held-for-approval automation: `requireApproval` is always on, since these prompts
// were written for a different agent on a different machine. `enabled` follows the source job's own switch.
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
        // Uses the job's own declared name; a refusal naming "cron-2" would force the owner to count list entries.
        const name = asString(entry["name"]) ?? asString(entry["id"]) ?? rawName;
        try {
            new Cron(cron).nextRun();
        } catch {
            refused.push(`${origin}: "${name}" (cron expression "${cron}" is not readable)`);
            return;
        }
        const id = nextId(entryId(`${sourcePrefix}-${name}`));
        // Validates every field the archive can answer for; the model ladder is filled later, at apply
        // (MigratedAutomation).
        const automation = AutomationSchema.omit({ models: true }).safeParse({
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

// One MCP server entry becomes an mcp capability when URL-served, or a needs-action when it's a local command; both
// ecosystems declare servers the same way, down to the `sse+` transport prefix some use.
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
