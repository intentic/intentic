import { CONNECT_TOKEN_HEADER } from "@intentic/sandbox-contract/protocol/headers";
import { EnrollCodeAnswerSchema } from "@intentic/sandbox-contract/schemas/short-codes";
import type { EnrollHostInput } from "@intentic/sandbox-contract/schemas/inventory";
import { hostSshIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { testConfig } from "../env.config.testing.js";
import { pairings } from "../peers/enrollment.js";
import { type CodeGrant, createRedeemRoute, redeemCodes } from "../peers/redeem-codes.js";
import { createEnrollCodeRoute, createEnrollRoute, ENROLL_AFTER_REDEEM_MS } from "./enroll.routes.js";

// The connect-host script's door: the connect token alone admits it. A body this route cannot parse answers 400 only
// once the gate let the caller through, so 401 against 400 tells which side of the gate a request landed on without
// reaching the desired-state repo.
const enrollWith = (connectToken: string) => {
    const services = unstubbed<Services>("services", {
        auth: unstubbed<NonNullable<Services["auth"]>>("auth", {}),
        config: { ...testConfig, connectToken },
        enrollTokens: pairings(),
    });
    const app = new Hono<AppEnv>().post("/enroll", createEnrollRoute(services));
    return async (headers: Record<string, string>): Promise<number> =>
        (await app.request("/enroll", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" })).status;
};

test("a daemon with auth on and no connect token enrolls nobody, whatever the caller presents", async () => {
    const enroll = enrollWith("");
    expect(await enroll({})).toBe(401);
    expect(await enroll({ [CONNECT_TOKEN_HEADER]: "" })).toBe(401);
    expect(await enroll({ [CONNECT_TOKEN_HEADER]: "anything" })).toBe(401);
});

test("a configured connect token admits only itself", async () => {
    const enroll = enrollWith("ct");
    expect(await enroll({})).toBe(401);
    expect(await enroll({ [CONNECT_TOKEN_HEADER]: "wrong" })).toBe(401);
    expect(await enroll({ [CONNECT_TOKEN_HEADER]: "ct" })).toBe(400);
});

// The single-use enroll token behind a server-connect code: the same header, good for one enrollment, and the
// long-lived connect token still admitted beside it.
const enrollOnce = (
    options: {
        readonly enroll?: (input: EnrollHostInput) => Promise<void>;
        readonly publicUrl?: string;
        readonly ingressUrl?: string;
        readonly connectToken?: string;
    } = {},
) => {
    const enrolled: string[] = [];
    const services = unstubbed<Services>("services", {
        // Only the owner's bearer mints a server-connect code.
        auth: unstubbed<NonNullable<Services["auth"]>>("auth", {
            authorizeOwner: async (bearer: string) => {
                if (bearer !== "owner") {
                    throw new Error("not the owner");
                }
            },
        }),
        config: {
            ...testConfig,
            connectToken: options.connectToken ?? "ct",
            sandbox: { ...testConfig.sandbox, publicUrl: options.publicUrl ?? "https://sandbox-abc.example.dev" },
            ingress: { url: options.ingressUrl ?? "" },
        },
        enrollTokens: pairings(),
        redeemCodes: redeemCodes(),
    });
    const app = new Hono<AppEnv>()
        .post(
            "/enroll",
            createEnrollRoute(services, async (_services, input) => {
                await options.enroll?.(input);
                enrolled.push(input.name);
            }),
        )
        .post("/system/enroll/code", createEnrollCodeRoute(services))
        .post("/system/redeem/:code", createRedeemRoute({ codes: services.redeemCodes, sandboxUrl: () => services.config.sandbox.publicUrl }));
    const enroll = async (token: string, name = "web"): Promise<number> =>
        (
            await app.request("/enroll", {
                method: "POST",
                headers: { "content-type": "application/json", [CONNECT_TOKEN_HEADER]: token },
                body: JSON.stringify({ name, user: "root", address: "203.0.113.4", sshKey: "ssh-ed25519 AAAA" }),
            })
        ).status;
    // The owner's Show command: a server code minted for `hostName` (none: the server names itself), and its redemption
    // by the script it runs.
    const mintServerCode = async (hostName: string | null = "web"): Promise<string> => {
        const minted = await app.request("/system/enroll/code", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer owner" },
            body: JSON.stringify(hostName === null ? {} : { hostName }),
        });
        return EnrollCodeAnswerSchema.parse(await minted.json()).code;
    };
    const redeemServerCode = (code: string): Extract<CodeGrant, { kind: "server" }> => {
        const grant = services.redeemCodes.redeem(code);
        if (grant?.kind !== "server") {
            throw new Error("the code did not redeem for a server grant");
        }
        return grant;
    };
    const serverCode = async (hostName = "web") => redeemServerCode(await mintServerCode(hostName));
    // The script's redemption, over HTTP: the `KEY=value` answer read into a record.
    const redeemOverHttp = async (code: string, query = ""): Promise<Map<string, string>> => {
        const answer = await app.request(`/system/redeem/${code}${query}`, { method: "POST" });
        expect(answer.status).toBe(200);
        return new Map(
            (await answer.text())
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        );
    };
    return { services, app, enroll, enrolled, mintServerCode, redeemServerCode, serverCode, redeemOverHttp };
};

test("a single-use enroll token admits one enrollment and is refused after; the connect token keeps working", async () => {
    const { services, enroll, enrolled } = enrollOnce();
    const { token } = services.enrollTokens.mint({ hostName: "web" });
    expect(await enroll(token)).toBe(200);
    expect(await enroll(token)).toBe(401);
    expect(await enroll("ct")).toBe(200);
    expect(enrolled).toEqual(["web", "web"]);
});

test("a single-use enroll token admits one of several enrollments that present it together", async () => {
    // As slow as the real one, which writes desired-state/.env and commits deploy.config.ts before it answers.
    const { services, enroll, enrolled } = enrollOnce({ enroll: () => new Promise((resolve) => setTimeout(resolve, 20)) });
    const { token } = services.enrollTokens.mint({});
    const statuses = await Promise.all([enroll(token, "web"), enroll(token, "prod"), enroll(token, "db")]);
    expect(statuses.toSorted()).toEqual([200, 401, 401]);
    expect(enrolled).toHaveLength(1);
    expect(await enroll(token)).toBe(401);
});

test("a single-use enroll token minted for one server refuses to enroll another name, and still admits its own", async () => {
    const { enroll, enrolled, serverCode } = enrollOnce();
    const { connectToken } = await serverCode("web_1");
    expect(await enroll(connectToken, "prod")).toBe(403);
    expect(enrolled).toEqual([]);
    expect(await enroll(connectToken, "web_1")).toBe(200);
    expect(enrolled).toEqual(["web_1"]);
});

test("an enrollment that fails gives the single-use token back for a retry", async () => {
    let ready = false;
    const { services, enroll, enrolled } = enrollOnce({
        enroll: async () => {
            if (!ready) {
                throw new ORPCError("PRECONDITION_FAILED", { message: "DevOps is not active, activate it before enrolling a host." });
            }
        },
    });
    const { token } = services.enrollTokens.mint({ hostName: "web" });
    expect(await enroll(token)).toBe(412);
    ready = true;
    expect(await enroll(token)).toBe(200);
    expect(await enroll(token)).toBe(401);
    expect(enrolled).toEqual(["web"]);
});

test("a server code's enroll token lives an hour from the code's redemption, so a slow server run still enrolls", async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(start);
    try {
        const { enroll, mintServerCode, redeemServerCode } = enrollOnce();
        const code = await mintServerCode();
        // Redeemed three minutes after the owner showed the command, then Docker, a pasted Cloudflare token and the
        // image pull take well past what was left of the code's ten minutes.
        clock.mockReturnValue(start + 3 * 60_000);
        const { connectToken } = redeemServerCode(code);
        clock.mockReturnValue(start + 3 * 60_000 + ENROLL_AFTER_REDEEM_MS - 1);
        expect(await enroll(connectToken)).toBe(200);
    } finally {
        clock.mockRestore();
    }
});

test("a server code's enroll token still lapses: ten minutes from the mint unredeemed, an hour from the redemption", async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(start);
    try {
        const { services, enroll, serverCode } = enrollOnce();
        const unredeemed = services.enrollTokens.mint({ hostName: "web" }).token;
        const { connectToken } = await serverCode();
        clock.mockReturnValue(start + 10 * 60_000 + 1);
        expect(await enroll(unredeemed)).toBe(401);
        clock.mockReturnValue(start + ENROLL_AFTER_REDEEM_MS + 1);
        expect(await enroll(connectToken)).toBe(401);
    } finally {
        clock.mockRestore();
    }
});

test("a server code hands out the zone of an owner's own domain, never the zone of an address intentic provides", async () => {
    const edge = "https://ingress.sbx.intentic.dev";
    const provided = enrollOnce({ publicUrl: "https://sandbox-abc.sbx.intentic.dev", ingressUrl: edge });
    expect((await provided.serverCode()).zone).toBeUndefined();
    const own = enrollOnce({ publicUrl: "https://sandbox-abc.example.dev", ingressUrl: edge });
    expect((await own.serverCode()).zone).toBe("example.dev");
    // Attached with no edge at all: the address can only be the owner's.
    const attached = enrollOnce({ publicUrl: "https://sandbox-abc.example.dev" });
    expect((await attached.serverCode()).zone).toBe("example.dev");
});

test("a failed enrollment leaves the single-use token for a retry", async () => {
    const { services, app } = enrollOnce();
    const { token } = services.enrollTokens.mint({});
    const status = async (): Promise<number> =>
        (await app.request("/enroll", { method: "POST", headers: { "content-type": "application/json", [CONNECT_TOKEN_HEADER]: token }, body: "{}" }))
            .status;
    expect(await status()).toBe(400);
    expect(await status()).toBe(400);
});

test("POST /system/enroll/code answers a code that redeems for a single-use token /enroll accepts", async () => {
    const { services, app, enroll } = enrollOnce();
    const minted = await app.request("/system/enroll/code", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer owner" },
        body: JSON.stringify({ hostName: "web" }),
    });
    expect(minted.status).toBe(200);
    const answer = EnrollCodeAnswerSchema.parse(await minted.json());
    expect(answer.expiresIn).toBe(600);
    const grant = services.redeemCodes.redeem(answer.code);
    expect(grant).toMatchObject({ kind: "server", hostName: "web" });
    const token = grant?.kind === "server" ? grant.connectToken : "";
    expect(token).not.toBe("ct");
    expect(await enroll(token)).toBe(200);
    expect(await enroll(token)).toBe(401);
});

// A server is named for a digest of the token it connects with: its tunnel, its ssh-<id> DNS record, and on Windows its
// container and the volume holding what it deployed. Each code's token is a new single-use one, so the code answers the
// id instead, digested from the long-lived connect token as it was before codes, or every run would make a new server.
test("every code for one server answers the same HOST_ID, the one it had when commands carried the connect token", async () => {
    const { mintServerCode, redeemOverHttp } = enrollOnce();
    const first = await redeemOverHttp(await mintServerCode("web_1"));
    const again = await redeemOverHttp(await mintServerCode("web_1"));
    expect(first.get("CONNECT_TOKEN")).not.toBe(again.get("CONNECT_TOKEN"));
    expect(first.get("HOST_ID")).toBe(hostSshIdFromToken("ct", "web_1"));
    expect(again.get("HOST_ID")).toBe(first.get("HOST_ID"));
    expect(first.get("HOST_ID")).toMatch(/^[0-9a-f]{12}$/);
    expect(first.get("HOST_NAME")).toBe("web_1");
    // Another server of the same sandbox is another id.
    expect((await redeemOverHttp(await mintServerCode("db"))).get("HOST_ID")).toBe(hostSshIdFromToken("ct", "db"));
    // Nothing the long-lived token could be read back from.
    expect([...first.values()]).not.toContain("ct");
});

test("a code minted without a name answers the HOST_ID of the name the server's script asks under, and holds it to it", async () => {
    const { mintServerCode, redeemOverHttp, enroll, enrolled } = enrollOnce();
    const asked = await redeemOverHttp(await mintServerCode(null), "?name=laptop");
    expect(asked.get("HOST_NAME")).toBe("laptop");
    expect(asked.get("HOST_ID")).toBe(hostSshIdFromToken("ct", "laptop"));
    expect(await enroll(asked.get("CONNECT_TOKEN") ?? "", "laptop")).toBe(200);
    expect(enrolled).toEqual(["laptop"]);
    // An older script asks under no name: the answer it always had.
    const unasked = await redeemOverHttp(await mintServerCode(null));
    expect(unasked.has("HOST_NAME") || unasked.has("HOST_ID")).toBe(false);
});

test("a sandbox without a long-lived connect token answers no HOST_ID, and the server digests one as it did", async () => {
    const { mintServerCode, redeemOverHttp } = enrollOnce({ connectToken: "" });
    const named = await redeemOverHttp(await mintServerCode("web_1"), "?name=laptop");
    expect(named.get("HOST_ID")).toBeUndefined();
    expect(named.get("HOST_NAME")).toBe("web_1");
    const unnamed = await redeemOverHttp(await mintServerCode(null), "?name=laptop");
    expect(unnamed.get("HOST_ID")).toBeUndefined();
    expect(unnamed.get("HOST_NAME")).toBeUndefined();
});

test("POST /system/enroll/code refuses a server name deploy.config.ts could not bind", async () => {
    const { app } = enrollOnce();
    const minted = await app.request("/system/enroll/code", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer owner" },
        body: JSON.stringify({ hostName: "web server" }),
    });
    expect(minted.status).toBe(400);
});

test("POST /system/enroll/code is the owner's alone", async () => {
    const { app } = enrollOnce();
    const status = async (headers: Record<string, string>): Promise<number> => (await app.request("/system/enroll/code", { method: "POST", headers })).status;
    expect(await status({})).toBe(401);
    expect(await status({ authorization: "Bearer someone" })).toBe(401);
    expect(await status({ authorization: "Bearer owner" })).toBe(200);
});
