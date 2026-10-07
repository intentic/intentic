import { CONNECT_TOKEN_HEADER } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { testConfig } from "../testing.js";
import { createEnrollRoute } from "./enroll.routes.js";

// The connect-host script's door: the connect token alone admits it. A body this route cannot parse answers 400 only
// once the gate let the caller through, so 401 against 400 tells which side of the gate a request landed on without
// reaching the desired-state repo.
const enrollWith = (connectToken: string) => {
    const services = unstubbed<Services>("services", {
        auth: unstubbed<NonNullable<Services["auth"]>>("auth", {}),
        config: { ...testConfig, connectToken },
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
