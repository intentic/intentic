import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { repoRoot } from "@intentic/constants/node";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { fetchTracked } from "../../git/remote/follow-upstream.js";
import { brokerSessionsFrom } from "./broker-session.js";
import { createGateway } from "./broker-gateway.js";
import { brokerOf } from "./broker-routes.js";
import { contributionFor, contributionRegistry } from "../contributions.js";
import { listen } from "../conformance/kit/http.js";
import { daemonGitEnv, type DaemonGitEnvDeps } from "./daemon-git-env.js";

// Issue #46: the daemon's own git (following a remote, the turn-start sync, Fetch, Pull, Back up) had none of the
// credential gateway's rewrites a turn's shell gets, so a forge whose credential only the gateway holds (an extension's
// Forgejo connector) failed every background fetch on "could not read Username".

const FORGE_TOKEN = "forge-secret-token";

// A connector an extension contributes, as a Forgejo one would: its git route served only through the gateway. Beside it
// the first-party connectors, whose GitHub and GitLab write their own credential for git (cli/git-access.ts).
const extensionsDir = (): string => {
    const root = mkdtempSync(join(tmpdir(), "daemon-git-ext-"));
    mkdirSync(join(root, "connectors"));
    copyFileSync(join(repoRoot(import.meta.url), "_extensions", "connectors", "intentic-extension.json"), join(root, "connectors", "intentic-extension.json"));
    mkdirSync(join(root, "forge", "skills", "forge"), { recursive: true });
    writeFileSync(join(root, "forge", "skills", "forge", "SKILL.md"), "---\nname: forge\ndescription: d\n---\n");
    writeFileSync(
        join(root, "forge", "intentic-extension.json"),
        JSON.stringify({
            publisher: "test",
            name: "forge",
            version: "1.0.0",
            engines: { intentic: "^2.0.0" },
            contributes: {
                capabilities: [
                    {
                        id: "forge",
                        kind: "cli",
                        catalog: { name: "Forge", description: "d", category: "c" },
                        fields: [
                            { key: "url", label: "URL" },
                            { key: "token", label: "Token", secret: true },
                        ],
                        env: { FORGE_TOKEN: "${token}" },
                        skill: "skills/forge/SKILL.md",
                        broker: {
                            routes: [{ upstream: "${url}", env: "FORGE_GIT_URL", basic: { username: "git", password: "${token}" }, git: true }],
                        },
                    },
                ],
            },
        }),
    );
    return root;
};

const sessions = brokerSessionsFrom(async () => Buffer.alloc(32, 3));

const servicesFor = (capabilities: Capability[], origin: string): DaemonGitEnvDeps => ({
    workspace: { root: mkdtempSync(join(tmpdir(), "daemon-git-ws-")) },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => capabilities },
    config: { extensionsDir: EXTENSIONS, historyRoot: mkdtempSync(join(tmpdir(), "daemon-git-history-")) },
    brokerSessions: sessions,
    gatewayOrigin: origin,
    credentialPolicy: { of: async () => ({}) },
});

const EXTENSIONS = extensionsDir();

const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// The forge itself: `git http-backend` over a bare repository, answering only a request carrying the card's token,
// as a private repository on a real forge does.
const startForge = async (projectRoot: string) => {
    const server = createServer((request, response) => {
        const expected = `Basic ${Buffer.from(`git:${FORGE_TOKEN}`).toString("base64")}`;
        if (request.headers.authorization !== expected) {
            response.writeHead(401, { "www-authenticate": 'Basic realm="forge"' }).end();
            return;
        }
        const url = new URL(request.url ?? "/", "http://forge");
        const cgi = spawn("git", ["http-backend"], {
            env: {
                ...process.env,
                GIT_PROJECT_ROOT: projectRoot,
                GIT_HTTP_EXPORT_ALL: "1",
                PATH_INFO: url.pathname,
                QUERY_STRING: url.search.slice(1),
                REQUEST_METHOD: request.method ?? "GET",
                CONTENT_TYPE: request.headers["content-type"] ?? "",
                HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
            },
        });
        request.pipe(cgi.stdin);
        const chunks: Buffer[] = [];
        cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        cgi.on("close", () => {
            const out = Buffer.concat(chunks);
            const split = out.indexOf("\r\n\r\n");
            const headers: Record<string, string> = {};
            let status = 200;
            for (const line of out.subarray(0, split).toString("utf8").split("\r\n")) {
                const [name = "", ...rest] = line.split(":");
                if (name.toLowerCase() === "status") {
                    status = Number(rest.join(":").trim().split(" ")[0]);
                } else if (name !== "") {
                    headers[name] = rest.join(":").trim();
                }
            }
            response.writeHead(status, headers).end(out.subarray(split + 4));
        });
    });
    return listen(server);
};

// The daemon's credential gateway, as the daemon composes it: the card's live settings, no owner rules, no guards.
const startGateway = async (card: Capability, ask: () => never) => {
    const registry = await contributionRegistry(servicesFor([card], ""));
    const spec = contributionFor(registry, "cli", card.config)?.spec;
    const broker = spec === undefined ? undefined : brokerOf(spec);
    if (spec === undefined || broker === undefined || card.kind !== "cli") {
        throw new Error("the forge connector did not load");
    }
    const handler = createGateway({
        sessions,
        card: async (id) => (id === card.id ? { config: card.config, broker, name: spec.catalog.name } : undefined),
        ownerRules: async () => undefined,
        hostGuards: async () => [],
        credentialGate: { check: async () => ({ allow: true }) },
        prompts: { canPark: (conversationId) => conversationId !== undefined, passed: () => false, ask },
        used: () => {},
    });
    return listen(createServer(getRequestListener(handler)));
};

test("the daemon's own fetch reaches a forge whose credential only the gateway holds", async () => {
    const projects = mkdtempSync(join(tmpdir(), "daemon-git-forge-"));
    const seed = mkdtempSync(join(tmpdir(), "daemon-git-seed-"));
    git(seed, "init", "--quiet", "-b", "main");
    git(seed, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "--allow-empty", "-m", "first");
    execFileSync("git", ["clone", "--quiet", "--bare", seed, join(projects, "repo.git")]);
    const forge = await startForge(projects);
    const forgeCard: Capability = { id: "forge", kind: "cli", config: { provider: "forge", url: forge.origin, token: FORGE_TOKEN } };
    const gateway = await startGateway(forgeCard, () => {
        throw new Error("a background fetch must never raise a card");
    });
    try {
        // A checkout following the forge, as the owner's clone of it is.
        const checkout = mkdtempSync(join(tmpdir(), "daemon-git-checkout-"));
        git(checkout, "init", "--quiet", "-b", "main");
        git(checkout, "remote", "add", "origin", `${forge.origin}/repo.git`);

        // Before: what follow-origin ran with, and what the issue's daemon.log shows.
        const without = await fetchTracked(checkout, "origin");
        expect(without.ok).toBe(false);
        expect(without.ok ? "" : without.reason).toMatch(/could not read Username|terminal prompts disabled|Authentication failed/);

        const env = await daemonGitEnv(servicesFor([forgeCard], gateway.origin));
        expect(JSON.stringify(env)).not.toContain(FORGE_TOKEN);
        expect(await fetchTracked(checkout, "origin", env)).toEqual({ ok: true });
        expect(git(checkout, "rev-parse", "origin/main")).toBe(git(seed, "rev-parse", "HEAD"));
    } finally {
        await gateway.close();
        await forge.close();
    }
});

test("daemon git env: signed for no conversation, and none for a card whose credential git already reaches", async () => {
    const forge: Capability = { id: "forge", kind: "cli", config: { provider: "forge", url: "https://forge.example.com", token: "t" } };
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "ghp" } };
    const env = await daemonGitEnv(servicesFor([forge, github], "http://127.0.0.1:8790"));

    expect(Object.keys(env).every((key) => key.startsWith("GIT_CONFIG_"))).toBe(true);
    // forge.example.com at its host's root: the https spelling and both ssh ones, and nothing for github.com.
    expect(env["GIT_CONFIG_COUNT"]).toBe("3");
    expect([env["GIT_CONFIG_VALUE_0"], env["GIT_CONFIG_VALUE_1"], env["GIT_CONFIG_VALUE_2"]].toSorted()).toEqual([
        "git@forge.example.com:",
        "https://forge.example.com/",
        "ssh://git@forge.example.com/",
    ]);
    const token = /^url\.http:\/\/127\.0\.0\.1:8790\/([^/]+)\/\.insteadOf$/.exec(env["GIT_CONFIG_KEY_0"] ?? "")?.[1] ?? "";
    expect(await sessions.verify(token)).toEqual({ capability: "forge", route: 0, upstream: "https://forge.example.com/", conversationId: undefined });
});
