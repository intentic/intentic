// Pins how a window keeps the reader's words with the sandbox: the sandbox's answer is taken whole, its mode decides
// for whoever has not chosen, a choice made here is sent and the sandbox's reply worn, and nothing a browser held on
// its own is ever offered.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import { nextTick, type Ref, ref } from "vue";
import type { Audience } from "../../app/useAudience";
import type { MemberAudience } from "@intentic/sandbox-contract/schemas/settings";

interface Sent {
    readonly audience: Audience | null;
}

// A fresh settings read per test: a sync started by an earlier test watches its own ref and never hears this one's.
let settings: Ref<MemberAudience | undefined> = ref(undefined);
const sent: Sent[] = [];
interface Reply {
    audience: Audience;
    adopted: boolean;
    override?: Audience;
}
// The sandbox as it answers a choice: the choice worn and kept, or a hands-on sandbox's words once it is forgotten.
const keeps = async (input: Sent): Promise<Reply> => {
    const answer: Reply = { audience: input.audience ?? `developer`, adopted: true };
    if (input.audience !== null) {
        answer.override = input.audience;
    }
    return answer;
};
let reply = keeps;

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

const { adoptSandboxWords, useAudience } = await import("../../app/useAudience");

const start = async (kept: MemberAudience | undefined): Promise<void> => {
    settings = ref(kept);
    sent.length = 0;
    const { startAudienceSync } = await freshImport<typeof import("./audienceSync")>("./audienceSync", import.meta.url);
    startAudienceSync();
    await nextTick();
};

// The requests a started sync sends are fire-and-forget; one macrotask lets them settle.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    reply = keeps;
});

test(`a hands-off sandbox speaks plain words to someone who has not chosen, and nothing is sent`, async () => {
    adoptSandboxWords({ audience: `developer` });
    await start({ audience: `maker`, mode: `hands-off` });

    expect(useAudience().audience.value).toBe(`maker`);
    expect(useAudience().mode.value).toBe(`hands-off`);
    expect(useAudience().override.value).toBeUndefined();
    expect(sent).toEqual([]);
});

test(`a person's own choice wins over the mode`, async () => {
    await start({ audience: `developer`, override: `developer`, mode: `hands-off` });

    expect(useAudience().audience.value).toBe(`developer`);
    expect(useAudience().override.value).toBe(`developer`);
});

test(`this browser's words are never offered to a sandbox that keeps none`, async () => {
    adoptSandboxWords({ audience: `maker` });
    await start({ audience: `developer`, mode: `hands-on` });
    await settled();

    expect(sent).toEqual([]);
    expect(useAudience().audience.value).toBe(`developer`);
});

test(`a daemon from before the mode: its kept answer is the choice, and with none this browser's words stand`, async () => {
    adoptSandboxWords({ audience: `maker` });
    await start({});
    await settled();

    expect(useAudience().audience.value).toBe(`maker`);
    expect(sent).toEqual([]);

    settings.value = { audience: `developer` };
    await nextTick();

    expect(useAudience().audience.value).toBe(`developer`);
    expect(useAudience().override.value).toBe(`developer`);
});

test(`a choice made here is sent, and following again sends null`, async () => {
    await start({ audience: `maker`, mode: `hands-off` });

    useAudience().setAudience(`developer`);
    await settled();
    useAudience().setAudience(null);
    await settled();

    expect(sent).toEqual([{ audience: `developer` }, { audience: null }]);
});

test(`the sandbox's reply to a choice is what this window wears`, async () => {
    await start({ audience: `developer`, mode: `hands-on` });
    reply = async () => ({ audience: `maker`, adopted: true, override: `maker` });

    useAudience().setAudience(`maker`);
    await settled();

    expect(useAudience().audience.value).toBe(`maker`);
    expect(useAudience().override.value).toBe(`maker`);
    expect(useAudience().mode.value).toBe(`hands-on`);
});
