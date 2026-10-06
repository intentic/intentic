import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentHome } from "@intentic/local-agent";
import { z } from "zod";

/* Bridge configuration: where the sandbox is and which credential/agent to use. */

const CONFIG_DIR = agentHome("acp").dir;

const StoredConfigSchema = z.object({ url: z.string(), token: z.string(), agent: z.string().optional() });

export interface BridgeConfig {
    readonly url: string;
    readonly token: string;
    // The sandbox provider this bridge serves: claude (default) | codex | grok | an ACP capability id.
    readonly agent: string;
    readonly model: string | undefined;
}

const readStored = (path: string): z.infer<typeof StoredConfigSchema> | undefined => {
    try {
        const parsed = StoredConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
};

// Environment first, then the login-written config file; undefined when neither supplies url+token (the
// bridge then advertises its auth methods and answers session/new with auth_required).
export const resolveConfig = (env: Record<string, string | undefined> = process.env, dir: string = CONFIG_DIR): BridgeConfig | undefined => {
    const stored = readStored(join(dir, "config.json"));
    const url = env["INTENTIC_SANDBOX_URL"] ?? stored?.url;
    const token = env["INTENTIC_CONTROL_TOKEN"] ?? stored?.token;
    if (url === undefined || url === "" || token === undefined || token === "") {
        return undefined;
    }
    return {
        url: url.replace(/\/$/, ""),
        token,
        agent: env["INTENTIC_AGENT"] ?? stored?.agent ?? "claude",
        model: env["INTENTIC_MODEL"],
    };
};

export const writeConfig = (config: { url: string; token: string; agent?: string }, dir: string = CONFIG_DIR): string => {
    const path = join(dir, "config.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, undefined, 2)}\n`, { mode: 0o600 });
    return path;
};

// ACP session id → the daemon-side identity behind it. `agent` is recorded so a provider switch never
// resumes a foreign runtime's session (the daemon would reject it anyway, this fails cleanly earlier).
const SessionMapSchema = z.record(z.string(), z.object({ conversationId: z.string(), agent: z.string(), providerSessionId: z.string().optional() }));
export type SessionMap = z.infer<typeof SessionMapSchema>;

// Every write rewrites the whole map, so a file that cannot be parsed is set aside and said on stderr (stdout carries
// the protocol) before the empty map replaces it; any other read failure throws rather than being written over.
export const readSessions = (dir: string = CONFIG_DIR): SessionMap => {
    const path = join(dir, "sessions.json");
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {};
        }
        throw error;
    }
    let parsed: ReturnType<typeof SessionMapSchema.safeParse> | undefined;
    try {
        parsed = SessionMapSchema.safeParse(JSON.parse(text));
    } catch {
        parsed = undefined;
    }
    if (parsed?.success === true) {
        return parsed.data;
    }
    const aside = `${path}.unreadable-${Date.now()}`;
    renameSync(path, aside);
    process.stderr.write(`intentic acp: ${path} could not be read as a session map; kept it as ${aside} and started a fresh one\n`);
    return {};
};

// Temp-then-rename: a second bridge reading mid-write sees the whole previous map or the whole next one.
export const writeSessions = (sessions: SessionMap, dir: string = CONFIG_DIR): void => {
    const path = join(dir, "sessions.json");
    mkdirSync(dirname(path), { recursive: true });
    const staged = `${path}.${process.pid}.tmp`;
    writeFileSync(staged, `${JSON.stringify(sessions, undefined, 2)}\n`);
    renameSync(staged, path);
};
