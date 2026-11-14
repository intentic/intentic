import type { JsonValue } from "@intentic/base/json";
import { number, object, string, type ZodType } from "zod";
import { keptList } from "./memory.js";

// What a kit remembers between calls: the newest few, the rest handed back so their pages can be let go.

let stored: JsonValue | undefined;
const memory = <Entry extends JsonValue>(entry: ZodType<Entry>, keep: number) =>
    keptList(
        async () => stored,
        async (value) => {
            stored = value;
        },
        entry,
        keep,
    );

beforeEach(() => {
    stored = undefined;
});

test("an entry past the newest few falls off the end and is handed back, so its tab can be let go", async () => {
    const chats = memory(object({ chat: string(), tabId: number() }), 2);
    const same = (chat: string) => (other: { chat: string }) => other.chat === chat;
    expect(await chats.put({ chat: "a", tabId: 1 }, same("a"))).toEqual([]);
    expect(await chats.put({ chat: "b", tabId: 2 }, same("b"))).toEqual([]);
    // Replacing an entry is not evicting one.
    expect(await chats.put({ chat: "a", tabId: 1 }, same("a"))).toEqual([]);
    expect(await chats.put({ chat: "c", tabId: 3 }, same("c"))).toEqual([{ chat: "b", tabId: 2 }]);
    expect(await chats.list()).toEqual([
        { chat: "c", tabId: 3 },
        { chat: "a", tabId: 1 },
    ]);
});

test("an entry an earlier build kept in another form is dropped, and a value that is no list at all reads as none", async () => {
    const chats = memory(object({ chat: string(), tabId: number() }), 5);
    stored = [{ chat: "a", tabId: 1 }, { chat: "b" }, "c"];
    expect(await chats.list()).toEqual([{ chat: "a", tabId: 1 }]);
    stored = { chat: "a", tabId: 1 };
    expect(await chats.list()).toEqual([]);
});
