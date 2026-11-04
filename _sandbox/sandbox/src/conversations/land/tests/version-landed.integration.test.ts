import { WORKSPACE_ROOT } from "@intentic/constants";
import type { HomeCommit, LandedMessage,SessionOwner } from "@intentic/sandbox-contract/schemas/agents";
import type { Rule,CommitAttribution } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { committableSubject, subjectFromPaths } from "../../../git/ops/commit-message.js";
import { settleLanding, settleLandingInBackground, versionCommitsSettled, versionRuleOf } from "../version-landed.js";
import { isolatedAgent } from "../../registry/agents-store.testing.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_GIT_AUTHOR, type CommitSigner } from "../../../git-identity.js";
import { memberCommitIdentities } from "../../../git/attribution/commit-attribution.js";
import { opt } from "../../../opt.js";
import * as changesOriginal from "../../../git/changes/changes.js";

const describeLanding = jest.fn<() => Promise<void>>();
jest.mock("../landed-subject.js", () => ({ describeLanding: () => describeLanding() }));
const commitOnly = jest.fn<(dir: string, paths: readonly string[], subject: string) => Promise<boolean>>(async () => true);
// Who signed each commit, kept apart so the assertions on what a commit says stay about its words.
const signers: CommitSigner[] = [];
jest.mock("../../../git/changes/changes-index.js", () => ({
    commitOnly: (dir: string, paths: readonly string[], subject: string, signer: CommitSigner) => {
        signers.push(signer);
        return commitOnly(dir, paths, subject);
    },
}));
jest.mock("../../../git/remote/root-repo.js", () => ({ commitWorktreeRemainder: async () => false }));
// The commit a home files is read off HEAD right after it is made; only that read is stood in for.
const HEAD = "f".repeat(40);
jest.mock("../../../git/changes/changes.js", () => ({ ...changesOriginal, headSha: async () => HEAD }));

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "moment" | "action">): Rule => ({ label: over.id, enabled: true, ...over });

const version = (id: string, over: Partial<Rule> = {}): Rule =>
    rule({ id, moment: "agent.landed", action: { kind: "builtin", name: "version-landed" }, ...over });

// The landing's drafted message: the subject, with each note only when the test set one.
const landedMessage = (subject: string, landed: { testNote?: string; breaking?: string }): LandedMessage => {
    const message: LandedMessage = { subject };
    if (landed.testNote !== undefined) {
        message.testNote = landed.testNote;
    }
    if (landed.breaking !== undefined) {
        message.breaking = landed.breaking;
    }
    return message;
};

const servicesWith = (
    rules: readonly Rule[],
    landedSubject?: string,
    landed: {
        testNote?: string;
        breaking?: string;
        said?: string;
        title?: string;
        origins?: Record<string, string[]>;
        home?: boolean;
        filed?: HomeCommit[];
        attribution?: CommitAttribution;
        owner?: SessionOwner;
        historyRoot?: string;
    } = {},
): Services =>
    unstubbed<Services>("services", {
        // A sandbox people sign in to, whose per-person commit identities live in a history root of the test's own.
        config: unstubbed<Services["config"]>("config", { historyRoot: landed.historyRoot ?? mkdtempSync(join(tmpdir(), "version-landed-")) }),
        // SAFETY: attribution asks only whether `auth` is there, never what it holds.
        auth: {} as Services["auth"],
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            // SAFETY: a land reads only `rules` and `commitAttribution` from the settings.
            get: async () => ({ rules, commitAttribution: landed.attribution ?? "trailer" }) as never,
        }),
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () =>
                isolatedAgent([{ repo: "root", base: "a".repeat(40) }], {
                    identity: landed.home === true ? { home: true } : {},
                    social: {
                        title: { text: landed.title ?? "Recent commits", source: "derived" },
                        reactions: [],
                        ...opt("owner", landed.owner),
                    },
                    landing: landedSubject === undefined ? {} : { message: landedMessage(landedSubject, landed) },
                }),
            recordHomeCommit: async (_id, commit) => void landed.filed?.push(commit),
        }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            lastSaid: async () => landed.said,
        }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
            mainDir: () => WORKSPACE_ROOT,
            withRepoLock: async (_repo, run) => run(),
        }),
        agentOrigins: unstubbed<Services["agentOrigins"]>("agentOrigins", { forRepo: async () => landed.origins ?? { "a.ts": ["c1"] } }),
        ruleFirings: unstubbed<Services["ruleFirings"]>("ruleFirings", { stamp: async () => undefined }),
        logger: unstubbed<Services["logger"]>("logger", { debug: () => undefined, info: () => undefined, warn: () => undefined }),
    });

beforeEach(() => {
    describeLanding.mockReset();
    describeLanding.mockResolvedValue(undefined);
    commitOnly.mockClear();
    signers.length = 0;
});

describe(`the version rule`, () => {
    test(`stands only as the versioner built-in at the landed moment`, () => {
        expect(versionRuleOf([version(`auto-version`)])?.id).toBe(`auto-version`);
        // The same built-in name at another moment is not this rule; the schema refuses it at save, and this is the
        // reader's own half of that refusal.
        expect(versionRuleOf([rule({ id: `x`, moment: `turn.ending`, action: { kind: `builtin`, name: `version-landed` } })])).toBeUndefined();
        expect(versionRuleOf([rule({ id: `land`, moment: `agent.finished`, action: { kind: `verdict`, verdict: `allow` } })])).toBeUndefined();
    });

    test(`a switched-off rule leaves every commit to the owner`, () => {
        expect(versionRuleOf([version(`auto-version`, { enabled: false })])).toBeUndefined();
        expect(versionRuleOf([])).toBeUndefined();
    });
});

describe(`settling a landing`, () => {
    test(`commits the claim under the subject drafted for it`, async () => {
        await settleLanding(servicesWith([version(`auto-version`)], `fix: cascading markers`), `c1`);
        expect(commitOnly).toHaveBeenCalledWith(WORKSPACE_ROOT, [`a.ts`], `fix: cascading markers\n\nConversation-Id: c1`);
    });

    // The person who answers for the conversation, by the commit identity they set, as the owner's policy names people.
    test(`names the conversation's owner as its author, in a co-author line, or not at all`, async () => {
        const ada = { name: `Ada Lovelace`, email: `42+ada@users.noreply.github.com` };
        const owner = { email: `ada@example.com`, name: `Ada`, since: 1 };
        const settled = async (attribution: CommitAttribution) => {
            const historyRoot = mkdtempSync(join(tmpdir(), `version-landed-`));
            const services = servicesWith([version(`auto-version`)], `fix: cascading markers`, { attribution, owner, historyRoot });
            await memberCommitIdentities(services).set(`ada@example.com`, ada);
            commitOnly.mockClear();
            signers.length = 0;
            await settleLanding(services, `c1`);
            return { message: commitOnly.mock.calls[0]?.[2], signer: signers[0] };
        };
        expect(await settled(`person`)).toEqual({ message: `fix: cascading markers\n\nConversation-Id: c1`, signer: { ...AGENT_GIT_AUTHOR, author: ada } });
        expect(await settled(`trailer`)).toEqual({
            message: `fix: cascading markers\n\nConversation-Id: c1\nCo-authored-by: Ada Lovelace <42+ada@users.noreply.github.com>`,
            signer: AGENT_GIT_AUTHOR,
        });
        expect(await settled(`intentic`)).toEqual({ message: `fix: cascading markers\n\nConversation-Id: c1`, signer: AGENT_GIT_AUTHOR });
    });

    test(`names nobody for an owner who set no commit identity`, async () => {
        await settleLanding(servicesWith([version(`auto-version`)], `fix: cascading markers`, { attribution: `person`, owner: { email: `ada@example.com`, since: 1 } }), `c1`);
        expect(signers).toEqual([AGENT_GIT_AUTHOR]);
    });

    test(`includes generated paths that became attributable while the commit waited for its lock`, async () => {
        let locked = false;
        const fleet: Services = {
            ...servicesWith([version(`auto-version`)], `fix: cascading markers`),
            agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
                mainDir: () => WORKSPACE_ROOT,
                withRepoLock: async (_repo, run) => {
                    locked = true;
                    return run();
                },
            }),
            agentOrigins: unstubbed<Services["agentOrigins"]>("agentOrigins", {
                forRepo: async () => locked
                    ? { "a.ts": ["c1"], "state-shapes.json": ["c1"], "unrelated.ts": ["c2"] }
                    : { "a.ts": ["c1"] },
            }),
        };
        await settleLanding(fleet, `c1`);
        expect(commitOnly).toHaveBeenCalledWith(WORKSPACE_ROOT, [`a.ts`, `state-shapes.json`], `fix: cascading markers\n\nConversation-Id: c1`);
    });

    // A home's person only chats with it: nobody is there to commit what it lands, so it commits without the rule.
    test(`a home's land is committed without the rule; anyone else's waits for the owner`, async () => {
        await settleLanding(servicesWith([], `fix: keep the return path`), `c1`);
        expect(commitOnly).not.toHaveBeenCalled();
        await settleLanding(servicesWith([], `fix: keep the return path`, { home: true }), `c1`);
        expect(commitOnly).toHaveBeenCalledWith(WORKSPACE_ROOT, [`a.ts`], `fix: keep the return path\n\nConversation-Id: c1`);
    });

    // The chat says what its home's land became in history, on the row that said it landed (AgentSummary.commits).
    test(`a home files the commit its land made under the land's own id; nothing is filed for anyone else`, async () => {
        const filed: HomeCommit[] = [];
        await settleLanding(servicesWith([], `fix: keep the return path`, { home: true, filed }), `c1`, undefined, undefined, `land-1`);
        expect(filed).toEqual([{ land: `land-1`, at: expect.any(Number), subject: `fix: keep the return path`, commits: [{ repo: `root`, sha: HEAD }] }]);
        await settleLanding(servicesWith([version(`auto-version`)], `fix: keep the return path`, { filed }), `c1`, undefined, undefined, `land-2`);
        expect(filed).toHaveLength(1);
        // A commit that took nothing files nothing.
        commitOnly.mockResolvedValueOnce(false);
        await settleLanding(servicesWith([], `fix: keep the return path`, { home: true, filed }), `c1`, undefined, undefined, `land-3`);
        expect(filed).toHaveLength(1);
    });

    // The report already tells the owner the draft failed; the landing must still reach history.
    test(`a failed draft still commits, under the conversation's title`, async () => {
        describeLanding.mockRejectedValue(new Error(`every model set for this job names an account this sandbox no longer has`));
        await settleLanding(servicesWith([version(`auto-version`)]), `c1`);
        expect(commitOnly).toHaveBeenCalledWith(WORKSPACE_ROOT, [`a.ts`], `Agent: Recent commits\n\nConversation-Id: c1`);
    });

    // CI's push check reads a weakened test's declaration off the commit; a land must not drop the conversation's.
    test(`a drafted landing commits with its Test-Note trailer, and an undrafted one keeps the conversation's`, async () => {
        await settleLanding(servicesWith([version(`auto-version`)], `refactor: rows`, { testNote: `rows became a table` }), `c1`);
        expect(commitOnly).toHaveBeenLastCalledWith(WORKSPACE_ROOT, [`a.ts`], `refactor: rows\n\nTest-Note: rows became a table\nConversation-Id: c1`);
        describeLanding.mockRejectedValue(new Error(`no model`));
        await settleLanding(servicesWith([version(`auto-version`)], undefined, { said: `Done.\nTest-Note: prose became structure` }), `c1`);
        expect(commitOnly).toHaveBeenLastCalledWith(WORKSPACE_ROOT, [`a.ts`], `Agent: Recent commits\n\nTest-Note: prose became structure\nConversation-Id: c1`);
    });

    // The subject 50eb6b7d6 landed under, 701 files: whatever path put it on the landing, it is not written.
    const NARRATED = `Checking key diff hunks to confirm the main architectural changes.`;
    const claim = { "_sandbox/sandbox/src/a.ts": [`c1`], "_sandbox/sandbox/src/b.ts": [`c1`], "_sandbox/sandbox/README.md": [`c1`] };

    test(`a narrated subject is never committed: the claim goes in under one built from the change, trailers kept`, async () => {
        await settleLanding(servicesWith([version(`auto-version`)], NARRATED, { testNote: `rows became a table`, origins: claim }), `c1`);
        expect(commitOnly).toHaveBeenCalledWith(
            WORKSPACE_ROOT,
            Object.keys(claim),
            `chore(sandbox): update 3 files\n\nTest-Note: rows became a table\nConversation-Id: c1`,
        );
    });

    // Release tooling majors on the `!`: a replaced subject must not drop the marker its Breaking-Note asks for.
    test(`a narrated subject replaced on a breaking land keeps the breaking marker`, async () => {
        await settleLanding(servicesWith([version(`auto-version`)], NARRATED, { breaking: `The wire drops rows.`, origins: claim }), `c1`);
        expect(commitOnly).toHaveBeenCalledWith(
            WORKSPACE_ROOT,
            Object.keys(claim),
            `chore(sandbox)!: update 3 files\n\nBreaking-Note: The wire drops rows.\nConversation-Id: c1`,
        );
    });

    test(`an undrafted land whose title narrates is committed under a subject built from the change, not the title`, async () => {
        describeLanding.mockRejectedValue(new Error(`no model`));
        await settleLanding(servicesWith([version(`auto-version`)], undefined, { title: NARRATED, origins: claim }), `c1`);
        expect(commitOnly).toHaveBeenCalledWith(WORKSPACE_ROOT, Object.keys(claim), `chore(sandbox): update 3 files\n\nConversation-Id: c1`);
    });

    test(`without the rule the subject is still drafted for the chip, and nothing is committed`, async () => {
        await settleLanding(servicesWith([], `fix: cascading markers`), `c1`);
        expect(describeLanding).toHaveBeenCalledTimes(1);
        expect(commitOnly).not.toHaveBeenCalled();
    });
});

// Until its version commit, a land's paths are uncommitted edits in the main tree: a second land judged then read them
// as the owner's and was refused on them, the card asking the owner to commit what the version commit took a moment later.
describe(`a land into a repo whose last land is still being versioned`, () => {
    // The subject's draft held open, the way a model takes its time over it.
    const drafting = (): (() => void) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        describeLanding.mockReturnValue(promise);
        return resolve;
    };
    const order: string[] = [];
    beforeEach(() => {
        order.length = 0;
        commitOnly.mockImplementation(async () => {
            order.push(`committed`);
            return true;
        });
    });

    test(`waits for that commit before it rebases and is judged, but not for the draft of its subject`, async () => {
        const services = servicesWith([version(`auto-version`)], `fix: cascading markers`);
        const finish = drafting();
        settleLandingInBackground(services, `c1`);
        // (2026-10-20) The waiter hurries the commit: made at once under the title, with the draft still running.
        await versionCommitsSettled(services, [`root`]).then(() => order.push(`judged`));
        expect(order).toEqual([`committed`, `judged`]);
        // The record's message is not this land's until its draft ends, so the title heads the commit.
        expect(commitOnly.mock.calls[0]?.[2]).toStartWith(`Agent: Recent commits`);
        finish();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(commitOnly).toHaveBeenCalledTimes(1);
    });

    test(`with nothing waiting, the commit waits for its draft and is written under it`, async () => {
        const services = servicesWith([version(`auto-version`)], `fix: cascading markers`);
        const finish = drafting();
        settleLandingInBackground(services, `c1`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(order).toEqual([]);
        finish();
        await versionCommitsSettled(services, [`root`]);
        expect(commitOnly.mock.calls[0]?.[2]).toStartWith(`fix: cascading markers`);
    });

    test(`does not wait on a draft when no commit is coming`, async () => {
        const services = servicesWith([], `fix: cascading markers`);
        const finish = drafting();
        settleLandingInBackground(services, `c1`);
        await versionCommitsSettled(services, [`root`]);
        expect(describeLanding).toHaveBeenCalledTimes(1);
        finish();
        expect(commitOnly).not.toHaveBeenCalled();
    });

    test(`judges the tree as it stands once the commit itself outlasts the wait`, async () => {
        const services = servicesWith([version(`auto-version`)], `fix: cascading markers`);
        const { promise: gitDone, resolve: unstall } = Promise.withResolvers<boolean>();
        commitOnly.mockImplementation(async () => gitDone);
        settleLandingInBackground(services, `c1`);
        await versionCommitsSettled(services, [`root`], 5);
        expect(commitOnly).toHaveBeenCalledTimes(1);
        unstall(true);
        await versionCommitsSettled(services, [`root`]);
    });
});

describe(`the subject a land commit is written under`, () => {
    test(`keeps a subject that can head a commit`, () => {
        expect(committableSubject(`fix(sandbox): stop a server nobody kept`, [`_sandbox/sandbox/src/a.ts`])).toBe(
            `fix(sandbox): stop a server nobody kept`,
        );
    });

    test(`replaces a narrated or empty one with where the change is`, () => {
        expect(
            committableSubject(`Checking key diff hunks to confirm the main architectural changes.`, [`_editor/web/src/a.vue`, `_editor/web/b.ts`]),
        ).toBe(`chore(editor): update 2 files`);
        expect(committableSubject(``, [`package.json`])).toBe(`chore: update package.json`);
    });

    test(`names no scope when the change spans areas, or sits at the root`, () => {
        expect(subjectFromPaths([`_sandbox/sandbox/a.ts`, `_editor/web/b.ts`, `turbo.json`])).toBe(`chore: update 3 files`);
        expect(subjectFromPaths([`docs/architecture/sandbox.md`])).toBe(`chore(docs): update sandbox.md`);
    });
});
