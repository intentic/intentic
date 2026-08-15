import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultConnection } from "./connection.js";
import { encodeVaultPath, isVaultError, relaxTlsFor, vaultCall, vaultRead, vaultWalk, vaultWrite } from "./rest.js";

const vault: VaultConnection = {
    name: "obsidian",
    url: "https://host.docker.internal:27124",
    apiKey: "key",
    write: true,
    folder: "",
    problem: undefined,
};

const answers = (routes: Record<string, { status?: number; body: string }>): typeof fetch =>
    vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const route = routes[url.slice(vault.url.length)];
        if (route === undefined) {
            throw new Error(`unrouted ${url}`);
        }
        return new Response(route.body, { status: route.status ?? 200 });
    }) as unknown as typeof fetch;

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("encodeVaultPath", () => {
    it("encodes each segment but keeps the separators", () => {
        expect(encodeVaultPath("Daily notes/2026-08-15.md")).toBe("Daily%20notes/2026-08-15.md");
        expect(encodeVaultPath("/Q&A/what is it?.md")).toBe("Q%26A/what%20is%20it%3F.md");
    });
});

describe("relaxTlsFor", () => {
    it("switches verification off for https, and leaves http alone", () => {
        const https: Record<string, string | undefined> = {};
        relaxTlsFor("https://host.docker.internal:27124", https);
        expect(https["NODE_TLS_REJECT_UNAUTHORIZED"]).toBe("0");

        const http: Record<string, string | undefined> = {};
        relaxTlsFor("http://127.0.0.1:27123", http);
        expect(http["NODE_TLS_REJECT_UNAUTHORIZED"]).toBeUndefined();
    });
});

describe("vaultCall", () => {
    it("sends the API key as a bearer token", async () => {
        const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);
        await vaultCall(vault, { method: "GET", path: "/" });
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: "Bearer key" }) });
    });

    it("turns a closed Obsidian into the sentence that says so", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("fetch failed");
            }),
        );
        const result = await vaultCall(vault, { method: "GET", path: "/" });
        expect(isVaultError(result) && result.error).toContain("Obsidian has to be OPEN");
    });

    it("names the refused key rather than the status code", async () => {
        vi.stubGlobal("fetch", answers({ "/vault/x.md": { status: 401, body: "" } }));
        const result = await vaultRead(vault, "x.md");
        expect(isVaultError(result) && result.error).toContain("API key was refused");
    });

    it("reports a missing note as a missing note, with its status", async () => {
        vi.stubGlobal("fetch", answers({ "/vault/gone.md": { status: 404, body: "" } }));
        const result = await vaultRead(vault, "gone.md");
        expect(isVaultError(result) && result.status).toBe(404);
    });

    it("refuses to dial at all when the card is half-filled", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const result = await vaultWrite({ ...vault, problem: "no API key on the card" }, "x.md", "hi");
        expect(isVaultError(result) && result.error).toBe("no API key on the card");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("vaultWalk", () => {
    it("walks into subfolders and returns every markdown file, sorted", async () => {
        vi.stubGlobal(
            "fetch",
            answers({
                "/vault/": { body: JSON.stringify({ files: ["Inbox/", "readme.md", "cover.png"] }) },
                "/vault/Inbox/": { body: JSON.stringify({ files: ["b.md", "a.md"] }) },
            }),
        );
        expect(await vaultWalk(vault)).toEqual(["Inbox/a.md", "Inbox/b.md", "readme.md"]);
    });

    it("walks past the directories a vault keeps that hold no notes", async () => {
        vi.stubGlobal(
            "fetch",
            answers({
                "/vault/": { body: JSON.stringify({ files: [".obsidian/", ".trash/", "note.md"] }) },
            }),
        );
        expect(await vaultWalk(vault)).toEqual(["note.md"]);
    });

    it("fails the walk when the folder it was pointed at fails, not when a nested one does", async () => {
        vi.stubGlobal(
            "fetch",
            answers({
                "/vault/": { body: JSON.stringify({ files: ["locked/", "note.md"] }) },
                "/vault/locked/": { status: 403, body: "" },
            }),
        );
        expect(await vaultWalk(vault)).toEqual(["note.md"]);

        vi.stubGlobal("fetch", answers({ "/vault/": { status: 403, body: "" } }));
        expect(isVaultError(await vaultWalk(vault))).toBe(true);
    });
});
