import type { WorkspaceChildren } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { resetSandboxScope } from "@intentic/extension-api";
import { effectScope } from "vue";
import * as actualSandboxRpc from "../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

/* A folder's listing asked for again while a read of it is still out. Skipping that ask let a read that left before a
   paste stand as the folder's last word, so the pasted file stayed missing until something else in it moved. */

// Every read of a folder, parked until the test answers it.
const reads: { readonly path: string; readonly answer: (listing: WorkspaceChildren) => void }[] = [];
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock("../../../client/sandbox/sandboxRpc", () => ({
    ...realSandboxRpc,
    sandboxRpc: fakeSandboxRpc({
        workspace: {
            children: (input) => new Promise<WorkspaceChildren>((resolve) => reads.push({ path: input.path, answer: resolve })),
        },
    }),
}));

const { drawsListings, lazyChildren, listingsSeen, relist, relistWhenSeen } = await import("./lazyListings");
const { receiveDesktopShown } = await import("../../../workbench/window/onScreen");

const listing = (...names: string[]): WorkspaceChildren => ({ entries: names.map((name) => ({ name, path: `src/${name}`, type: `file` })), hidden: 0 });
// Lets an answered read settle, and the turn it left in end.
const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
        await Promise.resolve();
    }
};

afterEach(() => {
    reads.length = 0;
    resetSandboxScope();
});

it(`reads a folder once more when asked again while an earlier read of it is out`, async () => {
    relist(`src`);
    await settle();
    relist(`src`);
    expect(reads.map((read) => read.path)).toEqual([`src`]);

    reads[0]?.answer(listing(`a.md`));
    await settle();
    expect(reads.map((read) => read.path)).toEqual([`src`, `src`]);
    reads[1]?.answer(listing(`a copy.md`, `a.md`));
    await settle();
    expect(lazyChildren.value.get(`src`)?.map((entry) => entry.name)).toEqual([`a copy.md`, `a.md`]);
});

// Every surface holding the tree relists on the same change; the read the first one started already postdates it.
it(`reads once for asks made in the same turn as the read`, async () => {
    relist(`src`);
    relist(`src`);
    relist(`src`);
    reads[0]?.answer(listing(`a.md`));
    await settle();
    expect(reads).toHaveLength(1);
});

/* Every window composes the tree store and restores the expanded folders every window shares, so a window drawing no
   tree (the floating chat), or one nobody could see, read every changed folder anyway: the steadiest daemon call in
   every window. A change is read while a listing is drawn on screen, and one that landed meanwhile once it is. */
it(`reads a changed folder only while a listing is drawn and on screen, and catches up once one is`, async () => {
    lazyChildren.value.set(`src`, []);
    relistWhenSeen(`src`);
    await settle();
    expect(reads).toHaveLength(0);

    // A tree mounts in this window: what changed while none was drawn is read now.
    const tree = effectScope();
    tree.run(() => drawsListings());
    await settle();
    expect(reads.map((read) => read.path)).toEqual([`src`]);
    reads[0]?.answer(listing(`a.md`));
    await settle();

    // Out of sight (minimised, or hidden in the tray): nothing is read until it is back.
    receiveDesktopShown(false);
    relistWhenSeen(`src`);
    relistWhenSeen(`src`);
    await settle();
    expect(reads).toHaveLength(1);
    receiveDesktopShown(true);
    await settle();
    expect(reads.map((read) => read.path)).toEqual([`src`, `src`]);
    reads[1]?.answer(listing(`a.md`, `b.md`));
    await settle();

    tree.stop();
    expect(listingsSeen.value).toBe(false);
});
