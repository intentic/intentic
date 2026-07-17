import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/* Bridge configuration: where the sandbox is and which credential/agent to use. Environment wins (the
 * editor's agent_servers env block / the ACP env_var auth method); the config file written by
 * `intentic-acp login` is the fallback — the ~/.intentic home the sync agent also uses. The session map
 * persists ACP-session → daemon-conversation identities so editors can resume across bridge restarts. */

const CONFIG_DIR = join(homedir(), ".intentic", "acp");

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
    const token = env["INTENTIC_BRIDGE_TOKEN"] ?? stored?.token;
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
// resumes a foreign runtime's session (the daemon would reject it anyway — this fails cleanly earlier).
const SessionMapSchema = z.record(
    z.string(),
    z.object({ conversationId: z.string(), agent: z.string(), providerSessionId: z.string().optional() }),
);
export type SessionMap = z.infer<typeof SessionMapSchema>;

export const readSessions = (dir: string = CONFIG_DIR): SessionMap => {
    try {
        const parsed = SessionMapSchema.safeParse(JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
};

export const writeSessions = (sessions: SessionMap, dir: string = CONFIG_DIR): void => {
    const path = join(dir, "sessions.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(sessions, undefined, 2)}\n`);
};
