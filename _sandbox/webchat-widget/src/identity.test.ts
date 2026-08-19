import { afterEach, expect, test, vi } from "vitest";
import { resetConversation, storeDisplayName, storedDisplayName, visitorConversationId } from "./identity.js";

afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test(`the thread id is minted once and reused — this is what threads a follow-up into one conversation`, () => {
    const first = visitorConversationId(`support`);
    expect(visitorConversationId(`support`)).toBe(first);
});

test(`two Front Desks on one site are two threads`, () => {
    expect(visitorConversationId(`support`)).not.toBe(visitorConversationId(`sales`));
});

test(`"New chat" mints a fresh thread and leaves the name alone`, () => {
    const before = visitorConversationId(`support`);
    storeDisplayName(`support`, `Ada`);
    const after = resetConversation(`support`);
    expect(after).not.toBe(before);
    expect(visitorConversationId(`support`)).toBe(after);
    expect(storedDisplayName(`support`)).toBe(`Ada`);
});

test(`a browser that refuses storage still chats — it just gets a fresh thread each time`, () => {
    vi.spyOn(Storage.prototype, `getItem`).mockImplementation(() => {
        throw new Error(`SecurityError`);
    });
    vi.spyOn(Storage.prototype, `setItem`).mockImplementation(() => {
        throw new Error(`SecurityError`);
    });
    expect(visitorConversationId(`support`)).toMatch(/^[0-9a-f-]{36}$/);
    expect(storedDisplayName(`support`)).toBeUndefined();
});
