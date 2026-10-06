// Pins how a window keeps the reader's words with the sandbox: their kept answer wins where there is one, with none kept
// this browser's answer is offered once, an answer given here is sent, and an offer the sandbox declines is adopted.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import { nextTick, type Ref, ref } from "vue";
import type { Audience } from "../../app/useAudience";

interface Kept {
    readonly audience?: Audience;
}
interface Sent {
    readonly audience: Audience;
    readonly offer: boolean;
}

// A fresh settings read per test: a sync started by an earlier test watches its own ref and never hears this one's.
let settings: Ref<Kept | undefined> = ref(undefined);
const sent: Sent[] = [];
let reply = async (input: Sent): Promise<{ audience: Audience; adopted: boolean }> => ({ audience: input.audience, adopted: true });

jest.mock(`./useSandboxQuery`, () => ({ useSandboxQuery: () => ({ query: { data: settings } }) }));
jest.mock(`./rpcQuery`, () => ({ rpcQuery: () => ({}) }));
jest.mock(`./sandboxRpc`, () => ({
    sandboxRpc: {
        settings: {
            setAudience: async (input: Sent) => {
                sent.push(input);
                return reply(input);
            },
        },
    },
}));
jest.mock(`../../lib/queryPersistence`, () => ({ queryClient: { invalidateQueries: async () => undefined } }));
jest.mock(`./useDaemonRoutes`, () => ({ supportsRoute: () => true }));

const { adoptAudience, useAudience } = await import("../../app/useAudience");

const start = async (kept: Kept | undefined): Promise<void> => {
    settings = ref(kept);
    sent.length = 0;
    const { startAudienceSync } = await freshImport<typeof import("./audienceSync")>("./audienceSync", import.meta.url);
    startAudienceSync();
    await nextTick();
};

// The requests a started sync sends are fire-and-forget; one macrotask lets them settle.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    reply = async (input) => ({ audience: input.audience, adopted: true });
});

test(`the answer the sandbox keeps for this person is taken, and nothing is sent back`, async () => {
    adoptAudience(`developer`);
    await start({ audience: `maker` });

    expect(useAudience().audience.value).toBe(`maker`);
    expect(sent).toEqual([]);
});

test(`with none kept, this browser's answer is offered once`, async () => {
    adoptAudience(`maker`);
    await start({});
    await settled();

    settings.value = {};
    await nextTick();
    await settled();

    expect(sent).toEqual([{ audience: `maker`, offer: true }]);
});

test(`an answer given here is sent to the sandbox`, async () => {
    adoptAudience(`developer`);
    await start({ audience: `developer` });

    useAudience().setAudience(`maker`);
    await settled();

    expect(sent).toEqual([{ audience: `maker`, offer: false }]);
});

test(`an offer the sandbox declines leaves the answer it keeps in charge here`, async () => {
    adoptAudience(`developer`);
    reply = async () => ({ audience: `maker`, adopted: false });
    await start({});
    await settled();

    expect(sent).toEqual([{ audience: `developer`, offer: true }]);
    expect(useAudience().audience.value).toBe(`maker`);
});
