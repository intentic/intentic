import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { CALL, fakeHarness, said, watch, world, type World } from "./world.js";

// Whole turns through the contract's own procedures, against a harness that is a real process speaking the protocol.

describe(`a turn on this computer`, () => {
    let at: World;
    beforeEach(async () => {
        at = await world();
    });
    afterEach(() => at.dispose());

    const say = (conversationId: string, prompt: string, extra: Record<string, unknown> = {}) =>
        at.agents.proceduresFor(at.folder).agent.run?.({ conversationId, prompt, ...extra }, CALL);
    const card = (id: string) => at.agents.proceduresFor(at.folder).agents.get?.({ id }, CALL);

    it(`opens a conversation on its first message, streams the turn and keeps its rows`, async () => {
        const started = await say(`otter-k7mq`, `Hello there`);
        expect(started).toEqual({ delivered: `started`, run: expect.any(String) });
        // The window that sent it asks for the conversation in the same moment: it is there already, its turn live.
        expect(await at.agents.proceduresFor(at.folder).agents.transcript?.({ id: `otter-k7mq` }, CALL)).toMatchObject({ messages: [], live: started?.run });
        const watched = await watch(at.agents, at.folder, `otter-k7mq`);
        expect(watched.ended).toBe(true);
        expect(watched.rows[0]).toMatchObject({ role: `user`, text: `Hello there` });
        expect(said(watched.rows)).toBe(`Hi there`);
        expect(watched.facts.map((fact) => fact.kind)).toEqual(expect.arrayContaining([`session`, `init`, `usage`]));

        expect(await card(`otter-k7mq`)).toMatchObject({ id: `otter-k7mq`, title: `Hello there`, status: `idle`, provider: `claude`, turns: 1, inputTokens: 12 });
        const page = await at.agents.proceduresFor(at.folder).agents.transcript?.({ id: `otter-k7mq` }, CALL);
        expect(page?.messages.map((row) => row.role)).toEqual([`user`, `assistant`]);
        // Every row says which run made it and has an id of its own, live and on the record alike: how a window that
        // already holds the run's rows redraws them in place instead of below.
        expect(watched.rows.map((row) => row.run)).toEqual([watched.run, watched.run]);
        expect(page?.messages.map((row) => [row.run, row.rowId])).toEqual(watched.rows.map((row) => [watched.run, row.rowId]));
        expect(new Set(page?.messages.map((row) => row.rowId)).size).toBe(2);
        expect(page).toMatchObject({ from: 0, more: false, through: 2, provider: `claude` });
        await waitFor(async () => expect(await readdir(join(at.home, `conversations`))).toContain(`otter-k7mq.json`));
    });

    it(`starts nothing until the reader has turned agents on`, async () => {
        at.accept(false);
        expect(await Promise.resolve(say(`otter-k7mq`, `Hello`)).catch((error: Error) => error.message)).toContain(`Agents on this computer are off`);
        expect(await at.agents.proceduresFor(at.folder).agents.list?.(undefined, CALL)).toMatchObject({ agents: [] });
    });

    it(`runs the harness in the folder, in its asking mode, on the model picked`, async () => {
        await say(`otter-k7mq`, `which`, { model: `large` });
        const asked = await watch(at.agents, at.folder, `otter-k7mq`);
        // The fake starts every session in its bypass mode: a turn here is taken off it before anything is prompted.
        expect(said(asked.rows)).toBe(`mode:default model:large cwd:${at.folder.root}`);

        await say(`otter-k7mq`, `which`, { permissionMode: `plan` });
        expect(said((await watch(at.agents, at.folder, `otter-k7mq`)).rows)).toContain(`mode:plan`);
        // The most a turn here is given: file edits without a card each, never the harness's run-without-asking mode.
        await say(`otter-k7mq`, `which`, { permissionMode: `bypassPermissions` });
        expect(said((await watch(at.agents, at.folder, `otter-k7mq`)).rows)).toContain(`mode:acceptEdits`);
    });

    it(`carries the conversation on in the harness's own session`, async () => {
        await say(`otter-k7mq`, `Hello`);
        const first = await watch(at.agents, at.folder, `otter-k7mq`);
        await say(`otter-k7mq`, `Again`);
        const second = await watch(at.agents, at.folder, `otter-k7mq`);
        const sessionOf = (facts: typeof first.facts) => facts.flatMap((fact) => (fact.kind === `session` ? [fact.sessionId] : []))[0];
        expect(sessionOf(second.facts)).toBe(sessionOf(first.facts));
        expect((await card(`otter-k7mq`))?.turns).toBe(2);
    });

    it(`keeps a conversation across the app quitting, and picks its session up again`, async () => {
        await say(`otter-k7mq`, `Hello`);
        const first = await watch(at.agents, at.folder, `otter-k7mq`);
        const session = first.facts.flatMap((fact) => (fact.kind === `session` ? [fact.sessionId] : []))[0];

        // Quit at once, with the settled turn's write perhaps still on its way: the process writes it as it goes.
        at.restarted();
        // Read back off disk by a process that never ran it: the card, the rows, and nothing running.
        expect(await card(`otter-k7mq`)).toMatchObject({ status: `idle`, turns: 1, sessionId: session });
        const kept = await at.agents.proceduresFor(at.folder).agents.transcript?.({ id: `otter-k7mq` }, CALL);
        expect(kept?.messages.map((row) => row.text)).toEqual([`Hello`, `Hi there`]);
        expect(kept?.live).toBeUndefined();
        // The next turn resumes the harness's own session in a fresh harness process rather than opening another.
        await say(`otter-k7mq`, `Again`);
        const second = await watch(at.agents, at.folder, `otter-k7mq`);
        expect(second.facts).toContainEqual({ kind: `session`, sessionId: session ?? `` });
        expect((await card(`otter-k7mq`))?.turns).toBe(2);
    });

    it(`keeps what a turn had drawn when the app quits under it`, async () => {
        await say(`otter-k7mq`, `wait`);
        await watch(at.agents, at.folder, `otter-k7mq`, (watched) => said(watched.rows) === `waiting`);
        at.restarted();
        expect(await card(`otter-k7mq`)).toMatchObject({ status: `interrupted`, turns: 1 });
        const kept = await at.agents.proceduresFor(at.folder).agents.transcript?.({ id: `otter-k7mq` }, CALL);
        expect(kept?.messages.filter((row) => row.role !== `notice`).map((row) => row.text)).toEqual([`wait`, `waiting`]);
    });

    it(`puts a call the agent asks about to the reader, and answers the agent with their choice`, async () => {
        await say(`otter-k7mq`, `ask`);
        const parked = await watch(at.agents, at.folder, `otter-k7mq`, (watched) => watched.rows.some((row) => row.permission !== undefined));
        const ask = parked.rows.find((row) => row.permission !== undefined)?.permission;
        expect(ask).toMatchObject({ toolName: `Run the tests`, path: `package.json`, alwaysLabel: `Don't ask again for Run the tests` });
        expect(await card(`otter-k7mq`)).toMatchObject({ status: `awaiting`, attention: { permission: true } });

        const finished = watch(at.agents, at.folder, `otter-k7mq`);
        expect(await at.agents.proceduresFor(at.folder).agent.reply?.({ kind: `permission`, requestId: ask?.requestId ?? ``, decision: `deny` }, CALL)).toEqual({ ok: true });
        expect(said((await finished).rows)).toBe(`permission:deny`);
        expect(await card(`otter-k7mq`)).toMatchObject({ status: `idle`, attention: { permission: false } });
    });

    it(`reads a file the agent names as the folder's own path`, async () => {
        await say(`otter-k7mq`, `edit`);
        const watched = await watch(at.agents, at.folder, `otter-k7mq`);
        const tool = watched.rows.flatMap((row) => row.tools ?? [])[0];
        expect(tool).toMatchObject({ name: `Edit`, status: `completed`, locations: [{ path: `src/app.ts`, line: 3 }] });
        expect((await card(`otter-k7mq`))?.toolUses).toBe(1);
    });

    it(`stops a running turn, and holds what was said meanwhile for the next one`, async () => {
        const emptied: number[] = [];
        const started = await say(`otter-k7mq`, `wait`);
        await watch(at.agents, at.folder, `otter-k7mq`, (watched) => said(watched.rows) === `waiting`);
        expect(await say(`otter-k7mq`, `Hello after`)).toEqual({ delivered: `queued` });
        // Listed on the running turn's card meanwhile, so every window draws it as waiting.
        const waiting = (await card(`otter-k7mq`))?.queue;
        expect(waiting?.items.map((item) => [item.text, item.voice])).toEqual([[`Hello after`, `person`]]);
        // Once it has gone out, the turn it started says the queue empty at a later revision: a window replaces its copy
        // by revision, so an empty queue has to be said to be seen.
        const drained = at.agents.subscribe(at.folder.root, (event) => {
            if (event.kind === `agents`) {
                const queue = event.agents.find((agent) => agent.id === `otter-k7mq`)?.queue;
                if (queue !== undefined && queue.items.length === 0) {
                    emptied.push(queue.revision);
                }
            }
        });
        const ended = watch(at.agents, at.folder, `otter-k7mq`);
        expect(await at.agents.proceduresFor(at.folder).agent.stop?.({ conversationId: `otter-k7mq`, run: started?.run ?? `` }, CALL)).toEqual({ stopped: true });
        expect((await ended).ended).toBe(true);
        // What waited goes out as the next turn, whose card says the queue empty, one revision on.
        await waitFor(async () => expect((await card(`otter-k7mq`))?.turns).toBe(2));
        drained();
        expect(emptied[0]).toBeGreaterThan(waiting?.revision ?? 0);
        const page = await at.agents.proceduresFor(at.folder).agents.transcript?.({ id: `otter-k7mq` }, CALL);
        expect(page?.messages.filter((row) => row.role === `user`).map((row) => row.text)).toEqual([`wait`, `Hello after`]);
    });

    it(`says a failure as the turn's last word and keeps it on the card`, async () => {
        await say(`otter-k7mq`, `explode`);
        const watched = await watch(at.agents, at.folder, `otter-k7mq`);
        expect(watched.facts.some((fact) => fact.kind === `error`)).toBe(true);
        expect(await card(`otter-k7mq`)).toMatchObject({ status: `error`, failure: expect.stringContaining(`exploded`) });
    });

    it(`shows a window only its own folder's conversations`, async () => {
        await say(`otter-k7mq`, `Hello`);
        await watch(at.agents, at.folder, `otter-k7mq`);
        const elsewhere = { root: `${at.folder.root}-other`, place: { kind: `native` as const } };
        expect(await at.agents.proceduresFor(elsewhere).agents.list?.(undefined, CALL)).toMatchObject({ agents: [] });
        const refused = await Promise.resolve(at.agents.proceduresFor(elsewhere).agent.run?.({ conversationId: `otter-k7mq`, prompt: `Hi` }, CALL)).catch(
            (error: Error) => error.message,
        );
        expect(refused).toBe(`That conversation works in another folder.`);
        // Nor may it watch, stop or answer for one: to that window the conversation is not running at all.
        await at.agents.proceduresFor(at.folder).agent.run?.({ conversationId: `otter-k7mq`, prompt: `ask` }, CALL);
        const parked = await watch(at.agents, at.folder, `otter-k7mq`, (watched) => watched.rows.some((row) => row.permission !== undefined));
        const requestId = parked.rows.find((row) => row.permission !== undefined)?.permission?.requestId ?? ``;
        expect((await watch(at.agents, elsewhere, `otter-k7mq`)).rows).toEqual([]);
        expect(await at.agents.proceduresFor(elsewhere).agent.stop?.({ conversationId: `otter-k7mq`, live: true }, CALL)).toEqual({ stopped: false });
        // The handler refuses in the same breath it is called, so the call itself is what is caught.
        const answered = await Promise.resolve()
            .then(() => at.agents.proceduresFor(elsewhere).agent.reply?.({ kind: `permission`, requestId, decision: `once` }, CALL))
            .catch((error: Error) => error.message);
        expect(answered).toBe(`Nothing is waiting on that answer any more.`);
    });
});

describe(`a harness that is not signed in`, () => {
    it(`fails the turn with a sign-in to do, lists no account, and signs in the harness's own way`, async () => {
        const at = await world(fakeHarness(`--signed-out=${join(tmpdir(), `fake-harness-${crypto.randomUUID()}`)}`));
        try {
            const procedures = at.agents.proceduresFor(at.folder);
            expect(await procedures.accounts.accounts?.({ provider: `claude`, force: false }, CALL)).toEqual({ accounts: [] });
            await procedures.agent.run?.({ conversationId: `otter-k7mq`, prompt: `Hello` }, CALL);
            const watched = await watch(at.agents, at.folder, `otter-k7mq`);
            expect(watched.facts).toContainEqual(expect.objectContaining({ kind: `error`, code: `acp-auth-required` }));

            const started = await procedures.accounts.start?.({ provider: `claude` }, CALL);
            const handshake = started?.handshake ?? ``;
            expect(started?.flow).toBe(`device`);
            await waitFor(async () => expect(await procedures.accounts.status?.({ provider: `claude`, handshake }, CALL)).toEqual({ status: `ok` }));
            // Signed in, the harness has an account to list and a turn runs.
            expect((await procedures.accounts.accounts?.({ provider: `claude`, force: false }, CALL))?.accounts).toHaveLength(1);
        } finally {
            await at.dispose();
        }
    });

    // Seen with a real harness on the owner's PC (2026-11-24): a stored login past its time limit still names its
    // account and opens sessions, and refuses every prompt until somebody signs in again.
    it(`runs the sign-in again for a harness that lists an account and refuses to work on it`, async () => {
        const at = await world(fakeHarness(`--expired=${join(tmpdir(), `fake-harness-${crypto.randomUUID()}`)}`));
        try {
            const procedures = at.agents.proceduresFor(at.folder);
            const accounts = async () => (await procedures.accounts.accounts?.({ provider: `claude`, force: false }, CALL))?.accounts ?? [];
            expect(await accounts()).toHaveLength(1);
            await procedures.agent.run?.({ conversationId: `otter-k7mq`, prompt: `Hello` }, CALL);
            const refused = await watch(at.agents, at.folder, `otter-k7mq`);
            expect(refused.facts).toContainEqual(expect.objectContaining({ kind: `error`, code: `acp-auth-required` }));
            expect((await accounts())[0]?.needsReauth).toBe(true);

            const started = await procedures.accounts.start?.({ provider: `claude` }, CALL);
            const handshake = started?.handshake ?? ``;
            await waitFor(async () => expect(await procedures.accounts.status?.({ provider: `claude`, handshake }, CALL)).toEqual({ status: `ok` }));
            expect((await accounts())[0]?.needsReauth).toBeUndefined();
            await procedures.agent.run?.({ conversationId: `otter-k7mq`, prompt: `Hello` }, CALL);
            expect(said((await watch(at.agents, at.folder, `otter-k7mq`)).rows)).toContain(`Hi there`);
        } finally {
            await at.dispose();
        }
    });

    it(`runs a harness's own sign-in command and hands its page's address to the card`, async () => {
        const at = await world(fakeHarness(`--signed-out=${join(tmpdir(), `fake-harness-${crypto.randomUUID()}`)}`, `--command-sign-in`));
        try {
            const procedures = at.agents.proceduresFor(at.folder);
            const started = await procedures.accounts.start?.({ provider: `claude` }, CALL);
            expect(started?.url).toBe(`https://example.test/login?code=abc`);
            const handshake = started?.handshake ?? ``;
            await waitFor(async () => expect(await procedures.accounts.status?.({ provider: `claude`, handshake }, CALL)).toEqual({ status: `ok` }));
            await procedures.agent.run?.({ conversationId: `otter-k7mq`, prompt: `Hello` }, CALL);
            expect(said((await watch(at.agents, at.folder, `otter-k7mq`)).rows)).toBe(`Hi there`);
        } finally {
            await at.dispose();
        }
    });
});

describe(`a harness that is not on this computer`, () => {
    it(`is not listed as runnable, and a turn says so instead of starting`, async () => {
        const at = await world(fakeHarness(), false);
        try {
            const procedures = at.agents.proceduresFor(at.folder);
            expect(await procedures.providers.list?.(undefined, CALL)).toEqual({ native: [], agents: [], endpoints: [], loops: {} });
            expect(await procedures.providers.models?.({ provider: `claude` }, CALL)).toEqual({ models: [{ id: `default`, label: `Default` }], default: `default` });
            await procedures.agent.run?.({ conversationId: `otter-k7mq`, prompt: `Hello` }, CALL);
            const watched = await watch(at.agents, at.folder, `otter-k7mq`);
            expect(watched.facts).toContainEqual(expect.objectContaining({ kind: `error`, message: `Fake Code isn't installed on this computer.` }));
        } finally {
            await at.dispose();
        }
    });
});
