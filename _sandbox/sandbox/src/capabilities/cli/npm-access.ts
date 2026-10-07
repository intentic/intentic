import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { BROKER_PORT } from "@intentic/constants";
import { GATEWAY_PLACEHOLDER } from "../broker/broker-routes.js";
import type { ConnectorHook } from "./connector-hooks.js";
import { homeDir } from "../../system/home-dir.js";

// npm as a ConnectorHook: npm reads the registry token from ~/.npmrc, not a per-request header, so apply/restore upsert
// the registry's _authToken line there (mode 0600) and remove strips it. One line per registry: the last-applied token
// for a registry wins.

const NPM_AUTH_KEY = "//registry.npmjs.org/:_authToken=";

// The credential gateway's own line: the placeholder for every address it issues (npm finds a registry's token by
// walking up its path, so the bare host covers each per-conversation address). Without it npm refuses to publish to the
// gateway at all (ENEEDAUTH); with it, npm sends the placeholder, which the gateway replaces with the real token. Not a
// secret: written so the agent's npm works, and it authenticates nothing anywhere else.
const GATEWAY_AUTH_LINE = `//127.0.0.1:${String(BROKER_PORT)}/:_authToken=${GATEWAY_PLACEHOLDER}`;
const GATEWAY_AUTH_KEY = GATEWAY_AUTH_LINE.slice(0, GATEWAY_AUTH_LINE.indexOf("=") + 1);

const ownLine = (line: string): boolean => line.startsWith(NPM_AUTH_KEY) || line.startsWith(GATEWAY_AUTH_KEY);

// HOME is the home directory of record, read per call so a test can point it at a temp dir.
const npmrcPath = (): string => join(homeDir(), ".npmrc");

// Keeps any other ~/.npmrc content untouched; exported pure so tests skip the HOME dance.
export const upsertNpmAuth = (content: string, token: string): string => {
    const kept = content.split("\n").filter((line) => line.trim() !== "" && !ownLine(line));
    return `${[...kept, `${NPM_AUTH_KEY}${token}`, GATEWAY_AUTH_LINE].join("\n")}\n`;
};

export const stripNpmAuth = (content: string): string => {
    const kept = content.split("\n").filter((line) => line.trim() !== "" && !ownLine(line));
    return kept.length > 0 ? `${kept.join("\n")}\n` : "";
};

// Only absence reads as empty: a ~/.npmrc that cannot be read is never rewritten as just the token line, nor left
// holding a token its remove believed gone.
const readNpmrc = async (): Promise<string> => (await readFile(npmrcPath(), "utf8").catch(undefinedIfMissing)) ?? "";

const writeNpmAuth = async (token: string): Promise<void> => {
    const current = await readNpmrc();
    await writeFile(npmrcPath(), upsertNpmAuth(current, token), { mode: 0o600 });
};

// True only if the token line is actually on disk; a wiped HOME reports unwired rather than a stale active entry.
export const npmAuthWired = async (): Promise<boolean> => (await readFile(npmrcPath(), "utf8").catch(() => "")).includes(NPM_AUTH_KEY);

export const npmAccessHook: ConnectorHook = {
    silent: true,
    apply: async (config) => {
        await writeNpmAuth(config["token"] ?? "");
        return undefined;
    },
    remove: async () => {
        const current = await readNpmrc();
        if (current === "") {
            return;
        }
        await writeFile(npmrcPath(), stripNpmAuth(current), { mode: 0o600 });
    },
    restore: async (config) => {
        await writeNpmAuth(config["token"] ?? "");
        return undefined;
    },
};
