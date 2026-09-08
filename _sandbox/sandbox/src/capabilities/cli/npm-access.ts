import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectorHook } from "./connector-hooks.js";

// npm as a ConnectorHook: npm reads the registry token from ~/.npmrc, not a per-request header, so apply/restore upsert
// the registry's _authToken line there (mode 0600) and remove strips it. One line per registry: the last-applied token
// for a registry wins.

const NPM_AUTH_KEY = "//registry.npmjs.org/:_authToken=";

const npmrcPath = (): string => join(homedir(), ".npmrc");

// Keeps any other ~/.npmrc content untouched; exported pure so tests skip the HOME dance.
export const upsertNpmAuth = (content: string, token: string): string => {
    const kept = content.split("\n").filter((line) => line.trim() !== "" && !line.startsWith(NPM_AUTH_KEY));
    return `${[...kept, `${NPM_AUTH_KEY}${token}`].join("\n")}\n`;
};

export const stripNpmAuth = (content: string): string => {
    const kept = content.split("\n").filter((line) => line.trim() !== "" && !line.startsWith(NPM_AUTH_KEY));
    return kept.length > 0 ? `${kept.join("\n")}\n` : "";
};

const writeNpmAuth = async (token: string): Promise<void> => {
    const current = await readFile(npmrcPath(), "utf8").catch(() => "");
    await writeFile(npmrcPath(), upsertNpmAuth(current, token), { mode: 0o600 });
};

// True only if the token line is actually on disk; a wiped HOME reports unwired rather than a stale active card.
export const npmAuthWired = async (): Promise<boolean> => (await readFile(npmrcPath(), "utf8").catch(() => "")).includes(NPM_AUTH_KEY);

export const npmAccessHook: ConnectorHook = {
    silent: true,
    apply: async (config) => {
        await writeNpmAuth(config["token"] ?? "");
        return undefined;
    },
    remove: async () => {
        const current = await readFile(npmrcPath(), "utf8").catch(() => "");
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
