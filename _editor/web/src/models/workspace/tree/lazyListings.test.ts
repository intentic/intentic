import type { WorkspaceChildren } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { resetSandboxScope } from "@intentic/extension-api";
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

const { lazyChildren, relist } = await import("./lazyListings");

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
