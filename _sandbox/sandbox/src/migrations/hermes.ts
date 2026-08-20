import { parseEnv } from "node:util";
import { CapabilitySchema } from "@intentic/sandbox-contract";
import { parse as parseYaml } from "yaml";
import {
    asArray,
    asRecord,
    asString,
    automationPlanner,
    clipped,
    entryId,
    type Files,
    idPool,
    localhost,
    planMcpEntry,
    planSkillFiles,
    type PlannedItem,
    PROVIDER_HINTS,
    secretPlanner,
    type SourcePlan,
    text,
} from "./adapter-shared.js";

/* THE HERMES ADAPTER, `~/.hermes` read into a migration plan, pure over the archive's file map so the same
 * function answers the preview and the apply (the apply re-derives; the wire plan is a rendering, never the
 * trusted input, restore.ts's rule).
 *
 * The layout it reads (verified against Hermes' own configuration reference and against OpenClaw's `migrate`
 * command, whose Hermes provider is a peer-reviewed inventory of the same directory):
 *
 *   config.yaml           model/fallbacks, providers (custom endpoints), mcp_servers, platforms, cron
 *   .env                  API keys and platform tokens (parseEnv, the same parser Hermes loads it with)
 *   auth.json             OAuth blobs (refused, sign in fresh here) and the occasional plain api_key
 *   SOUL.md, AGENTS.md    personality and operating notes
 *   memories/ or memory/  MEMORY.md, USER.md, and whatever else the agent wrote
 *   skills/               SKILL.md folders in agent-skills format, sometimes nested (flattened, as Hermes'
 *                         own migrations do)
 *   cron/                 scheduled jobs
 *
 * EVERYTHING UNRECOGNIZED DEGRADES, nothing throws: an unparseable YAML section, a cron line croner refuses, a
 * provider with no base_url each become a `refused` line the owner reads, because a migration that dies on the
 * one odd corner of a lived-in home directory imports nothing at all. */

export const detectHermes = (files: Files): boolean =>
    files.has("config.yaml") &&
    (files.has("SOUL.md") ||
        files.has(".env") ||
        files.has("memories/MEMORY.md") ||
        files.has("memory/MEMORY.md") ||
        [...files.keys()].some((path) => path.startsWith("skills/")));

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

    // -- memory: SOUL.md, AGENTS.md, the memories folder, each its own fence, so each re-imports alone --
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
            item: { id: "memory:agents", target: "memory", label: "Operating notes — AGENTS.md", recommended: true, secrets: [] },
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
            apply: { target: "memory", fence: "intentic:imported-hermes:memory", body: `## Imported memory (Hermes)\n\n${sections.join("\n\n")}` },
        });
    }

    // -- skills: every SKILL.md under skills/, flattened (their own migrate flattens too) --
    planned.push(...planSkillFiles(files, "skills/", "Hermes", new Set(), refused));

    // -- secrets: .env keys, plus the plain api_key entries auth.json sometimes holds --
    const secrets = secretPlanner(planned, refused, ["HERMES_", "TERMINAL_"]);
    for (const [key, value] of Object.entries(env).toSorted(([left], [right]) => left.localeCompare(right))) {
        secrets.plan(key, value, ".env");
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
                secrets.plan(`${provider.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}_API_KEY`, apiKey, "auth.json");
            }
            if (asString(record?.["access_token"]) !== undefined || asString(record?.["refresh_token"]) !== undefined) {
                refused.push(`auth.json: ${provider} OAuth tokens (bound to that install — sign in fresh here)`);
            }
        }
    }

    // -- MCP servers: URL-served ones become mcp capabilities; command-run ones cannot cross --
    const capabilityId = idPool();
    for (const [name, entry] of Object.entries(asRecord(config["mcp_servers"]) ?? {}).toSorted(([left], [right]) => left.localeCompare(right))) {
        planMcpEntry(name, asRecord(entry), `config.yaml: mcp_servers.${name}`, capabilityId, { planned, refused, needsAction });
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
        const id = capabilityId(entryId(name));
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
    const planCron = automationPlanner("hermes", planned, refused);
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
            apply: { target: "file", files: [{ relPath: `imports/hermes/${path}`, content }] },
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
                tokenKey !== undefined && secrets.has(tokenKey) ? ` — its token rides along as the ${tokenKey} secret when you tick it` : ""
            }.`,
        });
    }
    const model = asRecord(config["model"]);
    if (model !== undefined) {
        const provider = asString(model["provider"]) ?? "";
        needsAction.push({
            subject: "Pick your model provider",
            detail: `Hermes ran on ${provider === "" ? "an unnamed provider" : provider}${
                asString(model["model"]) === undefined ? "" : ` (${asString(model["model"])})`
            } — ${PROVIDER_HINTS[provider.toLowerCase()] ?? "point a custom model endpoint at it, or pick a native provider"}. Provider logins never travel in a migration.`,
        });
    }
    if ((asArray(config["fallback_providers"]) ?? []).length > 0) {
        refused.push("config.yaml: fallback_providers (no equivalent here — the chat picker and automations pin models per use instead)");
    }
    refused.push("config.yaml (translated into the items above, not copied — it can hold inline tokens)");

    return { planned, refused: refused.toSorted((left, right) => left.localeCompare(right)), needsAction };
};
