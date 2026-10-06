import "@intentic/testing/dom";
import type { SandboxLookup, SandboxSummary, User } from "@intentic/api-contract";
import { stubGlobal, waitFor } from "@intentic/testing/bun";
import { ref } from "vue";
import { sandboxSummary } from "../../../testing/sandboxSummary";

// Pins the glue between the platform's list and the device's memory: what it answers is remembered with the database it
// came from, a remembered sandbox it lacks is asked about once (deleted or someone else's let go of, unknown marked),
// and a list this window seeded itself while open directly is never remembered back.

const owner: User = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };
const user = ref<User | null>(owner);
jest.mock(`../../../client/auth/useAuth`, () => ({ useAuth: () => ({ user }) }));
const lookup = jest.fn<(input: { sandboxIds: string[] }) => Promise<SandboxLookup>>();
jest.mock(`../../../lib/useApi`, () => ({ apiClient: { sandbox: { lookup } } }));
stubGlobal(`fetch`, async () => new Response(JSON.stringify({ identity: `id-1`, since: `2026-10-01T22:42:40.466Z` }), { status: 200 }));

const { startRememberingSandboxes } = await import(`./rememberSandboxes`);
const { queryClient } = await import(`../../../lib/queryPersistence`);
const { SANDBOX_LIST_KEY } = await import(`../../../client/sandbox/useSandbox`);
const { forgetAccount, rememberedAccount } = await import(`../../../client/directory/deviceDirectory`);
const { directMode } = await import(`../../../client/directory/directState`);

startRememberingSandboxes();

const intentic = sandboxSummary({ id: `s1`, name: `intentic`, daemonUrl: `https://sandbox-82789f4106b4.radarsu.com`, lastSeenAt: `2026-10-01T18:00:09.479Z` });
const notes = sandboxSummary({ id: `s2`, name: `notes`, daemonUrl: `https://sandbox-574ea8038415.sbx.intentic.dev`, lastSeenAt: `2026-10-01T18:00:00.000Z` });
const trip = sandboxSummary({ id: `s3`, name: `trip`, daemonUrl: `https://sandbox-1ea6479e2362.sbx.intentic.dev`, lastSeenAt: `2026-10-01T18:00:00.000Z` });

const answer = (rows: SandboxSummary[]): void => {
    queryClient.setQueryData(SANDBOX_LIST_KEY, rows);
};
const remembered = () => rememberedAccount(owner.email)?.sandboxes.map((entry) => [entry.id, entry.missingSince === undefined ? `listed` : (entry.standing ?? `missing`)]);

beforeEach(() => {
    forgetAccount(owner.email);
    lookup.mockReset();
    directMode.value = false;
    user.value = owner;
});

it(`remembers a list the platform answered, with the database it came from`, async () => {
    answer([intentic]);
    await waitFor(() => expect(remembered()).toEqual([[`s1`, `listed`]]));
    expect(rememberedAccount(owner.email)?.identity).toBe(`id-1`);
    expect(lookup).not.toHaveBeenCalled();
});

it(`asks about the sandboxes a list lacks, letting go of the deleted and marking the unknown`, async () => {
    answer([intentic, notes, trip]);
    await waitFor(() => expect(remembered()).toEqual([[`s1`, `listed`], [`s2`, `listed`], [`s3`, `listed`]]));
    lookup.mockResolvedValue({
        sandboxes: [
            { sandboxId: `574ea8038415`, standing: `deleted` },
            { sandboxId: `1ea6479e2362`, standing: `unknown` },
        ],
    });
    answer([intentic]);
    await waitFor(() => expect(remembered()).toEqual([[`s1`, `listed`], [`s3`, `unknown`]]));
    expect(lookup.mock.calls).toEqual([[{ sandboxIds: [`574ea8038415`, `1ea6479e2362`] }]]);
});

it(`never remembers a list this window seeded itself while open directly`, async () => {
    answer([intentic]);
    await waitFor(() => expect(remembered()).toEqual([[`s1`, `listed`]]));
    directMode.value = true;
    answer([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(remembered()).toEqual([[`s1`, `listed`]]);
});
