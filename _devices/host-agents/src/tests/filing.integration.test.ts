import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { CALL, watch, world, type World } from "./world.js";

// Putting a conversation away, as a sandbox's board files its cards: the archive, back out of it, and emptied for good.

describe(`a conversation put away on this computer`, () => {
    let at: World;
    beforeEach(async () => {
        at = await world();
    });
    afterEach(() => at.dispose());

    const say = (conversationId: string, prompt: string) => at.agents.proceduresFor(at.folder).agent.run?.({ conversationId, prompt }, CALL);
    const agents = () => at.agents.proceduresFor(at.folder).agents;
    const ids = (page: { readonly agents: readonly { readonly id: string }[] } | undefined) => page?.agents.map((card) => card.id);

    it(`leaves the board for the archive, stays there across the app quitting, and comes back`, async () => {
        await say(`otter-k7mq`, `Hello`);
        await watch(at.agents, at.folder, `otter-k7mq`);

        expect(await agents().archive?.({ ids: [`otter-k7mq`] }, CALL)).toMatchObject({ moved: [{ id: `otter-k7mq` }], failed: [] });
        expect(ids(await agents().list?.(undefined, CALL))).toEqual([]);
        expect(ids(await agents().archived?.(undefined, CALL))).toEqual([`otter-k7mq`]);

        at.restarted();
        expect(ids(await agents().archived?.(undefined, CALL))).toEqual([`otter-k7mq`]);

        expect(await agents().unarchive?.({ ids: [`otter-k7mq`] }, CALL)).toMatchObject({ moved: [{ id: `otter-k7mq`, title: `Hello` }] });
        expect(ids(await agents().list?.(undefined, CALL))).toEqual([`otter-k7mq`]);
        expect(ids(await agents().archived?.(undefined, CALL))).toEqual([]);
    });

    it(`keeps a conversation running a turn on the board, and refuses one of another folder`, async () => {
        await say(`otter-k7mq`, `ask`);
        await watch(at.agents, at.folder, `otter-k7mq`, (watched) => watched.rows.some((row) => row.permission !== undefined));
        const elsewhere = { root: `${at.folder.root}-other`, place: { kind: `native` as const } };

        const filed = await agents().archive?.({ ids: [`otter-k7mq`] }, CALL);
        expect(filed).toMatchObject({ moved: [], failed: [{ id: `otter-k7mq`, reason: expect.stringContaining(`running a turn`) }] });
        expect(await at.agents.proceduresFor(elsewhere).agents.archive?.({ ids: [`otter-k7mq`] }, CALL)).toMatchObject({
            moved: [],
            failed: [{ id: `otter-k7mq`, reason: `No such conversation in this folder.` }],
        });
        expect(ids(await agents().list?.(undefined, CALL))).toEqual([`otter-k7mq`]);
    });

    it(`is deleted for good when the archive is emptied, its record with it`, async () => {
        await say(`otter-k7mq`, `Hello`);
        await watch(at.agents, at.folder, `otter-k7mq`);
        await say(`badger-p2zx`, `Hello again`);
        await watch(at.agents, at.folder, `badger-p2zx`);
        await waitFor(async () => expect(await readdir(join(at.home, `conversations`))).toEqual(expect.arrayContaining([`otter-k7mq.json`, `badger-p2zx.json`])));
        await agents().archive?.({ ids: [`otter-k7mq`] }, CALL);

        expect(await agents().purge?.(undefined, CALL)).toEqual({ removed: [`otter-k7mq`] });
        expect(ids(await agents().archived?.(undefined, CALL))).toEqual([]);
        // The one still on the board is not the archive's to empty.
        expect(ids(await agents().list?.(undefined, CALL))).toEqual([`badger-p2zx`]);
        await waitFor(async () => expect(await readdir(join(at.home, `conversations`))).toEqual([`badger-p2zx.json`]));
    });
});
