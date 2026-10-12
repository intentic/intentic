import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { call, googleError, retryDelay } from "./request.js";
import type { Connection } from "./accounts.js";
import type { Session } from "./session.js";

describe("retryDelay", () => {
    it("backs off exponentially when Google says nothing", () => {
        expect(retryDelay(1, null)).toBe(500);
        expect(retryDelay(2, null)).toBe(1000);
        expect(retryDelay(3, null)).toBe(2000);
    });

    it("obeys Retry-After, which is authoritative when a quota refusal carries one", () => {
        expect(retryDelay(1, "5")).toBe(5000);
    });

    // A server that answers Retry-After: 3600 must not park a CLI command for an hour.
    it("caps a declared wait, and ignores a nonsense one", () => {
        expect(retryDelay(1, "3600")).toBe(30_000);
        expect(retryDelay(2, "soon")).toBe(1000);
    });

    it("reads a Retry-After date against the clock", () => {
        const date = "Wed, 21 Oct 2026 07:28:00 GMT";
        expect(retryDelay(2, date, Date.parse(date) - 5_000)).toBe(5000);
        expect(retryDelay(2, date, Date.parse(date) + 5_000)).toBe(0);
    });
});

describe("googleError", () => {
    const at = (service: string): string => `https://${service}.googleapis.com/v1/whatever`;

    /* A disabled API needs a console instruction, not Google's raw error. */
    it("turns a disabled API into the instruction that enables it", () => {
        const error = googleError(403, at("gmail"), {
            error: { message: "Gmail API has not been used in project 12345 before or it is disabled." },
        });
        expect(error.message).toContain("console.cloud.google.com");
        expect(error.message).toContain("Gmail API");
    });

    it("explains an insufficient-scope refusal as a consent that was too narrow", () => {
        const error = googleError(403, at("calendar"), { error: { message: "Request had insufficient authentication scopes." } });
        expect(error.message).toMatch(/approved for narrower scopes/);
        expect(error.message).toMatch(/domain-wide delegation/);
    });

    it("suggests the two things a 404 actually means", () => {
        expect(googleError(404, at("drive"), { error: { message: "File not found: abc." } }).message).toMatch(
            /check the id, and that this account can actually see it|see that item/,
        );
    });

    it("says a rate limit is a rate limit", () => {
        expect(googleError(429, at("gmail"), { error: { message: "User-rate limit exceeded." } }).message).toMatch(/rate-limiting this account/);
    });

    it("relays anything else as Google phrased it, and keeps the status", () => {
        const error = googleError(400, at("sheets"), { error: { message: "Unable to parse range: Sheet9!A1" } });
        expect(error.message).toBe("Unable to parse range: Sheet9!A1");
        expect(error.status).toBe(400);
    });

    it("still says something when the body is not the shape Google documents", () => {
        expect(googleError(502, at("drive"), "<html>bad gateway</html>").message).toBe("HTTP 502");
    });
});

describe("call", () => {
    afterEach(() => {
        unstubAllGlobals();
    });

    const connection: Connection = { name: "work", email: "me@example.com", access: "read", mode: "user", credential: undefined, problem: undefined };
    const session = (): Session & { readonly refreshes: () => number } => {
        let refreshes = 0;
        return {
            connection,
            token: async () => "first",
            refresh: async () => {
                refreshes += 1;
                return "second";
            },
            refreshes: () => refreshes,
        };
    };

    // The disabled-API hint needs Google's whole sentence, which sits past any short excerpt of its error body.
    it("reads a refusal's whole body, so a long Google error still turns into its instruction", async () => {
        const details = Array.from({ length: 20 }, (_, index) => ({ "@type": "type.googleapis.com/google.rpc.Help", index }));
        stubGlobal("fetch", async () =>
            Response.json({ error: { code: 403, details, message: "Gmail API has not been used in project 12345 before or it is disabled." } }, { status: 403 }),
        );
        await expect(call(session(), { url: "https://gmail.googleapis.com/gmail/v1/users/me/labels" })).rejects.toThrow(/Enable Gmail API/);
    });

    it("retries a 401 once with a fresh token", async () => {
        const seen: string[] = [];
        stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
            const authorization = new Headers(init?.headers).get("authorization") ?? "";
            seen.push(authorization);
            return authorization === "Bearer first" ? new Response("", { status: 401 }) : Response.json({ labels: [] });
        });
        const own = session();
        expect(await call<{ labels: unknown[] }>(own, { url: "https://gmail.googleapis.com/gmail/v1/users/me/labels" })).toEqual({ labels: [] });
        expect(seen).toEqual(["Bearer first", "Bearer second"]);
        expect(own.refreshes()).toBe(1);
    });

    it("ends the call when the caller aborts, instead of waiting on a stalled connection", async () => {
        stubGlobal(
            "fetch",
            async (_url: string, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    // As fetch does: a signal already aborted rejects at once, a later abort when it fires.
                    if (init?.signal?.aborted === true) {
                        reject(init.signal.reason);
                    }
                    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
                }),
        );
        const controller = new AbortController();
        const pending = call(session(), { url: "https://www.googleapis.com/drive/v3/files", query: { q: "secret words" }, signal: controller.signal });
        controller.abort();
        const failure = await pending.catch((error: unknown) => error);
        expect(String(failure)).toContain("Google GET https://www.googleapis.com/drive/v3/files was aborted");
        expect(String(failure)).not.toContain("secret words");
    });
});
