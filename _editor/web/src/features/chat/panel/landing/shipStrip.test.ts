import type { GitChange, RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import type { LandedMessageDraft } from "@intentic/sandbox-contract/schemas/agents";
import { NO_ATTENTION } from "@intentic/sandbox-contract/models/agent-lanes";
import { commitDraftOf, type ShipAgent, type ShipFacts, shipsFrom, type ShipReader, shipStripOf, sessionCommitsSettled } from "./shipStrip";

const ID = `brave-otter`;
const OTHER = `quiet-heron`;

const change = (path: string): GitChange => ({ path, status: `modified` });

const repo = (over: Partial<RepoChanges> = {}): RepoChanges => ({
    repo: `root`,
    conflicted: [],
    staged: [],
    unstaged: [change(`src/a.ts`), change(`src/b.ts`)],
    origins: { "src/a.ts": [ID], "src/b.ts": [ID] },
    remote: { remote: `origin`, upstream: `origin/main`, ahead: 0, behind: 0 },
    ...over,
});

const facts = (over: Partial<ShipFacts> = {}): ShipFacts => ({
    id: ID,
    repos: [repo()],
    committing: [],
    message: `Add the ship strip\n\nRelease-Note: chats commit and push`,
    draft: undefined,
    commits: undefined,
    push: { running: [], pushed: [], refused: [] },
    ...over,
});

describe(`shipStripOf, committing`, () => {
    it(`offers the commit of the session's files under the drafted message`, () => {
        expect(shipStripOf(facts())).toEqual({
            kind: `commit`,
            repos: [`root`],
            files: 2,
            draft: { state: `written`, text: `Add the ship strip\n\nRelease-Note: chats commit and push`, subject: `Add the ship strip` },
        });
    });

    it(`counts a file staged and edited again once, and only the repositories holding the session's work`, () => {
        const both = repo({ staged: [change(`src/a.ts`)], unstaged: [change(`src/a.ts`)], origins: { "src/a.ts": [ID] } });
        const elsewhere = repo({ repo: `docs`, unstaged: [change(`README.md`)], origins: {} });
        expect(shipStripOf(facts({ repos: [both, elsewhere] }))).toMatchObject({ kind: `commit`, repos: [`root`], files: 1 });
    });

    it(`leaves the owner's own edits beside it alone: they are not its files and nothing commits them`, () => {
        const mixed = repo({ unstaged: [change(`src/a.ts`), change(`notes.md`)], origins: { "src/a.ts": [ID] } });
        expect(shipStripOf(facts({ repos: [mixed] }))).toMatchObject({ kind: `commit`, files: 1 });
    });

    it(`sends the commit to the Changes panel when another session landed one of the same files`, () => {
        const shared = repo({ origins: { "src/a.ts": [OTHER, ID], "src/b.ts": [ID] } });
        expect(shipStripOf(facts({ repos: [shared] }))).toEqual({ kind: `blocked`, files: 2, block: `shared` });
    });

    it(`sends it there when other work is already staged, which a commit would record with it`, () => {
        const staged = repo({ staged: [change(`notes.md`)] });
        expect(shipStripOf(facts({ repos: [staged] }))).toMatchObject({ kind: `blocked`, block: `staged` });
        const unlisted = repo({ truncated: { staged: 3, unstaged: 0 } });
        expect(shipStripOf(facts({ repos: [unlisted] }))).toMatchObject({ kind: `blocked`, block: `staged` });
    });

    it(`takes the session's own staged files as its own, as a lit chip leaves them`, () => {
        const lit = repo({ staged: [change(`src/a.ts`)], unstaged: [change(`src/b.ts`)] });
        expect(shipStripOf(facts({ repos: [lit] }))).toMatchObject({ kind: `commit`, files: 2 });
    });

    it(`sends it there over a conflict in a repository it would commit in`, () => {
        const conflicted = repo({ conflicted: [change(`src/c.ts`)] });
        expect(shipStripOf(facts({ repos: [conflicted] }))).toMatchObject({ kind: `blocked`, block: `conflicts` });
    });

    it(`says a commit is running in one of its repositories rather than offering a second`, () => {
        expect(shipStripOf(facts({ committing: [`root`] }))).toEqual({ kind: `committing`, files: 2 });
    });

    it(`reads nothing from a repository git could not read`, () => {
        expect(shipStripOf(facts({ repos: [repo({ error: `not a git repository` })] }))).toBeUndefined();
    });
});

describe(`commitDraftOf`, () => {
    const draft = (over: Partial<LandedMessageDraft>): LandedMessageDraft => ({ startedAt: 0, steps: [], ...over });

    it(`waits while the message is being written, naming the model asked`, () => {
        const asking = draft({ steps: [{ provider: `claude`, model: `claude-haiku-4-5`, status: `asking`, at: 1 }] });
        expect(commitDraftOf(undefined, asking)).toMatchObject({ state: `drafting` });
        expect(commitDraftOf(undefined, draft({}))).toEqual({ state: `drafting`, model: undefined });
    });

    it(`keeps waiting for a written message the card has not carried yet`, () => {
        expect(commitDraftOf(undefined, draft({ outcome: `written` }))).toEqual({ state: `drafting`, model: undefined });
    });

    it(`hands the message to the reader when none was written, with the reason when there is one`, () => {
        expect(commitDraftOf(undefined, draft({ outcome: `failed`, reason: `every model refused` }))).toEqual({ state: `missing`, reason: `every model refused` });
        expect(commitDraftOf(undefined, undefined)).toEqual({ state: `missing`, reason: undefined });
        expect(commitDraftOf(`   `, undefined)).toEqual({ state: `missing`, reason: undefined });
    });
});

describe(`shipStripOf, pushing`, () => {
    const committed = (over: Partial<RepoChanges> = {}): RepoChanges =>
        repo({ unstaged: [], origins: {}, remote: { remote: `origin`, upstream: `origin/main`, ahead: 1, behind: 0 }, ...over });

    it(`offers the push of what it committed`, () => {
        expect(shipStripOf(facts({ repos: [committed()], commits: { root: 1 } }))).toEqual({
            kind: `push`,
            verb: `push`,
            targets: [{ repo: `root`, pull: false, push: true }],
            commits: 1,
            others: 0,
            refused: false,
        });
    });

    it(`counts the commits the branch carries that this chat did not make`, () => {
        const ahead = committed({ remote: { remote: `origin`, upstream: `origin/main`, ahead: 3, behind: 0 } });
        expect(shipStripOf(facts({ repos: [ahead], commits: { root: 1 } }))).toMatchObject({ commits: 3, others: 2 });
    });

    it(`syncs a branch that is behind, and publishes one that was never pushed`, () => {
        const behind = committed({ remote: { remote: `origin`, upstream: `origin/main`, ahead: 1, behind: 2 } });
        expect(shipStripOf(facts({ repos: [behind], commits: { root: 1 } }))).toMatchObject({
            verb: `sync`,
            targets: [{ repo: `root`, pull: true, push: true }],
        });
        const fresh = committed({ remote: { remote: `origin`, ahead: 0, behind: 0 } });
        expect(shipStripOf(facts({ repos: [fresh], commits: { root: 1 } }))).toMatchObject({ verb: `publish`, commits: 0 });
    });

    it(`pushes only the repositories it committed in`, () => {
        const docs = committed({ repo: `docs` });
        expect(shipStripOf(facts({ repos: [committed(), docs], commits: { root: 1 } }))).toMatchObject({ targets: [{ repo: `root` }] });
    });

    it(`says the push under way, then that it went, ahead of the rescan that still counts the commits`, () => {
        const base = { repos: [committed()], commits: { root: 1 } };
        expect(shipStripOf(facts({ ...base, push: { running: [`root`], pushed: [], refused: [] } }))).toEqual({ kind: `pushing` });
        expect(shipStripOf(facts({ ...base, push: { running: [], pushed: [`root`], refused: [] } }))).toEqual({ kind: `pushed` });
    });

    it(`marks a push of its repositories that was refused`, () => {
        const refused = { running: [], pushed: [], refused: [`root`] };
        expect(shipStripOf(facts({ repos: [committed()], commits: { root: 1 }, push: refused }))).toMatchObject({ kind: `push`, refused: true });
    });

    it(`says nothing once there is nothing to send, or nowhere to send it`, () => {
        const level = committed({ remote: { remote: `origin`, upstream: `origin/main`, ahead: 0, behind: 0 } });
        expect(shipStripOf(facts({ repos: [level], commits: { root: 1 } }))).toBeUndefined();
        expect(shipStripOf(facts({ repos: [committed({ remote: undefined })], commits: { root: 1 } }))).toBeUndefined();
        expect(shipStripOf(facts({ repos: [committed()] }))).toBeUndefined();
    });

    it(`offers the commit first when more of its work landed since`, () => {
        const again = committed({ unstaged: [change(`src/a.ts`)], origins: { "src/a.ts": [ID] } });
        expect(shipStripOf(facts({ repos: [again], commits: { root: 1 } }))).toMatchObject({ kind: `commit` });
    });
});

describe(`sessionCommitsSettled`, () => {
    const level = repo({ unstaged: [], remote: { remote: `origin`, upstream: `origin/main`, ahead: 0, behind: 0 } });

    it(`is settled once every repository it committed in owes its remote nothing, or has none`, () => {
        expect(sessionCommitsSettled({ root: 1 }, [level])).toBe(true);
        expect(sessionCommitsSettled({ root: 1 }, [repo({ remote: undefined })])).toBe(true);
    });

    it(`is not while a commit is still unpushed, or a repository it committed in is unread`, () => {
        expect(sessionCommitsSettled({ root: 1 }, [repo({ remote: { remote: `origin`, upstream: `origin/main`, ahead: 1, behind: 0 } })])).toBe(false);
        expect(sessionCommitsSettled({ root: 1, docs: 1 }, [level])).toBe(false);
        expect(sessionCommitsSettled({ root: 1 }, [repo({ error: `locked` })])).toBe(false);
    });
});

describe(`shipsFrom`, () => {
    const reader = (over: Partial<ShipReader> = {}): ShipReader => ({ canShip: true, maker: false, streaming: false, elsewhere: false, ...over });
    const agent = (over: Partial<ShipAgent> = {}): ShipAgent => ({ id: ID, status: `landed`, attention: NO_ATTENTION, ...over });

    it(`speaks for a settled chat to a maintainer in a developer's words`, () => {
        expect(shipsFrom(agent(), reader())).toBe(true);
        expect(shipsFrom(agent({ status: `idle` }), reader())).toBe(true);
    });

    it.each([`running`, `starting`, `stopping`, `resuming`, `landing`, `draft`] as const)(`says nothing while the chat is %s`, (status) => {
        expect(shipsFrom(agent({ status }), reader())).toBe(false);
    });

    it(`says nothing to a collaborator, in plain words, mid-stream, or for another box's chat`, () => {
        expect(shipsFrom(agent(), reader({ canShip: false }))).toBe(false);
        expect(shipsFrom(agent(), reader({ maker: true }))).toBe(false);
        expect(shipsFrom(agent(), reader({ streaming: true }))).toBe(false);
        expect(shipsFrom(agent(), reader({ elsewhere: true }))).toBe(false);
    });

    it(`says nothing for an archived chat, a home conversation, or a chat with no card`, () => {
        expect(shipsFrom(agent({ archivedAt: 1 }), reader())).toBe(false);
        expect(shipsFrom(agent({ id: `home-workspace` }), reader())).toBe(false);
        expect(shipsFrom(undefined, reader())).toBe(false);
    });
});
