import { parseEnv } from "node:util";
import {
    asArray,
    asRecord,
    asString,
    automationPlanner,
    clipped,
    type Files,
    idPool,
    planMcpEntry,
    planSkillFiles,
    type PlannedItem,
    PROVIDER_HINTS,
    secretPlanner,
    type SourcePlan,
    text,
} from "./adapter-shared.js";
import { parseJson5ish } from "./json5ish.js";

/* THE OPENCLAW ADAPTER — `~/.openclaw` read into a migration plan; pure, like the Hermes one beside it, and
 * shaped by the same rule: translate judgment-free, refuse by name, never throw.
 *
 * The layout it reads (their configuration reference and their own `migrate` command's inventory):
 *
 *   openclaw.json            JSON5 — agents.defaults (model/workspace/heartbeat/skills), channels, mcp, env
 *   .env                     the global env fallback
 *   workspace/               SOUL.md, IDENTITY.md, USER.md, AGENTS.md, MEMORY.md, memory/YYYY-MM-DD.md,
 *                            HEARTBEAT.md, BOOTSTRAP.md (first-run ritual, skipped), skills/ (highest
 *                            precedence for name collisions)
 *   skills/                  managed/installed skills at the state root
 *   cron/jobs.json           gateway cron jobs ({name, schedule:{kind,expr|everyMs,tz}, payload:{message}})
 *   agents/<id>/agent/auth-profiles.json   model credentials (api keys taken with consent; OAuth refused)
 *   credentials/             channel state — never even held (the archive reader skips the segment; WhatsApp
 *                            ratchets DESYNC when copied, per their own migration guide)
 *
 * The one wrinkle Hermes does not have: the workspace is relocatable (`agents.defaults.workspace`). A packed
 * `~/.openclaw` only contains it when it lives at the default path, so a config naming somewhere else gets a
 * needs-action telling the owner to pack it in — guessing at sibling directories in the tar would mean
 * importing whichever lookalike folder happened to ride along. */

const WS = "workspace/";

export const detectOpenclaw = (files: Files): boolean =>
    files.has("openclaw.json") &&
    (files.has(".env") || [...files.keys()].some((path) => path.startsWith(WS) || path.startsWith("cron/") || path.startsWith("skills/")));

// "30m" / "2h" / "1d" → ms. Undefined for anything else — the caller words the fallback.
const durationMs = (raw: string): number | undefined => {
    const match = raw.match(/^(\d+)\s*(s|m|h|d)$/);
    if (match === null) {
        return undefined;
    }
    const scale = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
    return Number(match[1]) * scale;
};

/* An interval into a cron line, only where cron can say it cleanly. "Every 90 minutes" has no honest cron
 * spelling, and approximating one would fire the owner's job on a rhythm they never chose — refusing with the
 * reason is the better answer. */
const everyCron = (ms: number): string | undefined => {
    if (ms < 60_000 || ms % 60_000 !== 0) {
        return undefined;
    }
    const minutes = ms / 60_000;
    if (minutes < 60) {
        return `*/${minutes} * * * *`;
    }
    if (minutes % 60 !== 0) {
        return undefined;
    }
    const hours = minutes / 60;
    if (hours < 24) {
        return `0 */${hours} * * *`;
    }
    return hours === 24 ? `0 0 * * *` : undefined;
};

export const planOpenclaw = (files: Files): SourcePlan => {
    const planned: PlannedItem[] = [];
    const refused: string[] = [];
    const needsAction: { subject: string; detail: string }[] = [];

    const config = ((): Record<string, unknown> => {
        const raw = text(files, "openclaw.json");
        if (raw === undefined) {
            return {};
        }
        const parsed = asRecord(parseJson5ish(raw));
        if (parsed === undefined) {
            refused.push("openclaw.json (hand-edited beyond what this reader accepts — items that live in it were skipped)");
            return {};
        }
        return parsed;
    })();
    const defaults = asRecord(asRecord(config["agents"])?.["defaults"]) ?? {};

    // -- memory: the bootstrap files, each its own fence; daily logs tail-merged and fully kept as files --
    const fenced = (id: string, label: string, heading: string, body: string, detail?: string): void => {
        planned.push({
            item: { id: `memory:${id}`, target: "memory", label, ...(detail === undefined ? {} : { detail }), recommended: true, secrets: [] },
            apply: { target: "memory", fence: `intentic:imported-openclaw:${id}`, body: `## ${heading}\n\n${clipped(body.trim())}` },
        });
    };
    const soul = text(files, `${WS}SOUL.md`);
    if (soul !== undefined && soul.trim() !== "") {
        fenced(
            "soul",
            "Personality — SOUL.md",
            "Imported personality (OpenClaw SOUL.md)",
            soul,
            "Merged into the agent's memory files as standing context. Make it a persona later if the agent should act as this character.",
        );
    }
    const identity = text(files, `${WS}IDENTITY.md`);
    if (identity !== undefined && identity.trim() !== "") {
        fenced("identity", "Identity — IDENTITY.md", "Imported identity (OpenClaw IDENTITY.md)", identity);
    }
    const agentsNotes = text(files, `${WS}AGENTS.md`);
    if (agentsNotes !== undefined && agentsNotes.trim() !== "") {
        fenced("agents", "Operating notes — AGENTS.md", "Imported operating notes (OpenClaw AGENTS.md)", agentsNotes);
    }
    /* USER.md and MEMORY.md are the curated stores; the daily logs are an append-only diary that can run to
     * hundreds of files. The memory files every turn reads get the curated stores plus the newest two weeks;
     * the WHOLE diary rides to imports/ where the agent can search it without it costing every turn. */
    const dailies = [...files.keys()]
        .filter((path) => path.startsWith(`${WS}memory/`) && path.endsWith(".md"))
        .toSorted((left, right) => right.localeCompare(left));
    const RECENT_DAILIES = 14;
    const curated = [`${WS}USER.md`, `${WS}MEMORY.md`, ...dailies.slice(0, RECENT_DAILIES).toReversed()]
        .map((path) => ({ path: path.slice(WS.length), body: (text(files, path) ?? "").trim() }))
        .filter((section) => section.body !== "")
        .map((section) => `### ${section.path}\n\n${clipped(section.body)}`);
    if (curated.length > 0) {
        planned.push({
            item: {
                id: "memory:memories",
                target: "memory",
                label: `Long-term memory — ${curated.length} file${curated.length === 1 ? "" : "s"}`,
                ...(dailies.length > RECENT_DAILIES ? { detail: `The newest ${RECENT_DAILIES} daily notes; the full diary rides along below.` } : {}),
                recommended: true,
                secrets: [],
            },
            apply: { target: "memory", fence: "intentic:imported-openclaw:memory", body: `## Imported memory (OpenClaw)\n\n${curated.join("\n\n")}` },
        });
    }
    if (dailies.length > 0) {
        planned.push({
            item: {
                id: "file:memory-diary",
                target: "file",
                label: `Daily memory notes — ${dailies.length} file${dailies.length === 1 ? "" : "s"}`,
                detail: "Lands in imports/openclaw/memory/ for the agent to search, without loading every turn.",
                recommended: true,
                secrets: [],
            },
            apply: {
                target: "file",
                files: dailies.toReversed().map((path) => ({
                    relPath: `imports/openclaw/memory/${path.slice(`${WS}memory/`.length)}`,
                    content: files.get(path) ?? Buffer.alloc(0),
                })),
            },
        });
    }

    // -- skills: the workspace folder outranks the managed one, exactly as it does at the source --
    const takenSkills = new Set<string>();
    planned.push(...planSkillFiles(files, `${WS}skills/`, "OpenClaw", takenSkills, refused));
    planned.push(...planSkillFiles(files, "skills/", "OpenClaw", takenSkills, refused));

    // -- secrets: .env, the config's env section, inline channel tokens, auth-profile api keys --
    const secrets = secretPlanner(planned, refused, ["OPENCLAW_"]);
    const envRaw = text(files, ".env");
    if (envRaw !== undefined) {
        for (const [key, value] of Object.entries({ ...parseEnv(envRaw) } as Record<string, string>).toSorted(([left], [right]) =>
            left.localeCompare(right),
        )) {
            secrets.plan(key, value, ".env");
        }
    }
    const envSection = asRecord(config["env"]) ?? {};
    for (const [key, value] of Object.entries(asRecord(envSection["vars"]) ?? envSection).toSorted(([left], [right]) => left.localeCompare(right))) {
        const literal = asString(value);
        if (literal !== undefined) {
            secrets.plan(key, literal, "openclaw.json env");
        }
    }
    const CHANNEL_TOKEN_KEYS = ["botToken", "token", "appToken", "authToken", "signingSecret"] as const;
    const channels = asRecord(config["channels"]) ?? {};
    for (const [channel, entry] of Object.entries(channels).toSorted(([left], [right]) => left.localeCompare(right))) {
        const record = asRecord(entry);
        for (const key of CHANNEL_TOKEN_KEYS) {
            const value = asString(record?.[key]);
            if (value !== undefined) {
                secrets.plan(
                    `${channel.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}_${key.replaceAll(/([A-Z])/g, "_$1").toUpperCase()}`,
                    value,
                    `openclaw.json channels.${channel}`,
                );
            }
        }
    }
    for (const path of [...files.keys()].filter((candidate) => /^agents\/[^/]+\/agent\/auth-profiles\.json$/.test(candidate)).toSorted()) {
        const profiles = ((): Record<string, unknown> => {
            try {
                return asRecord(JSON.parse(text(files, path) ?? "")) ?? {};
            } catch {
                refused.push(`${path} (not readable as JSON)`);
                return {};
            }
        })();
        // Tolerant of one nesting level ({profiles: {...}}) and of either key spelling for the api key.
        for (const [profile, entry] of Object.entries(asRecord(profiles["profiles"]) ?? profiles).toSorted(([left], [right]) =>
            left.localeCompare(right),
        )) {
            const record = asRecord(entry);
            const apiKey = asString(record?.["apiKey"]) ?? asString(record?.["api_key"]);
            if (apiKey !== undefined) {
                secrets.plan(`${profile.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}_API_KEY`, apiKey, path);
            }
            if (
                asString(record?.["access_token"]) !== undefined ||
                asString(record?.["refresh_token"]) !== undefined ||
                record?.["oauth"] !== undefined
            ) {
                refused.push(`${path}: ${profile} OAuth tokens (bound to that install — sign in fresh here)`);
            }
        }
    }

    // -- MCP servers --
    const capabilityId = idPool();
    const mcpSection = asRecord(config["mcp"]) ?? {};
    for (const [name, entry] of Object.entries(asRecord(mcpSection["servers"]) ?? mcpSection).toSorted(([left], [right]) =>
        left.localeCompare(right),
    )) {
        const server = asRecord(entry);
        if (server !== undefined) {
            planMcpEntry(name, server, `openclaw.json: mcp.${name}`, capabilityId, { planned, refused, needsAction });
        }
    }

    // -- cron jobs, plus the heartbeat file as one more scheduled prompt --
    const planCron = automationPlanner("openclaw", planned, refused);
    const timezones = new Set<string>();
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
            if (record === undefined) {
                continue;
            }
            const jobName = asString(record["name"]) ?? asString(record["id"]) ?? `job-${index + 1}`;
            const schedule = asRecord(record["schedule"]);
            const prompt = asString(asRecord(record["payload"])?.["message"]) ?? asString(record["message"]) ?? asString(record["prompt"]);
            if (schedule === undefined || prompt === undefined) {
                continue;
            }
            const kind = asString(schedule["kind"]);
            if (kind === "at") {
                refused.push(`${path}: "${jobName}" (a one-time job — recreate it here if it is still wanted)`);
                continue;
            }
            const cron = ((): string | undefined => {
                if (kind === "every") {
                    const ms = typeof schedule["everyMs"] === "number" ? schedule["everyMs"] : durationMs(asString(schedule["every"]) ?? "");
                    return ms === undefined ? undefined : everyCron(ms);
                }
                return asString(schedule["expr"]) ?? asString(schedule["cron"]);
            })();
            if (cron === undefined) {
                refused.push(`${path}: "${jobName}" (its interval has no clean cron spelling — recreate it by hand)`);
                continue;
            }
            const tz = asString(schedule["tz"]);
            if (tz !== undefined) {
                timezones.add(tz);
            }
            planCron(jobName, record, path, { cron, prompt });
        }
    }
    if (timezones.size > 0) {
        needsAction.push({
            subject: "Check automation hours",
            detail: `Some jobs ran in ${[...timezones].join(", ")}; here they follow this sandbox's clock. Adjust the hours on their cards if the difference matters.`,
        });
    }
    const heartbeat = text(files, `${WS}HEARTBEAT.md`);
    if (heartbeat !== undefined && heartbeat.trim() !== "") {
        const every = asString(asRecord(defaults["heartbeat"])?.["every"]);
        const ms = every === undefined ? undefined : durationMs(every);
        const cron = (ms === undefined ? undefined : everyCron(ms)) ?? "0 * * * *";
        planCron("heartbeat", { name: "heartbeat" }, `${WS}HEARTBEAT.md`, { cron, prompt: heartbeat.trim() });
    }

    // -- loose workspace notes: kept under imports/, minus the one-time bootstrap ritual --
    const HANDLED = new Set(["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "AGENTS.md", "HEARTBEAT.md", "BOOTSTRAP.md"]);
    for (const path of [...files.keys()]
        .filter((candidate) => candidate.startsWith(WS) && candidate.endsWith(".md") && !candidate.slice(WS.length).includes("/"))
        .toSorted()) {
        const name = path.slice(WS.length);
        const content = files.get(path);
        if (HANDLED.has(name) || content === undefined || content.toString("utf8").trim() === "") {
            continue;
        }
        planned.push({
            item: {
                id: `file:${name}`,
                target: "file",
                label: `Note — ${name}`,
                detail: `Lands in imports/openclaw/${name}.`,
                recommended: true,
                secrets: [],
            },
            apply: { target: "file", files: [{ relPath: `imports/openclaw/${name}`, content }] },
        });
    }

    // -- what is already known not to move --
    for (const [channel, entry] of Object.entries(channels).toSorted(([left], [right]) => left.localeCompare(right))) {
        if (asRecord(entry)?.["enabled"] !== true) {
            continue;
        }
        const tokenKey = `${channel.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}_BOT_TOKEN`;
        needsAction.push({
            subject: `Reconnect ${channel}`,
            detail:
                channel === "whatsapp"
                    ? "Pair WhatsApp again from its connector — pairing state desynchronizes when copied, which is why none of it travels."
                    : `You had ${channel} wired into OpenClaw's gateway. Add the ${channel} connector from the capabilities grid${
                          secrets.has(tokenKey) ? ` — its token rides along as the ${tokenKey} secret when you tick it` : ""
                      }.`,
        });
    }
    const primary = asString(asRecord(defaults["model"])?.["primary"]);
    if (primary !== undefined) {
        const provider = primary.split("/")[0] ?? "";
        needsAction.push({
            subject: "Pick your model provider",
            detail: `OpenClaw ran on ${primary} — ${
                PROVIDER_HINTS[provider.toLowerCase()] ?? "point a custom model endpoint at it, or pick a native provider"
            }. Provider logins never travel in a migration.`,
        });
    }
    if ((asArray(asRecord(defaults["model"])?.["fallbacks"]) ?? []).length > 0) {
        refused.push("openclaw.json: model fallbacks (no equivalent here — the chat picker and automations pin models per use instead)");
    }
    const workspacePath = asString(defaults["workspace"]);
    const workspacePacked = [...files.keys()].some((path) => path.startsWith(WS));
    if (!workspacePacked && workspacePath !== undefined) {
        needsAction.push({
            subject: "Pack your workspace too",
            detail: `The config points the agent's workspace at ${workspacePath}, which is not in this archive. Copy that folder to ~/.openclaw/workspace and pack again to bring its memory, skills and notes.`,
        });
    }
    if (config["hooks"] !== undefined) {
        refused.push("openclaw.json: hooks (webhook endpoints — recreate the ones still wanted as event-trigger automations here)");
    }
    refused.push("openclaw.json (translated into the items above, not copied — it can hold inline tokens)");

    return { planned, refused: refused.toSorted((left, right) => left.localeCompare(right)), needsAction };
};
