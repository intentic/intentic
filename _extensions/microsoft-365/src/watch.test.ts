import { Graph } from "./graph.js";
import { account, httpQueue } from "./testing.js";
import { deltaMail } from "./watch.js";

test("the first poll records where the inbox stands across every page and wakes nobody", async () => {
    const initial = httpQueue([
        { body: { value: [{ id: "old" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2" } },
        { body: { value: [{ id: "older" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/cursor" } },
    ]);
    const messages: string[] = [];
    expect(
        await deltaMail(new Graph(account, async () => "token", initial.http), undefined, async (m) => {
            messages.push(m.id);
        }),
    ).toBe("https://graph.microsoft.com/v1.0/cursor");
    expect(messages).toEqual([]);
    expect(new URL(initial.calls[0]!.url).searchParams.get("changeType")).toBe("created");
});

test("a later poll dispatches new mail, skips removals, and answers the next cursor", async () => {
    const later = httpQueue([
        {
            body: {
                value: [{ id: "new" }, { id: "gone", "@removed": { reason: "deleted" } }],
                "@odata.deltaLink": "https://graph.microsoft.com/v1.0/next",
            },
        },
    ]);
    const messages: string[] = [];
    expect(
        await deltaMail(new Graph(account, async () => "token", later.http), "https://graph.microsoft.com/v1.0/cursor", async (m) => {
            messages.push(m.id);
        }),
    ).toBe("https://graph.microsoft.com/v1.0/next");
    expect(messages).toEqual(["new"]);
});

test("a failed dispatch never hands back the next cursor, so the batch is delivered again", async () => {
    const { http } = httpQueue([{ body: { value: [{ id: "new" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/next" } }]);
    await expect(
        deltaMail(new Graph(account, async () => "token", http), "/me/mailFolders/inbox/messages/delta", async () => {
            throw new Error("daemon refused");
        }),
    ).rejects.toThrow("daemon refused");
});
