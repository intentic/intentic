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
}));

const { sandboxRequest } = await import("../../sandbox/client/sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);
const { loadProviderModels } = await import("./useChat-catalog");
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

test(`reads one provider's catalog against that provider's chats only`, async () => {
    const elsewhere = chatOn(`claude`, `claude-opus-5`);
    setConversations([elsewhere], elsewhere.conversationId, `catalog-test`);

    // Ids from another provider's list say nothing about this chat's pin.
    serves([PRO_LOW]);
    await loadProviderModels(`gemini`);

    expect(elsewhere.model.value).toBe(`claude-opus-5`);
    expect(elsewhere.displacedModel.value).toBeUndefined();
});
