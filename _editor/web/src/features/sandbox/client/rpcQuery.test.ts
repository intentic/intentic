import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { QueryClient } from "@tanstack/vue-query";
import { ref } from "vue";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { activeSandboxId } from "../overview/activeSandbox";
import { mirrors, UNPERSISTED } from "../../../lib/queryPersistence";

// A contract read's cache entry is named by its procedure, its input and its sandbox, and its fetch is exactly that
// procedure with exactly that input: the two halves come from one call, so a read cannot fetch one thing and file it
// under another.

// Answers with the repo it was asked about, so an entry says which fetch filled it.
const readFile = jest.fn(async (input: { readonly repo: string; readonly path: string }, _options?: unknown) => ({
    path: input.path,
    content: input.repo,
}));
const settings = jest.fn(async () => SandboxSettingsSchema.parse({}));
jest.mock(`./sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ git: { readFile }, settings: { get: settings } }) }));

const { rpcQuery } = await import(`./rpcQuery`);

const README = { repo: `app`, path: `README.md` };

let client: QueryClient;
beforeEach(() => {
    client = new QueryClient();
    activeSandboxId.value = `sbx-here`;
    readFile.mockClear();
    settings.mockClear();
});

describe(`rpcQuery`, () => {
    it(`files a read under its route name and input, with the active sandbox last`, async () => {
        await client.fetchQuery(rpcQuery(`git.readFile`, README));
        expect(client.getQueryData<unknown>([`git.readFile`, README, `sbx-here`])).toEqual({ path: `README.md`, content: `app` });
        expect(readFile.mock.calls).toEqual([[README, { context: {} }]]);
    });

    it(`files a read that takes no input under its route name alone`, async () => {
        await client.fetchQuery(rpcQuery(`settings.get`));
        expect(client.getQueryData<unknown>([`settings.get`, `sbx-here`])).toEqual(SandboxSettingsSchema.parse({}));
    });

    it(`aims a read at another sandbox, and names that box in its key`, async () => {
        await client.fetchQuery(rpcQuery(`git.readFile`, README, { at: `sbx-laptop` }));
        expect(client.getQueryData<unknown>([`git.readFile`, README, `sbx-laptop`])).toEqual({ path: `README.md`, content: `app` });
        expect(client.getQueryData<unknown>([`git.readFile`, README, `sbx-here`])).toBeUndefined();
        expect(readFile.mock.calls).toEqual([[README, { context: { at: `sbx-laptop` } }]]);
    });

    it(`asks quietly for a read nobody is waiting on`, async () => {
        await client.fetchQuery(rpcQuery(`git.readFile`, README, { at: `sbx-laptop`, background: true }));
        expect(readFile.mock.calls).toEqual([[README, { context: { at: `sbx-laptop`, background: true } }]]);
    });

    // The storage rule reads the mark off the key itself (queryPersistence's `mirrors`).
    it(`keeps a heavy read out of the persisted mirror, and an ordinary one in it`, () => {
        const heavy = rpcQuery(`git.readFile`, README, { unpersisted: true }).queryKey.value;
        expect(heavy).toContain(UNPERSISTED);
        expect(mirrors(heavy)).toBe(false);
        expect(mirrors(rpcQuery(`git.readFile`, README).queryKey.value)).toBe(true);
    });

    it(`follows a reactive input: the key and the fetch move together`, async () => {
        const repo = ref(`app`);
        const query = rpcQuery(`git.readFile`, () => ({ repo: repo.value, path: `README.md` }));
        repo.value = `site`;
        await client.fetchQuery(query);
        expect(client.getQueryData<unknown>([`git.readFile`, { repo: `site`, path: `README.md` }, `sbx-here`])).toEqual({
            path: `README.md`,
            content: `site`,
        });
        expect(readFile.mock.calls).toEqual([[{ repo: `site`, path: `README.md` }, { context: {} }]]);
    });
});
