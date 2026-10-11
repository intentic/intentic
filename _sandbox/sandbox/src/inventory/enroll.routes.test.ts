import { CONNECT_TOKEN_HEADER, EnrollCodeAnswerSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { testConfig } from "../testing.js";
import { pairings } from "../peers/enrollment.js";
import { redeemCodes } from "../peers/redeem-codes.js";
import { createEnrollCodeRoute, createEnrollRoute } from "./enroll.routes.js";

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
const enrollOnce = () => {
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
        config: { ...testConfig, connectToken: "ct", sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.dev" } },
        enrollTokens: pairings(),
        redeemCodes: redeemCodes(),
    });
    const app = new Hono<AppEnv>()
        .post("/enroll", createEnrollRoute(services, async (_services, input) => void enrolled.push(input.name)))
        .post("/system/enroll/code", createEnrollCodeRoute(services));
    const enroll = async (token: string): Promise<number> =>
        (
            await app.request("/enroll", {
                method: "POST",
                headers: { "content-type": "application/json", [CONNECT_TOKEN_HEADER]: token },
                body: JSON.stringify({ name: "web", user: "root", address: "203.0.113.4", sshKey: "ssh-ed25519 AAAA" }),
            })
        ).status;
    return { services, app, enroll, enrolled };
};

test("a single-use enroll token admits one enrollment and is refused after; the connect token keeps working", async () => {
    const { services, enroll, enrolled } = enrollOnce();
    const { token } = services.enrollTokens.mint({ hostName: "web" });
    expect(await enroll(token)).toBe(200);
    expect(await enroll(token)).toBe(401);
    expect(await enroll("ct")).toBe(200);
    expect(enrolled).toEqual(["web", "web"]);
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
