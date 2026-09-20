// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";

// What a catalog read does to the chats already open on that provider. A routed channel de-lists a model for as long as
// it is out of capacity or quota for it, so "not in this list" is a state that ends, and the pick it moves a chat off
// is the user's.

// The catalog read is the whole subject; every other daemon call belongs to a different one. Every export the modules
// under test import is named here, not just the two this suite drives, or their own imports link to nothing.
vi.mock("../../sandbox/client/sandboxClient", () => ({
    sandboxRequest: vi.fn(),
    sandboxJson: vi.fn(async () => ({})),
    sandboxRequestVia: vi.fn(),
    sandboxError: vi.fn(),
    // Carries the status, like the real one: the provider read branches on it, and `instanceof` is only true for the
    // class the module under test imported, which is this one.
    SandboxHttpError: class extends Error {
        constructor(
            readonly status: number,
            message: string,
        ) {
            super(message);
        }
    },
}));

const { sandboxJson, sandboxRequest, SandboxHttpError } = await import("../../sandbox/client/sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);
const sandboxJsonMock = vi.mocked(sandboxJson);
const { loadActiveProviderModels, loadRunnableProviders, loadProviderModels } = await import("./useChat-catalog");
const { NATIVE_PROVIDERS } = await import("@intentic/sandbox-contract");
const { acpProviders, endpointProviders, endpointsLoaded } = await import("../accounts/providerCatalog");
const { setConversations } = await import("../tabs/useChat-tabs");
const { Conversation } = await import("../session/conversation");

const OPUS = `claude-opus-4-6-thinking`;
const PRO_LOW = `gemini-3.1-pro-low`;

// The daemon's `/providers/{id}/models` answer: rows plus the id an unpinned turn opens on.
const serves = (ids: readonly string[]): void => {
    sandboxRequestMock.mockResolvedValue({
        ok: true,
        json: async () => ({ models: ids.map((id) => ({ id, label: id })), default: ids[0] }),
    } as Response);
};

const chatOn = (provider: "gemini" | "claude", model: string): InstanceType<typeof Conversation> => {
    const chat = new Conversation(`c-${provider}`);
    chat.selectModel({ provider, value: model });
    return chat;
};

beforeEach(() => {
    sandboxRequestMock.mockReset();
    sandboxJsonMock.mockReset();
    endpointsLoaded.value = false;
    acpProviders.value = [];
    endpointProviders.value = [];
});

// The daemon's `/providers` answer, and the trial allowance read that rides on the same load.
const answers = (providers: unknown): void => {
    sandboxJsonMock.mockImplementation(async (path: string) =>
        path === `/providers` ? providers : { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` },
    );
};

const refuses = (status: number): void => {
    sandboxJsonMock.mockImplementation(async (path: string) => {
        if (path === `/providers`) {
            throw new SandboxHttpError(status, `refused`);
        }
        return { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    });
};

test(`takes the providers this box adds from the daemon's own answer`, async () => {
    serves([OPUS]);
    answers({ agents: [{ id: `goose`, label: `Goose` }], endpoints: [{ id: `endpoint/trial`, label: `Free trial`, kind: `endpoint` }] });

    await loadRunnableProviders();

    expect(acpProviders.value).toEqual([{ id: `goose`, label: `Goose` }]);
    expect(endpointProviders.value).toEqual([{ id: `endpoint/trial`, label: `Free trial`, kind: `endpoint` }]);
    expect(endpointsLoaded.value).toBe(true);
});

// The bug this guards: an invited member whose tier can drive turns but not read the box's connections was left with
// "Checking your AI accounts…" over the composer for as long as the tab stayed open, since the gate waits on this half.
test(`a refused or unserved read is an answer, so the account gate stops waiting`, async () => {
    for (const status of [403, 404]) {
        endpointsLoaded.value = false;
        refuses(status);

        await loadRunnableProviders();

        expect(endpointProviders.value, `${status}`).toEqual([]);
        expect(endpointsLoaded.value, `${status}`).toBe(true);
    }
});

test(`a daemon that may yet answer leaves the half unknown for the next reachable load`, async () => {
    refuses(503);
    await loadRunnableProviders();
    expect(endpointsLoaded.value).toBe(false);

    sandboxJsonMock.mockRejectedValue(new Error(`Failed to fetch`));
    await loadRunnableProviders();
    expect(endpointsLoaded.value).toBe(false);
});

// A build whose daemon answers a shape it cannot read is in the same position as one that was refused: retrying reads
// the same body again, and the composer would wait on it forever.
test(`an unreadable answer leaves the lists alone and still resolves the gate`, async () => {
    answers({ capabilities: [{ id: `goose`, kind: `agent`, config: {} }] });

    await loadRunnableProviders();

    expect(acpProviders.value).toEqual([]);
    expect(endpointsLoaded.value).toBe(true);
});

test(`moves an open chat off a model the catalog stopped offering, and puts it back when the next read lists it`, async () => {
    const chat = chatOn(`gemini`, OPUS);
    setConversations([chat], chat.conversationId, `catalog-test`);

    serves([PRO_LOW]);
    await loadProviderModels(`gemini`);
    expect(chat.model.value).toBe(PRO_LOW);
    expect(chat.displacedModel.value).toBe(OPUS);

    // The channel is serving it again: the user picked this model once, and nothing since has said otherwise.
    serves([OPUS, PRO_LOW]);
    await loadProviderModels(`gemini`);
    expect(chat.model.value).toBe(OPUS);
    expect(chat.displacedModel.value).toBeUndefined();
});

test(`leaves a chat pinned to a model the catalog still offers exactly where it is`, async () => {
    const chat = chatOn(`gemini`, PRO_LOW);
    setConversations([chat], chat.conversationId, `catalog-test`);

    serves([OPUS, PRO_LOW]);
    await loadProviderModels(`gemini`);

    expect(chat.model.value).toBe(PRO_LOW);
    expect(chat.displacedModel.value).toBeUndefined();
});

// The seam a reachable daemon runs (loadAccountStatus) used to warm the whole native list here, so a first paint asked
// one request per provider for catalogs nothing was drawing, ahead of the reads the screen was waiting on.
test(`the reachable seam reads the open chat's catalog, and no other provider's`, async () => {
    const open = chatOn(`gemini`, PRO_LOW);
    setConversations([open], open.conversationId, `catalog-test`);
    serves([PRO_LOW]);

    await loadActiveProviderModels();

    const asked = sandboxRequestMock.mock.calls.map(([path]) => String(path));
    expect(NATIVE_PROVIDERS.length, `with one native provider this pins nothing`).toBeGreaterThan(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(open.provider.value);
});

test(`reads one provider's catalog against that provider's chats only`, async () => {
    const elsewhere = chatOn(`claude`, `claude-opus-5`);
    setConversations([elsewhere], elsewhere.conversationId, `catalog-test`);

    // Ids from another provider's list say nothing about this chat's pin.
    serves([PRO_LOW]);
    await loadProviderModels(`gemini`);

    expect(elsewhere.model.value).toBe(`claude-opus-5`);
    expect(elsewhere.displacedModel.value).toBeUndefined();
});
