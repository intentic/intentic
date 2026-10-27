import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { probeCapability } from "../../probe.js";
import { setupGitAccess, restoreGitAccess } from "../../cli/git-access.js";
import { fileSshKeyStore } from "../../ssh-key-store.js";
import { GATEWAY_PLACEHOLDER } from "../../broker/broker-routes.js";
import { skillCommand } from "../kit/card.js";
import { inHome, runCommand, shellQuote, successful } from "../kit/command.js";
import { responseJson, type Scenario } from "../kit/scenario.js";
import { githubSamples, githubResponses } from "./github.fake.js";
import type { GithubWorld } from "./github.world.js";

const ownerSetup = async (world: GithubWorld, label: string) => {
    const home = join(world.root, label);
    await mkdir(home);
    const keys = fileSshKeyStore(join(world.root, `${label}-keys`));
    const exec = world.execFor(home);
    await inHome(home, () => setupGitAccess(world.gitHost, exec, keys, world.gitDeps));
    return { home, keys, exec };
};

const upstreamAuth = (world: GithubWorld, from: number): void => {
    if (world.fake === undefined) {
        return;
    }
    const requests = world.fake.requests.slice(from);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
        expect(request.authorization).toBe(
            request.path.includes(".git/") ? `Basic ${Buffer.from(`x-access-token:${world.token}`).toString("base64")}` : `Bearer ${world.token}`,
        );
        expect(request.headers).not.toContain(GATEWAY_PLACEHOLDER);
    }
};

const skillScenario = <T>(label: string, schema: z.ZodType<T>, sample: T, stream = false): Scenario<GithubWorld> => ({
    name: `documented ${label} through the gateway`,
    run: async (world) => {
        const from = world.fake?.requests.length ?? 0;
        const [owner, repo] = world.repo.split("/");
        const command = skillCommand(world.skill, label, { OWNER: owner!, REPO: repo! });
        expect(world.gateway.env["GITHUB_TOKEN_GITHUB"]).toBe(GATEWAY_PLACEHOLDER);
        expect(JSON.stringify(world.gateway.env).includes(world.token)).toBe(false);
        // Keep the raw reply so jq cannot hide an absent field as null.
        const observed = command.replace(" | jq ", ` | tee ${shellQuote(join(world.home, "response.json"))} | jq `);
        const output = await successful(world.agent(observed));
        const raw = await successful(world.agent(`cat ${shellQuote(join(world.home, "response.json"))}`));
        responseJson(schema, raw);
        // Execute the published command verbatim as well as observing its upstream response.
        const verbatim = await successful(world.agent(command));
        for (const text of [output, verbatim]) {
            const json = stream ? await successful(runCommand("jq -sc .", { home: world.home, input: text })) : text;
            const result = responseJson(schema, json);
            if (world.fake !== undefined) {
                expect(result).toEqual(sample);
            }
        }
        upstreamAuth(world, from);
    },
});

export const conformance: readonly Scenario<GithubWorld>[] = [
    {
        name: "declared probe authenticates and names the token login",
        run: async (world) => {
            const result = await probeCapability(world.registry, world.card, world.probeRequest);
            const user = responseJson(
                githubResponses.user,
                await (await world.transport("https://api.github.com/user", { headers: { authorization: `Bearer ${world.token}` } })).text(),
            );
            expect(result).toEqual({ checked: true, ok: true, who: user.login, message: `Reached GitHub, authenticated as ${user.login}.` });
        },
    },
    {
        name: "bad token has GitHub's refusal contract and a readable probe reason",
        run: async (world) => {
            const token = "intentic-conformance-invalid-token";
            const response = await world.transport("https://api.github.com/user", { headers: { authorization: `Bearer ${token}` } });
            expect(response.status).toBe(401);
            expect(responseJson(githubResponses.refused, await response.text()).message).toBe("Bad credentials");
            const result = await probeCapability(world.registry, { ...world.card, config: { ...world.config, token } }, world.probeRequest);
            expect(result).toEqual({ checked: true, ok: false, message: "GitHub answered 401: the credential was refused." });
        },
    },
    skillScenario("Who am I", githubResponses.user, githubSamples.user),
    skillScenario("Your repos", githubResponses.repos, githubSamples.repos, true),
    skillScenario("Open issues in a repo", githubResponses.issues, githubSamples.issues, true),
    {
        name: "agent ls-remote and clone use the environment rewrite",
        run: async (world) => {
            const from = world.fake?.requests.length ?? 0;
            for (const url of [
                `https://github.com/${world.repo}.git`,
                `git@github.com:${world.repo}.git`,
                `ssh://git@github.com/${world.repo}.git`,
            ]) {
                expect(await successful(world.agent(`git ls-remote ${shellQuote(url)} HEAD`))).toMatch(/^[a-f0-9]{40}\s+HEAD/mu);
            }
            const clone = join(world.home, "read-clone");
            await successful(world.agent(`git clone --depth=1 ${shellQuote(`https://github.com/${world.repo}.git`)} ${shellQuote(clone)}`));
            expect((await successful(world.agent(`git -C ${shellQuote(clone)} rev-parse HEAD`))).trim()).toMatch(/^[a-f0-9]{40}$/u);
            upstreamAuth(world, from);
        },
    },
    {
        name: "agent pushes and removes a unique scratch branch",
        writes: true,
        requiredSecrets: ["GITHUB_E2E_REPO"],
        run: async (world) => {
            const repo = z.string().min(1).parse(world.scratch);
            const clone = join(world.home, "write-clone");
            const branch = `intentic-conformance-${randomUUID()}`;
            await successful(
                world.agent(`git clone --depth=1 ${shellQuote(`https://github.com/${repo}.git`)} ${shellQuote(clone)}
git -C ${shellQuote(clone)} -c user.name=Conformance -c user.email=conformance@example.invalid commit --allow-empty -m conformance`),
            );
            world.branches.set(branch, clone);
            try {
                await successful(world.agent(`git -C ${shellQuote(clone)} push origin ${shellQuote(`HEAD:refs/heads/${branch}`)}`));
                const head = (await successful(world.agent(`git -C ${shellQuote(clone)} rev-parse HEAD`))).trim();
                expect(
                    (await successful(world.agent(`git -C ${shellQuote(clone)} ls-remote origin ${shellQuote(`refs/heads/${branch}`)}`))).trim(),
                ).toBe(`${head}\trefs/heads/${branch}`);
            } finally {
                await world.deleteBranch(branch);
            }
            expect((await successful(world.agent(`git -C ${shellQuote(clone)} ls-remote origin ${shellQuote(`refs/heads/${branch}`)}`))).trim()).toBe(
                "",
            );
        },
    },
    {
        name: "owner terminal credentials and both SSH spellings work without broker env",
        run: async (world) => {
            const { home } = await ownerSetup(world, "owner-read");
            const credential = await successful(world.owner(home, "git credential fill", "protocol=https\nhost=github.com\n\n"));
            // Keep credentials out of assertion diagnostics, including in the live world.
            expect(credential.includes(`password=${world.token}\n`)).toBe(true);
            expect(credential.includes("username=x-access-token\n")).toBe(true);
            for (const url of [`git@github.com:${world.repo}.git`, `ssh://git@github.com/${world.repo}.git`]) {
                expect(await successful(world.owner(home, `git ls-remote ${shellQuote(url)} HEAD`))).toMatch(/^[a-f0-9]{40}\s+HEAD/mu);
            }
        },
    },
    {
        name: "owner terminal push dry-run uses stored HTTPS credentials",
        writes: true,
        requiredSecrets: ["GITHUB_E2E_REPO"],
        run: async (world) => {
            const { home } = await ownerSetup(world, "owner-write");
            const repo = z.string().min(1).parse(world.scratch);
            const clone = join(home, "clone");
            const branch = `intentic-conformance-dry-${randomUUID()}`;
            await successful(world.owner(home, `git clone --depth=1 ${shellQuote(`git@github.com:${repo}.git`)} ${shellQuote(clone)}`));
            world.branches.set(branch, clone);
            try {
                await successful(world.owner(home, `git -C ${shellQuote(clone)} push --dry-run origin ${shellQuote(`HEAD:refs/heads/${branch}`)}`));
                expect(
                    await successful(world.owner(home, `git -C ${shellQuote(clone)} ls-remote origin ${shellQuote(`refs/heads/${branch}`)}`)),
                ).toBe("");
            } finally {
                await world.deleteBranch(branch);
            }
        },
    },
    {
        name: "repository DELETE is held for ask and denial never reaches upstream",
        fakeOnly: "A broken rule could delete the real repository.",
        run: async (world) => {
            const fake = world.fake!;
            const before = fake.requests.length;
            const result = await successful(
                world.agent(`curl -s -X DELETE -H "Authorization: Bearer $GITHUB_TOKEN_GITHUB" "$GITHUB_API_URL_GITHUB/repos/${world.repo}"`),
            );
            expect(responseJson(z.object({ message: z.string(), gateway: z.literal("intentic") }), result).message).toBe(
                "conformance owner denied repository deletion",
            );
            expect(world.asks.map((ask) => ({ method: ask.method, target: ask.target, why: ask.why }))).toEqual([
                { method: "DELETE", target: `api.github.com/repos/${world.repo}`, why: "deletes a whole repository" },
            ]);
            expect(fake.requests.length).toBe(before);
        },
    },
    {
        name: "restore after HOME loss restores credentials without another key upload",
        run: async (world) => {
            const uploads = world.fake?.state.keyUploads ?? 0;
            if (world.fake !== undefined) {
                world.fake.state.allowKeyUploads = true;
            }
            const owner = await ownerSetup(world, "owner-restore").finally(() => {
                if (world.fake !== undefined) {
                    world.fake.state.allowKeyUploads = false;
                }
            });
            const before = world.fake?.state.keyAttempts;
            if (world.fake !== undefined) {
                expect(world.fake.state.keyUploads).toBe(uploads + 1);
            }
            await rm(owner.home, { recursive: true });
            await mkdir(owner.home);
            await inHome(owner.home, () => restoreGitAccess(world.gitHost, owner.exec, owner.keys, world.gitDeps));
            const credential = await successful(world.owner(owner.home, "git credential fill", "protocol=https\nhost=github.com\n\n"));
            expect(credential.includes(`password=${world.token}\n`)).toBe(true);
            expect(await successful(world.owner(owner.home, `git ls-remote ${shellQuote(`git@github.com:${world.repo}.git`)} HEAD`))).toMatch(
                /^[a-f0-9]{40}\s+HEAD/mu,
            );
            if (world.fake !== undefined) {
                expect(world.fake.state.keyAttempts).toBe(before!);
                expect(world.fake.state.keyUploads).toBe(uploads + 1);
            }
        },
    },
    {
        name: "publish creates for the user and org and surfaces a refusal",
        fakeOnly: "Repository creation changes account state outside the scratch repository.",
        run: async (world) => {
            const fake = world.fake!;
            const warn = () => {};
            const before = fake.requests.length;
            for (const owner of [undefined, fake.login, "conformance-org"]) {
                expect(await world.createRepository(world.gitHost, "workspace", owner, warn, world.transport)).toBe(
                    `https://github.com/${owner ?? fake.login}/workspace.git`,
                );
            }
            await expect(world.createRepository(world.gitHost, "refused", undefined, warn, world.transport)).rejects.toThrow(
                'github.com refused to create "refused": 403 {"message":"Resource not accessible by personal access token"',
            );
            expect(
                fake.requests
                    .slice(before)
                    .filter((request) => request.method === "POST")
                    .map((request) => request.path),
            ).toEqual(["/user/repos", "/user/repos", "/orgs/conformance-org/repos", "/user/repos"]);
        },
    },
];
