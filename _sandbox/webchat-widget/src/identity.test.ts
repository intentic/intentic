import { unstubAllGlobals } from "@intentic/testing/bun";
import {
    resetConversation,
    storeCursor,
    storeDisplayName,
    storeSpoke,
    storedCursor,
    storedDisplayName,
    storedSpoke,
    visitorConversationId,
} from "./identity.js";

afterEach(() => {
    window.localStorage.clear();
    unstubAllGlobals();
    jest.restoreAllMocks();
});

test(`the thread id is minted once and reused: this is what threads a follow-up into one conversation`, () => {
    const first = visitorConversationId(`support`);
    expect(visitorConversationId(`support`)).toBe(first);
});

test(`two Visitor chats on one site are two threads`, () => {
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

test(`a thread that has never written is owed nothing, and says so: this is what keeps a reader from polling`, () => {
    expect(storedSpoke(`support`)).toBe(false);
    expect(storedCursor(`support`)).toBe(0);
    storeSpoke(`support`);
    storeCursor(`support`, 4);
    expect(storedSpoke(`support`)).toBe(true);
    expect(storedCursor(`support`)).toBe(4);
});

test(`"New chat" rewinds the cursor, so a fresh thread cannot inherit the last one's collected replies`, () => {
    storeSpoke(`support`);
    storeCursor(`support`, 7);
    resetConversation(`support`);
    expect(storedCursor(`support`)).toBe(0);
    expect(storedSpoke(`support`)).toBe(false);
});

test(`a cursor that storage lost or a hand corrupted reads as the start of the thread, never as NaN`, () => {
    window.localStorage.setItem(`intentic.visitor-chat.support.cursor`, `not a number`);
    expect(storedCursor(`support`)).toBe(0);
    window.localStorage.setItem(`intentic.visitor-chat.support.cursor`, `-5`);
    expect(storedCursor(`support`)).toBe(0);
});

test(`a browser that refuses storage still chats: it just gets a fresh thread each time`, () => {
    jest.spyOn(Storage.prototype, `getItem`).mockImplementation(() => {
        throw new Error(`SecurityError`);
    });
    jest.spyOn(Storage.prototype, `setItem`).mockImplementation(() => {
        throw new Error(`SecurityError`);
    });
    expect(visitorConversationId(`support`)).toMatch(/^[0-9a-f-]{36}$/);
    expect(storedDisplayName(`support`)).toBeUndefined();
});
