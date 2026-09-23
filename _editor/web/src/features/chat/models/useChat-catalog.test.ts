import "@intentic/testing/dom";
import { RunnableProvidersSchema, TrialStatusSchema } from "@intentic/sandbox-contract";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// What a catalog read does to the chats already open on that provider. A routed channel de-lists a model for as long as
// it is out of capacity or quota for it, so "not in this list" is a state that ends, and the pick it moves a chat off
// is the user's.

// The catalog reads are the whole subject: the providers this box adds, each provider's and endpoint's catalog, and the
// trial allowance that rides the same load. Any other daemon call throws naming its procedure.
const providersList = jest.fn();
const providerModels = jest.fn();
const endpointModels = jest.fn();
const trial = jest.fn();
jest.mock("../../sandbox/client/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({ providers: { list: providersList, models: providerModels }, endpoints: { models: endpointModels, trial } }),
}));

const { loadActiveProviderModels, loadRunnableProviders, loadProviderModels } = await import("./useChat-catalog");
const { NATIVE_PROVIDERS } = await import("@intentic/sandbox-contract");
const { acpProviders, endpointProviders, endpointsLoaded, nativeReady } = await import("../accounts/providerCatalog");
const { setConversations } = await import("../tabs/useChat-tabs");
const { Conversation } = await import("../session/conversation");

const OPUS = `claude-opus-4-6-thinking`;
const PRO_LOW = `gemini-3.1-pro-low`;

// A catalog answer, a provider's or an endpoint's alike: rows plus the id an unpinned turn opens on.
const serves = (ids: readonly string[]): void => {
    const catalog = { models: ids.map((id) => ({ id, label: id })), default: ids[0] };
    providerModels.mockResolvedValue(catalog);
    endpointModels.mockResolvedValue(catalog);
};

const chatOn = (provider: "gemini" | "claude", model: string): InstanceType<typeof Conversation> => {
    const chat = new Conversation(`c-${provider}`);
    chat.selection.apply({ kind: `selectModel`, pick: { provider, value: model } });
    return chat;
};

beforeEach(() => {
    for (const read of [providersList, providerModels, endpointModels, trial]) {
        read.mockReset();
    }
    endpointsLoaded.value = false;
    acpProviders.value = [];
    endpointProviders.value = [];
    nativeReady.value = [];
});

// No trial here, which is what most sandboxes answer.
const NO_TRIAL = TrialStatusSchema.parse({ available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` });

// The daemon's `providers.list` answer, and the trial allowance read that rides on the same load.
const answers = (providers: unknown): void => {
    providersList.mockResolvedValue(providers);
    trial.mockResolvedValue(NO_TRIAL);
};

const refuses = (status: number): void => {
    providersList.mockRejectedValue(new SandboxHttpError(status, `refused`));
    trial.mockResolvedValue(NO_TRIAL);
};

// A body this build can't read, as the typed client throws it: its own parse of the answer, refused.
const unreadable = (body: unknown): void => {
    providersList.mockRejectedValue(RunnableProvidersSchema.safeParse(body).error);
    trial.mockResolvedValue(NO_TRIAL);
};

test(`takes the providers this box adds from the daemon's own answer`, async () => {
    serves([OPUS]);
    answers({
        native: [`claude`],
        agents: [{ id: `goose`, label: `Goose` }],
        endpoints: [{ id: `endpoint/trial`, label: `Free trial`, kind: `endpoint` }],
    });

    await loadRunnableProviders().settled;

    expect(acpProviders.value).toEqual([{ id: `goose`, label: `Goose` }]);
    expect(endpointProviders.value).toEqual([{ id: `endpoint/trial`, label: `Free trial`, kind: `endpoint` }]);
    // The half a reader who cannot open /accounts has instead: which of the fixed native list can actually run.
    expect(nativeReady.value).toEqual([`claude`]);
    // An endpoint's catalog is its own route, addressed by the capability behind the `endpoint/` prefix.
    expect(endpointModels).toHaveBeenCalledWith({ id: `trial` });
    expect(endpointsLoaded.value).toBe(true);
});

// The bug this guards: an invited member whose tier can drive turns but not read the box's connections was left with
// "Checking your AI accounts…" over the composer for as long as the tab stayed open, since the gate waits on this half.
test(`a refused or unserved read is an answer, so the account gate stops waiting`, async () => {
    for (const status of [403, 404]) {
        endpointsLoaded.value = false;
        refuses(status);

        await loadRunnableProviders().settled;

        expect(endpointProviders.value, `${status}`).toEqual([]);
        expect(endpointsLoaded.value, `${status}`).toBe(true);
    }
});

test(`a daemon that may yet answer leaves the half unknown for the next reachable load`, async () => {
    refuses(503);
    await loadRunnableProviders().settled;
    expect(endpointsLoaded.value).toBe(false);

    providersList.mockRejectedValue(new Error(`Failed to fetch`));
    await loadRunnableProviders().settled;
    expect(endpointsLoaded.value).toBe(false);
});

// A build whose daemon answers a shape it cannot read is in the same position as one that was refused: retrying reads
// the same body again, and the composer would wait on it forever.
test(`an unreadable answer leaves the lists alone and still resolves the gate`, async () => {
    unreadable({ capabilities: [{ id: `goose`, kind: `agent`, config: {} }] });

    await loadRunnableProviders().settled;

    expect(acpProviders.value).toEqual([]);
    expect(endpointsLoaded.value).toBe(true);
});

test(`moves an open chat off a model the catalog stopped offering, and puts it back when the next read lists it`, async () => {
    const chat = chatOn(`gemini`, OPUS);
    setConversations([chat], chat.conversationId, `catalog-test`);

    serves([PRO_LOW]);
    await loadProviderModels(`gemini`);
    expect(chat.selection.model.value).toBe(PRO_LOW);
    expect(chat.selection.displacedModel.value).toBe(OPUS);

    // The channel is serving it again: the user picked this model once, and nothing since has said otherwise.
    serves([OPUS, PRO_LOW]);
    await loadProviderModels(`gemini`);
    expect(chat.selection.model.value).toBe(OPUS);
    expect(chat.selection.displacedModel.value).toBeUndefined();
});

test(`leaves a chat pinned to a model the catalog still offers exactly where it is`, async () => {
    const chat = chatOn(`gemini`, PRO_LOW);
    setConversations([chat], chat.conversationId, `catalog-test`);

    serves([OPUS, PRO_LOW]);
    await loadProviderModels(`gemini`);

    expect(chat.selection.model.value).toBe(PRO_LOW);
    expect(chat.selection.displacedModel.value).toBeUndefined();
});

// The seam a reachable daemon runs (loadAccountStatus) used to warm the whole native list here, so a first paint asked
// one request per provider for catalogs nothing was drawing, ahead of the reads the screen was waiting on.
test(`the reachable seam reads the open chat's catalog, and no other provider's`, async () => {
    const open = chatOn(`gemini`, PRO_LOW);
    setConversations([open], open.conversationId, `catalog-test`);
    serves([PRO_LOW]);

    await loadActiveProviderModels();

    expect(NATIVE_PROVIDERS.length, `with one native provider this pins nothing`).toBeGreaterThan(1);
    expect(providerModels).toHaveBeenCalledTimes(1);
    expect(providerModels).toHaveBeenCalledWith({ provider: open.selection.provider.value });
    expect(endpointModels).not.toHaveBeenCalled();
});

test(`reads one provider's catalog against that provider's chats only`, async () => {
    const elsewhere = chatOn(`claude`, `claude-opus-5`);
    setConversations([elsewhere], elsewhere.conversationId, `catalog-test`);

    // Ids from another provider's list say nothing about this chat's pin.
    serves([PRO_LOW]);
    await loadProviderModels(`gemini`);

    expect(elsewhere.selection.model.value).toBe(`claude-opus-5`);
    expect(elsewhere.selection.displacedModel.value).toBeUndefined();
});
