import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectorHook } from "./connector-hooks.js";

/* npm auth as a ConnectorHook: the npm card's token has to reach the npm CLI ITSELF, publish, dist-tag,
 * deprecate, owner and private installs all read ~/.npmrc, and npm takes no bearer per-invocation the way curl
 * takes a header. So apply upserts the registry's _authToken line into ~/.npmrc (0600; the ~/.git-credentials
 * precedent, a secret-bearing write is a plain fs call, never a visible command), remove strips it, and
 * restore rewrites it at boot: the line lives in the container's ephemeral HOME and dies with a recreate while
 * the connection survives on /work (the same seam git access rides, see connector-hooks.ts).
 *
 * One line per REGISTRY, not per instance: two npm connections both authenticate registry.npmjs.org, so the
 * last-applied token wins and removing either strips the line, the same semantics two github connections
 * already have on one ~/.git-credentials host line. */

const NPM_AUTH_KEY = "//registry.npmjs.org/:_authToken=";

const npmrcPath = (): string => join(homedir(), ".npmrc");

// Upsert the auth line, preserving whatever else the user's ~/.npmrc holds (registry mirrors, save-exact, …).
// Exported pure so tests cover the rewrite without a HOME dance.
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

// Whether the container-local credential is actually in place, what the npm card's status asks, so a wiped
// HOME reads as "needs a re-add" instead of an active card over a 401ing npm.
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
