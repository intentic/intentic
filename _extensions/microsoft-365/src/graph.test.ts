import { Graph } from "./graph.js";
import { account, headersOf, httpQueue } from "./testing.js";

test("pagination follows nextLink only until the limit is in hand", async () => {
    const { http, calls } = httpQueue([
        { body: { value: [{ id: "one" }, { id: "two" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?skip=2" } },
        { body: { value: [{ id: "three" }, { id: "four" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?skip=4" } },
    ]);
    const graph = new Graph(account, async () => "access", http);
    expect(await graph.list("/me/messages", 3)).toEqual([{ id: "one" }, { id: "two" }, { id: "three" }]);
    expect(calls).toHaveLength(2);
    expect(headersOf(calls[0]).get("authorization")).toBe("Bearer access");
});

test("a nextLink outside the card's cloud is refused before the bearer goes out", async () => {
    const { http, calls } = httpQueue([{ body: { value: [], "@odata.nextLink": "https://evil.example/v1.0/me" } }]);
    await expect(new Graph(account, async () => "secret", http).list("/me/messages", 50)).rejects.toThrow("outside this card's cloud");
    expect(calls).toHaveLength(1);
});

test("a national cloud's card talks to its own Graph", async () => {
    const { http, calls } = httpQueue([{ body: { id: "me" } }]);
    await new Graph({ ...account, authority: "login.microsoftonline.us" }, async () => "t", http).call("/me");
    expect(new URL(calls[0]!.url).origin).toBe("https://graph.microsoft.us");
});

test("read only refuses every write before a token is minted or a request sent", async () => {
    const { http, calls } = httpQueue([]);
    const graph = new Graph(
        { ...account, access: "read" },
        async () => {
            throw new Error("must not mint");
        },
        http,
    );
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
        await expect(graph.call("/me/messages", { method, body: {} })).rejects.toThrow("read-only");
    }
    expect(calls).toEqual([]);
});

test("an accepted write with no body answers nothing, and a refusal says only its status", async () => {
    expect(
        await new Graph(account, async () => "a", httpQueue([{ status: 202 }]).http).call("/me/sendMail", { method: "POST", body: {} }),
    ).toBeUndefined();
    const refused = httpQueue([{ status: 403, body: { error: { message: "quoted mail content" } } }]);
    await expect(new Graph(account, async () => "a", refused.http).call("/me/messages/x")).rejects.toThrow(
        "(403: this account or its permissions do not reach that)",
    );
});
