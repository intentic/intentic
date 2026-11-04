import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitAttribution, GitPerson } from "@intentic/sandbox-contract/schemas/settings";
import type { GitCommit } from "@intentic/sandbox-contract/schemas/git/git-history";
import { defaultGit } from "@intentic/base/git";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { AGENT_COMMIT_EMAIL, AGENT_COMMIT_NAME, AGENT_GIT_AUTHOR, UNATTRIBUTED } from "../../git-identity.js";
import { connectedAccountIdentity } from "../../capabilities/cli/git-access.js";
import { commitIndex } from "../changes/changes-index.js";
import { panelCommit } from "./panel-commit.js";
import {
    agentCommitEnv,
    attributionFor,
    commitIdentityState,
    memberCommitIdentities,
    memberOfCaller,
    memberOfConversation,
    withRequester,
} from "./commit-attribution.js";

const ADA: GitPerson = { name: "Ada Lovelace", email: "42+ada@users.noreply.github.com" };

// A sandbox people sign in to, whose settings name people as `policy` says, with conversation c1 owned by ada.
// SAFETY: attribution reads only `commitAttribution` from the settings, whether `auth` is there (not what it holds), and
// only `social.owner` from a registry entry, so the rest of each shape is never read.
const sandbox = async (policy: CommitAttribution, over: Partial<Services> = {}): Promise<Services> =>
    unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", { historyRoot: await mkdtemp(join(tmpdir(), "commit-attribution-")) }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ commitAttribution: policy }) as never }),
        auth: {} as Services["auth"],
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id) => (id === "c1" ? ({ social: { owner: { email: "ada@example.com", name: "Ada", since: 1 }, reactions: [] } } as never) : undefined),
        }),
        ...over,
    });

const tempRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "commit-attribution-repo-"));
    await defaultGit(dir, ["init", "-q"]);
    return dir;
};

const lastCommit = async (dir: string): Promise<string> => (await defaultGit(dir, ["log", "-1", "--format=%an <%ae> | %cn <%ce>%n%B"])).stdout.trim();

describe("whose commit a request or a conversation names", () => {
    test("a signed-in caller by their address, a program by nobody, and anyone on a sandbox nobody signs in to as its one person", async () => {
        const signed = await sandbox("person");
        expect(memberOfCaller(signed, { email: "Ada@Example.com" })).toBe("ada@example.com");
        expect(memberOfCaller(signed, undefined)).toBeUndefined();
        expect(memberOfCaller(await sandbox("person", { auth: undefined }), undefined)).toBe("");
    });

    test("a conversation by whoever answers for it, and one nobody owns by nobody", async () => {
        const services = await sandbox("person");
        expect(memberOfConversation(services, "c1")).toBe("ada@example.com");
        expect(memberOfConversation(services, "c2")).toBeUndefined();
        expect(memberOfConversation(services, undefined)).toBeUndefined();
    });
});

describe("what a commit carries for a person", () => {
    test("names nobody until the person sets an identity of their own, whatever the policy", async () => {
        const services = await sandbox("person");
        expect(await attributionFor(services, "ada@example.com")).toEqual(UNATTRIBUTED);
        expect(await attributionFor(services, undefined)).toEqual(UNATTRIBUTED);
    });

    test("under each policy: the author, a co-author line, or nobody", async () => {
        const as = async (policy: CommitAttribution) => {
            const services = await sandbox(policy);
            await memberCommitIdentities(services).set("ada@example.com", ADA);
            return attributionFor(services, "ada@example.com");
        };
        expect(await as("person")).toEqual({ signer: { ...AGENT_GIT_AUTHOR, author: ADA }, trailers: [] });
        expect(await as("trailer")).toEqual({ signer: AGENT_GIT_AUTHOR, trailers: ["Co-authored-by: Ada Lovelace <42+ada@users.noreply.github.com>"] });
        expect(await as("intentic")).toEqual(UNATTRIBUTED);
    });

    test("a forgotten identity names nobody again, and another member's stays", async () => {
        const services = await sandbox("person");
        const people = memberCommitIdentities(services);
        await people.set("ada@example.com", ADA);
        await people.set("bob@example.com", { name: "Bob", email: "bob@example.com" });
        await people.set("ada@example.com", undefined);
        expect(await people.get("ada@example.com")).toBeUndefined();
        expect(await people.get("bob@example.com")).toEqual({ name: "Bob", email: "bob@example.com" });
    });

    // The split git itself records: the person wrote it, the agent committed it.
    test("a person-authored signer makes git record the person as author and intentic as committer", async () => {
        const services = await sandbox("person");
        await memberCommitIdentities(services).set("ada@example.com", ADA);
        const dir = await tempRepo();
        await writeFile(join(dir, "a.txt"), "a\n");
        await defaultGit(dir, ["add", "a.txt"]);
        await commitIndex(dir, "feat: a", (await attributionFor(services, "ada@example.com")).signer);
        expect(await lastCommit(dir)).toBe("Ada Lovelace <42+ada@users.noreply.github.com> | intentic <agent@intentic.dev>\nfeat: a");
    });
});

describe("a panel commit", () => {
    test("is signed for whoever pressed it and trailed with each conversation whose landed work it takes", async () => {
        const services = await sandbox("trailer", {
            agentOrigins: unstubbed<Services["agentOrigins"]>("agentOrigins", { forRepo: async () => ({ "a.txt": ["c1"], "c.txt": ["c9"] }) }),
        });
        await memberCommitIdentities(services).set("bob@example.com", { name: "Bob", email: "bob@example.com" });
        const dir = await tempRepo();
        await writeFile(join(dir, "a.txt"), "a\n");
        await writeFile(join(dir, "b.txt"), "b\n");
        await writeFile(join(dir, "c.txt"), "c\n");
        // c.txt landed too, but is not in this commit: its conversation is not named.
        await defaultGit(dir, ["add", "a.txt", "b.txt"]);
        const commit = await panelCommit(services, { repo: "root", dir, message: "feat: a and b", member: "bob@example.com" });
        expect(commit).toEqual({ signer: AGENT_GIT_AUTHOR, message: "feat: a and b\n\nConversation-Id: c1\nCo-authored-by: Bob <bob@example.com>" });
        await commitIndex(dir, commit.message, commit.signer);
        expect((await defaultGit(dir, ["log", "-1", "--format=%(trailers:key=Conversation-Id,valueonly)"])).stdout.trim()).toBe("c1");
    });

    test("whose origins cannot be read still goes in, naming no conversation", async () => {
        const services = await sandbox("intentic", {
            agentOrigins: unstubbed<Services["agentOrigins"]>("agentOrigins", { forRepo: async () => { throw new Error("unreadable"); } }),
        });
        const dir = await tempRepo();
        await writeFile(join(dir, "a.txt"), "a\n");
        await defaultGit(dir, ["add", "a.txt"]);
        expect(await panelCommit(services, { repo: "root", dir, message: "feat: a", member: undefined })).toEqual({ signer: AGENT_GIT_AUTHOR, message: "feat: a" });
    });
});

describe("an agent's own commits", () => {
    test("sign as the person it works for only under `person`, and as the agent otherwise", async () => {
        const services = await sandbox("person");
        await memberCommitIdentities(services).set("ada@example.com", ADA);
        expect(await agentCommitEnv(services, "person", "c1")).toEqual({ [AGENT_COMMIT_NAME]: ADA.name, [AGENT_COMMIT_EMAIL]: ADA.email });
        const agent = { [AGENT_COMMIT_NAME]: "intentic", [AGENT_COMMIT_EMAIL]: "agent@intentic.dev" };
        expect(await agentCommitEnv(services, "trailer", "c1")).toEqual(agent);
        // A conversation nobody answers for, under `person`, still signs as the agent.
        expect(await agentCommitEnv(services, "person", "c2")).toEqual(agent);
    });
});

describe("the caller's own commit identity", () => {
    test("offers the owner the connected account's, and asks nothing for another member", async () => {
        let asked = 0;
        const suggest = async (): Promise<GitPerson> => {
            asked += 1;
            return ADA;
        };
        const services = await sandbox("trailer", { ownerEmail: async () => "Ada@example.com" });
        expect(await commitIdentityState(services, "ada@example.com", suggest)).toEqual({ suggested: ADA, attribution: "trailer" });
        expect(await commitIdentityState(services, "bob@example.com", suggest)).toEqual({ attribution: "trailer" });
        expect(asked).toBe(1);
        // A suggestion is only ever offered: once Bob sets his own, that is what comes back.
        await memberCommitIdentities(services).set("bob@example.com", { name: "Bob", email: "bob@example.com" });
        expect(await commitIdentityState(services, "bob@example.com", suggest)).toEqual({ identity: { name: "Bob", email: "bob@example.com" }, attribution: "trailer" });
    });

    test("the suggestion is the first git-access connection whose account answers", async () => {
        const github = { id: "github", kind: "cli", config: { provider: "github", token: "ghp_x", git: "on" } } as const;
        const offline = { id: "gitlab", kind: "cli", config: { provider: "gitlab", token: "gl", url: "https://gitlab.example", git: "on" } } as const;
        const noGit = { id: "github-2", kind: "cli", config: { provider: "github", token: "ghp_y", git: "off" } } as const;
        const asked: string[] = [];
        // SAFETY: the lookup reads only `kind` and the cli config's provider, token, url and git switch.
        const identity = await connectedAccountIdentity([noGit, offline, github] as never, {
            accountIdentity: async (host) => {
                asked.push(host.host);
                return host.provider === "github" ? ADA : undefined;
            },
        });
        expect(identity).toEqual(ADA);
        expect(asked).toEqual(["gitlab.example", "github.com"]);
    });
});

describe("history rows", () => {
    const row = (body: string): GitCommit => ({ sha: "a", short: "a", parents: [], subject: "feat: a", body, author: "intentic", email: "agent@intentic.dev", at: 0, refs: [], head: false });

    test("name who the work was for from the commit's Conversation-Id", async () => {
        const services = await sandbox("intentic");
        expect(withRequester(services, row("Test-Note: x\nConversation-Id: c1")).requestedBy).toEqual({ conversation: "c1", name: "Ada", email: "ada@example.com" });
        // A conversation the registry no longer knows still says which one it was.
        expect(withRequester(services, row("Conversation-Id: gone")).requestedBy).toEqual({ conversation: "gone" });
        expect(withRequester(services, row("no trailer here")).requestedBy).toBeUndefined();
    });
});
