import type { TranslatorAuthFile } from "../../../usage/translator-usage.js";
import { accountPrefix, createAccountPinning } from "../translator-prefixes.js";

// Each translator credential is given the prefix that pins a request to it, and only where its file lacks that prefix:
// the prefix is the file name's, so it is the same on every boot, and a credential already carrying it costs nothing.

const MANAGEMENT = "http://127.0.0.1:8789/v0/management";

// A translator answering every PATCH with what `answer` says, recording each body it was sent.
const translator = (answer: (name: string) => Response = () => Response.json({ status: "ok" })) => {
    const patched: { name: string; prefix: string }[] = [];
    // SAFETY: the client calls fetch with a URL and an init alone, which is all this stand-in answers.
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(`${MANAGEMENT}/auth-files/fields`);
        expect(init?.method).toBe("PATCH");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local");
        // SAFETY: every PATCH this client sends is a JSON string of `{ name, prefix }`.
        const body = JSON.parse(String(init?.body)) as { name: string; prefix: string };
        patched.push(body);
        return answer(body.name);
    }) as typeof fetch;
    return { patched, fetchFn };
};

const pinningOver = (files: readonly TranslatorAuthFile[], fetchFn: typeof fetch, now: () => number = Date.now) =>
    createAccountPinning({ managementUrl: MANAGEMENT, auth: { authorization: "Bearer local" }, files: async () => files, fetchFn, now });

test("a credential's prefix is its file name's, the same on every boot", () => {
    expect(accountPrefix("gemini-alice@example.com.json")).toBe("ic-4d854be305");
    expect(accountPrefix("a.json")).toBe("ic-d277c45cdc");
    expect(accountPrefix("a.json")).toBe(accountPrefix("a.json"));
    expect(accountPrefix("b.json")).not.toBe(accountPrefix("a.json"));
});

test("only a credential whose file lacks its prefix, or carries another, is given it", async () => {
    const { patched, fetchFn } = translator();
    const pinning = pinningOver(
        [
            { name: "a.json", provider: "antigravity", prefix: accountPrefix("a.json") },
            { name: "b.json", provider: "antigravity" },
            { name: "c.json", provider: "codex", prefix: "team" },
        ],
        fetchFn,
    );

    const report = await pinning.pin();

    expect(patched).toStrictEqual([
        { name: "b.json", prefix: accountPrefix("b.json") },
        { name: "c.json", prefix: accountPrefix("c.json") },
    ]);
    expect(report).toStrictEqual({ pinned: ["b.json", "c.json"], failed: [] });
    expect(["a.json", "b.json", "c.json"].map((name) => pinning.prefixOf(name))).toStrictEqual([
        accountPrefix("a.json"),
        accountPrefix("b.json"),
        accountPrefix("c.json"),
    ]);
});

test("a credential the proxy refused stays unpinned, and its failure is said once until it is pinned", async () => {
    let refusing = true;
    const { patched, fetchFn } = translator(() => (refusing ? Response.json({ error: "auth file not found" }, { status: 404 }) : Response.json({ status: "ok" })));
    const pinning = pinningOver([{ name: "b.json", provider: "antigravity" }], fetchFn);

    const first = await pinning.pin();
    expect(first.pinned).toStrictEqual([]);
    expect(first.failed).toStrictEqual([{ name: "b.json", reason: expect.stringContaining("404") }]);
    expect(pinning.prefixOf("b.json")).toBeUndefined();

    // Asked again on the next round, but not said again.
    expect(await pinning.pin()).toStrictEqual({ pinned: [], failed: [] });
    expect(patched).toHaveLength(2);

    refusing = false;
    expect(await pinning.pin()).toStrictEqual({ pinned: ["b.json"], failed: [] });
    expect(pinning.prefixOf("b.json")).toBe(accountPrefix("b.json"));
});

test("a round younger than the age asked for is not run again", async () => {
    let clock = 1_000;
    const { patched, fetchFn } = translator(() => Response.json({ error: "busy" }, { status: 503 }));
    const pinning = pinningOver([{ name: "b.json", provider: "antigravity" }], fetchFn, () => clock);

    await pinning.pin({ maxAgeMs: 60_000 });
    clock += 30_000;
    await pinning.pin({ maxAgeMs: 60_000 });
    expect(patched).toHaveLength(1);

    clock += 31_000;
    await pinning.pin({ maxAgeMs: 60_000 });
    expect(patched).toHaveLength(2);
});

test("a credential no longer on disk is no longer pinned", async () => {
    const files: TranslatorAuthFile[] = [{ name: "a.json", provider: "antigravity", prefix: accountPrefix("a.json") }];
    const pinning = createAccountPinning({
        managementUrl: MANAGEMENT,
        auth: {},
        files: async () => files,
        fetchFn: translator().fetchFn,
    });
    await pinning.pin();
    expect(pinning.prefixOf("a.json")).toBe(accountPrefix("a.json"));

    files.pop();
    await pinning.pin();
    expect(pinning.prefixOf("a.json")).toBeUndefined();
});
