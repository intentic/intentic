import { parseEnv } from "node:util";
import {
    type Automation,
    AutomationSchema,
    type Capability,
    CapabilitySchema,
    type MigrationItem,
    type MigrationPlan,
    type SkillDraft,
    SkillDraftSchema,
} from "@intentic/sandbox-contract";
import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import { isBakedSkill } from "../settings/skills.js";
import { parseSkillFile } from "../settings/skill-file.js";

/* THE HERMES ADAPTER — `~/.hermes` read into a migration plan, pure over the archive's file map so the same
 * function answers the preview and the apply (the apply re-derives; the wire plan is a rendering, never the
 * trusted input — restore.ts's rule).
 *
 * The layout it reads (verified against Hermes' own configuration reference and against OpenClaw's `migrate`
 * command, whose Hermes provider is a peer-reviewed inventory of the same directory):
 *
 *   config.yaml           model/fallbacks, providers (custom endpoints), mcp_servers, platforms, cron
 *   .env                  API keys and platform tokens (parseEnv — the same parser Hermes loads it with)
 *   auth.json             OAuth blobs (refused — sign in fresh here) and the occasional plain api_key
 *   SOUL.md, AGENTS.md    personality and operating notes
 *   memories/ or memory/  MEMORY.md, USER.md, and whatever else the agent wrote
 *   skills/               SKILL.md folders in agent-skills format, sometimes nested (flattened, as Hermes'
 *                         own migrations do)
 *   cron/                 scheduled jobs
 *
 * EVERYTHING UNRECOGNIZED DEGRADES, nothing throws: an unparseable YAML section, a cron line croner refuses, a
 * provider with no base_url each become a `refused` line the owner reads, because a migration that dies on the
 * one odd corner of a lived-in home directory imports nothing at all. */

// What one planned item DOES at apply — held beside the wire item, never serialized to the browser. Secret
// values ride here (they are already in the held archive's memory); `secretFields` names the config keys to
// strip when the owner withheld secrets, so a capability still lands, keyless, rather than not at all.
export type ItemApply =
    | { readonly target: "memory"; readonly fence: string; readonly body: string }
    | { readonly target: "skill"; readonly skill: SkillDraft }
    | { readonly target: "automation"; readonly automation: Automation }
    | { readonly target: "capability"; readonly capability: Capability; readonly secretFields: readonly string[] }
    | { readonly target: "secret"; readonly key: string; readonly value: string }
    | { readonly target: "file"; readonly relPath: string; readonly content: Buffer };

export interface PlannedItem {
    readonly item: MigrationItem;
    readonly apply: ItemApply;
}

export interface SourcePlan {
    readonly planned: readonly PlannedItem[];
    readonly refused: readonly string[];
    readonly needsAction: MigrationPlan["needsAction"];
}

type Files = ReadonlyMap<string, Buffer>;

const text = (files: Files, path: string): string | undefined => files.get(path)?.toString("utf8");

// ---- tolerant readers over parsed YAML/JSON ----
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const asArray = (value: unknown): readonly unknown[] | undefined => (Array.isArray(value) ? value : undefined);

// ---- name shaping ----
// A capability/automation id: ^[a-zA-Z0-9][a-zA-Z0-9_-]*$, ≤60.
const entryId = (raw: string): string => {
    const cleaned = raw
        .replaceAll(/[^a-zA-Z0-9_-]+/g, "-")
        .replaceAll(/-{2,}/g, "-")
        .replace(/^[_-]+/, "")
        .replace(/[_-]+$/, "")
        .slice(0, 60);
    return cleaned === "" ? "imported" : cleaned;
};
// A skill name: ^[a-z0-9][a-z0-9-]*$.
const skillName = (raw: string): string => {
    const cleaned = raw
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]+/g, "-")
        .replaceAll(/-{2,}/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
        .slice(0, 48);
    return cleaned === "" || !/^[a-z0-9]/.test(cleaned) ? `imported-${cleaned}`.replace(/-+$/, "") : cleaned;
};

const localhost = (url: string): boolean => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/.test(url);

// Whether an .env key reads as a credential rather than tuning — the default-tick heuristic, never a gate.
// HERMES_*/TERMINAL_* are the tool's own knobs (timeouts, docker plumbing) whatever their suffix says.
const credential = (key: string): boolean =>
    /(_API_KEY|_TOKEN|_SECRET|_SID|_PASSWORD)$/.test(key) && !key.startsWith("HERMES_") && !key.startsWith("TERMINAL_");

// Bootstrap files this size are a mistake at the source too (Hermes caps memory far lower) — truncating keeps
// one runaway export from swamping the memory files every turn reads.
const MEMORY_FILE_CHAR_LIMIT = 20000;
const clipped = (body: string): string =>
    body.length <= MEMORY_FILE_CHAR_LIMIT
        ? body
        : `${body.slice(0, MEMORY_FILE_CHAR_LIMIT)}\n\n*(truncated on import — the rest was ${body.length - MEMORY_FILE_CHAR_LIMIT} characters)*`;

export const detectHermes = (files: Files): boolean =>
    files.has("config.yaml") &&
    (files.has("SOUL.md") ||
        files.has(".env") ||
        files.has("memories/MEMORY.md") ||
        files.has("memory/MEMORY.md") ||
        [...files.keys()].some((path) => path.startsWith("skills/")));

// ---- the plan ----
export const planHermes = (files: Files): SourcePlan => {
    const planned: PlannedItem[] = [];
    const refused: string[] = [];
    const needsAction: { subject: string; detail: string }[] = [];

    const config = ((): Record<string, unknown> => {
        const raw = text(files, "config.yaml");
        if (raw === undefined) {
            return {};
        }
        try {
            return asRecord(parseYaml(raw)) ?? {};
        } catch {
            refused.push("config.yaml (not readable as YAML — items that live in it were skipped)");
            return {};
        }
    })();
    const env = ((): Record<string, string> => {
        const raw = text(files, ".env");
        return raw === undefined ? {} : ({ ...parseEnv(raw) } as Record<string, string>);
    })();

    // -- memory: SOUL.md, AGENTS.md, the memories folder — each its own fence, so each re-imports alone --
    const soul = text(files, "SOUL.md");
    if (soul !== undefined && soul.trim() !== "") {
        planned.push({
            item: {
                id: "memory:soul",
                target: "memory",
                label: "Personality — SOUL.md",
                detail: "Merged into the agent's memory files as standing context. Make it a persona later if the agent should act as this character.",
                recommended: true,
                secrets: [],
            },
            apply: {
                target: "memory",
                fence: "intentic:imported-hermes:soul",
                body: `## Imported identity (Hermes SOUL.md)\n\n${clipped(soul.trim())}`,
            },
        });
    }
    const agentsNotes = text(files, "AGENTS.md");
    if (agentsNotes !== undefined && agentsNotes.trim() !== "") {
        planned.push({
            item: {
                id: "memory:agents",
                target: "memory",
                label: "Operating notes — AGENTS.md",
                recommended: true,
                secrets: [],
            },
            apply: {
                target: "memory",
                fence: "intentic:imported-hermes:agents",
                body: `## Imported operating notes (Hermes AGENTS.md)\n\n${clipped(agentsNotes.trim())}`,
            },
        });
    }
    const memoryFiles = [...files.keys()]
        .filter((path) => (path.startsWith("memories/") || path.startsWith("memory/")) && path.endsWith(".md"))
        .toSorted((left, right) => left.localeCompare(right));
    if (memoryFiles.length > 0) {
        const sections = memoryFiles
            .map((path) => ({ path, body: (text(files, path) ?? "").trim() }))
            .filter((section) => section.body !== "")
            .map((section) => `### ${section.path}\n\n${clipped(section.body)}`);
        if (sections.length > 0) {
            planned.push({
                item: {
                    id: "memory:memories",
                    target: "memory",
                    label: `Long-term memory — ${sections.length} file${sections.length === 1 ? "" : "s"}`,
                    recommended: true,
                    secrets: [],
                },
                apply: {
                    target: "memory",
                    fence: "intentic:imported-hermes:memory",
                    body: `## Imported memory (Hermes)\n\n${sections.join("\n\n")}`,
                },
            });
        }
    }

    // -- skills: every SKILL.md under skills/, flattened (their own migrate flattens too) --
    const takenSkillNames = new Set<string>();
    for (const path of [...files.keys()].filter((candidate) => candidate.startsWith("skills/") && candidate.endsWith("/SKILL.md")).toSorted()) {
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
        while (takenSkillNames.has(name)) {
            name = `${name.slice(0, 45)}-2`;
        }
        takenSkillNames.add(name);
        const siblings = [...files.keys()].filter((candidate) => candidate.startsWith(path.slice(0, -"SKILL.md".length)) && candidate !== path);
        const skill = SkillDraftSchema.safeParse({
            name,
            description:
                parsed.description?.trim() !== "" && parsed.description !== undefined ? parsed.description : `Imported from Hermes (${dirName}).`,
            body: parsed.body,
        });
        if (!skill.success) {
            refused.push(`${path} (does not fit a skill: ${skill.error.issues[0]?.message ?? "invalid"})`);
            continue;
        }
        planned.push({
            item: {
                id: `skill:${name}`,
                target: "skill",
                label: `Skill — ${name}`,
                ...(siblings.length > 0
                    ? { detail: `Only the skill text moves; ${siblings.length} other file${siblings.length === 1 ? "" : "s"} in its folder did not.` }
                    : {}),
                recommended: true,
                secrets: [],
            },
            apply: { target: "skill", skill: skill.data },
        });
    }

    // -- secrets: .env keys, plus the plain api_key entries auth.json sometimes holds --
    const plannedSecrets = new Set<string>();
    const planSecret = (key: string, value: string, origin: string): void => {
        if (plannedSecrets.has(key) || value === "") {
            return;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 128) {
            refused.push(`${origin}: ${key} (not an env-shaped name)`);
            return;
        }
        plannedSecrets.add(key);
        planned.push({
            item: {
                id: `secret:${key}`,
                target: "secret",
                label: `Secret — ${key}`,
                ...(credential(key) ? {} : { detail: "Looks like tuning rather than a credential — take it only if something here will read it." }),
                recommended: credential(key),
                secrets: [key],
            },
            apply: { target: "secret", key, value },
        });
    };
    for (const [key, value] of Object.entries(env).toSorted(([left], [right]) => left.localeCompare(right))) {
        planSecret(key, value, ".env");
    }
    const authRaw = text(files, "auth.json");
    if (authRaw !== undefined) {
        const auth = ((): Record<string, unknown> => {
            try {
                return asRecord(JSON.parse(authRaw)) ?? {};
            } catch {
                refused.push("auth.json (not readable as JSON)");
                return {};
            }
        })();
        for (const [provider, entry] of Object.entries(auth).toSorted(([left], [right]) => left.localeCompare(right))) {
            const record = asRecord(entry);
            const apiKey = asString(record?.["api_key"]);
            if (apiKey !== undefined) {
                planSecret(`${provider.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}_API_KEY`, apiKey, "auth.json");
            }
            if (asString(record?.["access_token"]) !== undefined || asString(record?.["refresh_token"]) !== undefined) {
                refused.push(`auth.json: ${provider} OAuth tokens (bound to that install — sign in fresh here)`);
            }
        }
    }

    // -- MCP servers: URL-served ones become mcp capabilities; command-run ones cannot cross --
    const takenCapabilityIds = new Set<string>();
    const capabilityId = (raw: string): string => {
        let id = entryId(raw);
        while (takenCapabilityIds.has(id)) {
            id = `${id.slice(0, 57)}-2`;
        }
        takenCapabilityIds.add(id);
        return id;
    };
    for (const [name, entry] of Object.entries(asRecord(config["mcp_servers"]) ?? {}).toSorted(([left], [right]) => left.localeCompare(right))) {
        const server = asRecord(entry);
        // Hermes spells transport into the scheme (`sse+http://…`); the address underneath is the same server.
        const url = asString(server?.["url"])?.replace(/^sse\+/, "");
        if (url === undefined || !/^https?:\/\//.test(url)) {
            if (asString(server?.["command"]) !== undefined) {
                needsAction.push({
                    subject: `MCP server "${name}"`,
                    detail: "It ran as a local command on your old machine. Intentic reaches MCP servers over a URL — host it behind HTTP, or skip it.",
                });
            } else {
                refused.push(`config.yaml: mcp_servers.${name} (no usable URL)`);
            }
            continue;
        }
        const bearer = asString(asRecord(server?.["headers"])?.["Authorization"])?.match(/^Bearer\s+(.+)$/)?.[1];
        const id = capabilityId(name);
        const capability = CapabilitySchema.safeParse({ id, kind: "mcp", config: { url, ...(bearer === undefined ? {} : { token: bearer }) } });
        if (!capability.success) {
            refused.push(`config.yaml: mcp_servers.${name} (${capability.error.issues[0]?.message ?? "invalid"})`);
            continue;
        }
        const local = localhost(url);
        planned.push({
            item: {
                id: `capability:mcp:${id}`,
                target: "capability",
                label: `MCP server — ${name}`,
                detail: local ? `${url} — that address points at your old machine, not here.` : url,
                recommended: !local,
                secrets: bearer === undefined ? [] : [`${id}/token`],
            },
            apply: { target: "capability", capability: capability.data, secretFields: bearer === undefined ? [] : ["token"] },
        });
    }

    // -- custom providers: anything with a base_url becomes a model endpoint capability --
    for (const [name, entry] of Object.entries(asRecord(config["providers"]) ?? {}).toSorted(([left], [right]) => left.localeCompare(right))) {
        const provider = asRecord(entry);
        const baseUrl = asString(provider?.["base_url"]);
        if (baseUrl === undefined) {
            refused.push(`config.yaml: providers.${name} (no base_url — a built-in provider, matched under "Pick your model provider")`);
            continue;
        }
        const keyEnv = asString(provider?.["api_key_env"]);
        const apiKey = keyEnv === undefined ? undefined : env[keyEnv];
        const id = capabilityId(name);
        const capability = CapabilitySchema.safeParse({
            id,
            kind: "endpoint",
            config: {
                baseUrl,
                protocol: asString(provider?.["type"]) === "anthropic" ? "anthropic" : "openai",
                ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
            },
        });
        if (!capability.success) {
            refused.push(`config.yaml: providers.${name} (${capability.error.issues[0]?.message ?? "invalid"})`);
            continue;
        }
        const local = localhost(baseUrl);
        planned.push({
            item: {
                id: `capability:endpoint:${id}`,
                target: "capability",
                label: `Model endpoint — ${name}`,
                detail: local ? `${baseUrl} — that address points at your old machine, not here.` : baseUrl,
                recommended: !local,
                secrets: apiKey === undefined || apiKey === "" ? [] : [`${id}/apiKey`],
            },
            apply: { target: "capability", capability: capability.data, secretFields: apiKey === undefined || apiKey === "" ? [] : ["apiKey"] },
        });
    }

    // -- cron: the config.yaml section and the cron/ folder, whichever this install used --
    const takenAutomationIds = new Set<string>();
    const planCron = (rawName: string, entry: Record<string, unknown>, origin: string): void => {
        const cron = asString(entry["schedule"]) ?? asString(entry["cron"]) ?? asString(entry["expression"]);
        const prompt = asString(entry["prompt"]) ?? asString(entry["message"]) ?? asString(entry["task"]) ?? asString(entry["text"]);
        if (cron === undefined || prompt === undefined) {
            return;
        }
        // The job's OWN name wherever it declared one — a refusal that says "cron-2" makes the owner count
        // list entries to learn which job it meant.
        const name = asString(entry["name"]) ?? asString(entry["id"]) ?? rawName;
        try {
            new Cron(cron).nextRun();
        } catch {
            refused.push(`${origin}: "${name}" (cron expression "${cron}" is not readable)`);
            return;
        }
        let id = entryId(`hermes-${name}`);
        while (takenAutomationIds.has(id)) {
            id = `${id.slice(0, 57)}-2`;
        }
        takenAutomationIds.add(id);
        /* `requireApproval` on every imported job, deliberately: these prompts were written for a different
         * agent on a different machine, and the first few fires should be read, not discovered. `enabled`
         * follows the source — a job they had switched off stays off. */
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
                target: "automation",
                label: `Automation — ${id} (${cron})`,
                detail: "Fires are held for your approval until you relax that on its card.",
                recommended: true,
                secrets: [],
            },
            apply: { target: "automation", automation: automation.data },
        });
    };
    const cronSection = asRecord(config["cron"]);
    if (cronSection !== undefined) {
        planCron("cron", cronSection, "config.yaml");
        for (const [index, job] of (asArray(cronSection["jobs"]) ?? []).entries()) {
            const record = asRecord(job);
            if (record !== undefined) {
                planCron(`cron-${index + 1}`, record, "config.yaml");
            }
        }
    }
    for (const path of [...files.keys()].filter((candidate) => candidate.startsWith("cron/") && candidate.endsWith(".json")).toSorted()) {
        const parsed = ((): unknown => {
            try {
                return JSON.parse(text(files, path) ?? "");
            } catch {
                refused.push(`${path} (not readable as JSON)`);
                return undefined;
            }
        })();
        const jobs = asArray(parsed) ?? asArray(asRecord(parsed)?.["jobs"]) ?? (asRecord(parsed) === undefined ? [] : [parsed]);
        for (const [index, job] of jobs.entries()) {
            const record = asRecord(job);
            if (record !== undefined) {
                planCron(`${path.slice("cron/".length, -".json".length)}${jobs.length > 1 ? `-${index + 1}` : ""}`, record, path);
            }
        }
    }

    // -- loose notes at the root: kept, under imports/, as the agent's reference pile --
    for (const path of [...files.keys()].filter((candidate) => candidate.endsWith(".md") && !candidate.includes("/")).toSorted()) {
        if (path === "SOUL.md" || path === "AGENTS.md") {
            continue;
        }
        const content = files.get(path);
        if (content === undefined || content.toString("utf8").trim() === "") {
            continue;
        }
        planned.push({
            item: {
                id: `file:${path}`,
                target: "file",
                label: `Note — ${path}`,
                detail: `Lands in imports/hermes/${path}.`,
                recommended: true,
                secrets: [],
            },
            apply: { target: "file", relPath: `imports/hermes/${path}`, content },
        });
    }

    // -- what is already known not to move: channels to reconnect, the model to pick --
    const PLATFORM_TOKENS: Record<string, string> = {
        telegram: "TELEGRAM_BOT_TOKEN",
        discord: "DISCORD_BOT_TOKEN",
        slack: "SLACK_BOT_TOKEN",
        whatsapp: "TWILIO_AUTH_TOKEN",
    };
    for (const [name, entry] of Object.entries(asRecord(config["platforms"]) ?? {}).toSorted(([left], [right]) => left.localeCompare(right))) {
        if (asRecord(entry)?.["enabled"] !== true) {
            continue;
        }
        const tokenKey = PLATFORM_TOKENS[name];
        needsAction.push({
            subject: `Reconnect ${name}`,
            detail: `You had ${name} wired into Hermes' gateway. Add the ${name} connector from the capabilities grid${
                tokenKey !== undefined && plannedSecrets.has(tokenKey) ? ` — its token rides along as the ${tokenKey} secret when you tick it` : ""
            }.`,
        });
    }
    const model = asRecord(config["model"]);
    if (model !== undefined) {
        const provider = asString(model["provider"]) ?? "";
        const HINTS: Record<string, string> = {
            anthropic: "connect a Claude account here",
            openai: "connect an OpenAI account here",
            google: "connect a Gemini account here",
            gemini: "connect a Gemini account here",
            xai: "connect a Grok account here",
            grok: "connect a Grok account here",
            moonshot: "connect a Kimi account here",
            kimi: "connect a Kimi account here",
        };
        needsAction.push({
            subject: "Pick your model provider",
            detail: `Hermes ran on ${provider === "" ? "an unnamed provider" : provider}${asString(model["model"]) === undefined ? "" : ` (${asString(model["model"])})`} — ${
                HINTS[provider.toLowerCase()] ?? "point a custom model endpoint at it, or pick a native provider"
            }. Provider logins never travel in a migration.`,
        });
    }
    if (asArray(config["fallback_providers"]) !== undefined && (asArray(config["fallback_providers"]) ?? []).length > 0) {
        refused.push("config.yaml: fallback_providers (no equivalent here — the chat picker and automations pin models per use instead)");
    }
    refused.push("config.yaml (translated into the items above, not copied — it can hold inline tokens)");

    return { planned, refused: refused.toSorted((left, right) => left.localeCompare(right)), needsAction };
};
