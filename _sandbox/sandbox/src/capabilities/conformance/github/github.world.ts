import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { CliConfig, Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { GitAccessDeps } from "../../cli/git-access.js";
import { gitHostOf } from "../../cli/git-access.js";
import type { ExecInTerminal } from "../../../terminal/terminal-run.js";
import type { RuleAsk } from "../../broker/broker-gateway.js";
import { nodeRequest } from "../../../system/tls/node-request.js";
import { cardHost, installSkill, loadCard } from "../kit/card.js";
import { cleanupStack, type CleanupStack } from "../kit/cleanup.js";
import { runCommand, shellQuote, successful } from "../kit/command.js";
import { redirectedFetch, redirectedNodeRequest, startGateway } from "../kit/gateway.js";
import { httpsProxy } from "../kit/https-proxy.js";
import type { WorldKind } from "../kit/scenario.js";
import { type GithubFake, startGithubFake } from "./github.fake.js";
import type { created } from "../../../definition/workspace-repo.js";

const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

const GITHUB_ORIGINS = ["https://api.github.com", "https://github.com"] as const;

type Run = (command: string) => Promise<string>;

// Scratch branches stay registered until deleted, so afterAll retries every one even when a scenario fails.
const scratchBranches = (agent: Run, cleanup: CleanupStack) => {
    const branches = new Map<string, string>();
    const deleteBranch = async (branch: string): Promise<void> => {
        const clone = branches.get(branch);
        if (clone === undefined) {
            return;
        }
        const ref = await agent(`git -C ${shellQuote(clone)} ls-remote origin ${shellQuote(`refs/heads/${branch}`)}`);
        if (ref.trim() !== "") {
            await agent(`git -C ${shellQuote(clone)} push origin ${shellQuote(`:refs/heads/${branch}`)}`);
        }
        branches.delete(branch);
    };
    cleanup.add(async () => {
        const results = await Promise.allSettled([...branches.keys()].map(deleteBranch));
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
            throw new AggregateError(
                failures.map((failure) => failure.reason),
                "scratch branch cleanup failed",
            );
        }
    });
    return { branches, deleteBranch };
};

// Account calls go through the existing GitAccessDeps seam: the fake counts key uploads, live never registers a key.
const githubGitDeps = (fake: GithubFake | undefined, transport: typeof fetch): GitAccessDeps => ({
    uploadKey: async (gitHost, key, title) => {
        if (fake === undefined) {
            throw new Error("live conformance never registers account SSH keys");
        }
        const answer = await transport(`${gitHost.apiBase}/user/keys`, {
            method: "POST",
            headers: { authorization: `Bearer ${gitHost.token}`, "content-type": "application/json" },
            body: JSON.stringify({ key, title }),
        });
        if (!answer.ok) {
            throw new Error(`GitHub SSH key upload failed (${String(answer.status)}): ${await answer.text()}`);
        }
    },
    deleteKey: async () => {
        throw new Error("conformance must not delete account keys");
    },
    keyAuthenticates: async () => false,
});

// The owner's terminal: only what git-access wrote to that HOME, never the broker's env.
const ownerTerminal = (ownerEnv: Readonly<Record<string, string>>) => {
    const owner = (ownerHome: string, command: string, input?: string) => runCommand(command, { home: ownerHome, env: ownerEnv, input });
    const execFor =
        (ownerHome: string): ExecInTerminal =>
        async (file, args) => ({ stdout: await successful(owner(ownerHome, [file, ...args].map(shellQuote).join(" "))) });
    return { owner, execFor };
};

// The fake world serves github.com behind a trusted CONNECT proxy for the owner's git; the live world reaches GitHub.
const upstream = async (kind: WorldKind, root: string, cleanup: CleanupStack) => {
    if (kind === "live") {
        return { fake: undefined, ownerEnv: {}, transport: fetch, probeRequest: nodeRequest };
    }
    const fake = await startGithubFake(root);
    cleanup.add(fake.close);
    const proxy = await httpsProxy(root, "github.com", fake.origin);
    cleanup.add(proxy.close);
    const origins = Object.fromEntries(GITHUB_ORIGINS.map((origin) => [origin, fake.origin]));
    return { fake, ownerEnv: proxy.env, transport: redirectedFetch(origins), probeRequest: redirectedNodeRequest(origins) };
};

export const githubWorld = async (kind: WorldKind, createRepository: typeof created) => {
    const root = await mkdtemp(join(tmpdir(), "github-conformance-"));
    const cleanup = cleanupStack("GitHub world");
    cleanup.add(async () => rm(root, { recursive: true, force: true }));
    try {
        const { fake, ownerEnv, transport, probeRequest } = await upstream(kind, root, cleanup);
        const token = fake?.token ?? z.string().min(1).parse(process.env["GITHUB_E2E_TOKEN"]);
        const scratch = fake?.repo ?? (process.env["GITHUB_E2E_REPO"] || undefined);
        if (scratch !== undefined) {
            repositoryName.parse(scratch);
        }
        const config: CliConfig = { provider: "github", token, git: "on" };
        const card: Capability = { id: "github", kind: "cli", config };
        const home = join(root, "agent-home");
        await mkdir(home);
        const host = cardHost(root, card);
        const { registry, contribution } = await loadCard(host, config.provider);
        const asks: RuleAsk[] = [];
        const gateway = await startGateway({
            host,
            card,
            spec: contribution.spec,
            fetch: transport,
            ask: async (input) => {
                asks.push(input);
                return { allow: false, reason: "conformance owner denied repository deletion" };
            },
        });
        cleanup.add(gateway.close);
        const skill = await installSkill(host, card);
        const agent = (command: string, cwd = home) => runCommand(command, { home, cwd, env: { ...ownerEnv, ...gateway.env } });
        const { branches, deleteBranch } = scratchBranches(async (command) => successful(agent(command)), cleanup);
        return {
            kind,
            root,
            home,
            config,
            card,
            registry,
            spec: contribution.spec,
            skill,
            token,
            repo: scratch ?? "octocat/Hello-World",
            scratch,
            fake,
            asks,
            gateway,
            transport,
            probeRequest,
            agent,
            ...ownerTerminal(ownerEnv),
            gitDeps: githubGitDeps(fake, transport),
            gitHost: gitHostOf(config),
            branches,
            deleteBranch,
            createRepository,
            close: cleanup.close,
        };
    } catch (error) {
        await cleanup.close().catch(() => {
            // allow(silent-catch): the setup failure is the one to report; cleanup failures behind it add nothing.
        });
        throw error;
    }
};

export type GithubWorld = Awaited<ReturnType<typeof githubWorld>>;
