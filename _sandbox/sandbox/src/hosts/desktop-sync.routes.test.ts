import { PairingAnswerSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { pairings } from "../peers/enrollment.js";
import type { SyncMode } from "../peers/desktop-sync.js";
import { redeemCodes } from "../peers/redeem-codes.js";
import { createSyncRoutes } from "./desktop-sync.routes.js";

// POST /system/sync/pair: the token and mode as before, and beside them a short code that redeems for the token plus
// the folder and takeover the editor sent.
const syncPair = () => {
    const services = unstubbed<Services>("services", { auth: undefined, syncPairings: pairings<SyncMode>(), redeemCodes: redeemCodes() });
    const app = new Hono<AppEnv>().post("/system/sync/pair", createSyncRoutes(services).pair);
    const pair = async (query = "", body?: unknown) =>
        app.request(`/system/sync/pair${query}`, {
            method: "POST",
            ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
    return { services, pair };
};

test("a sync pairing minted with no body answers the token, its mode and a code for them", async () => {
    const { services, pair } = syncPair();
    const raw: unknown = await (await pair()).json();
    const answer = PairingAnswerSchema.parse(raw);
    expect(raw).toMatchObject({ mode: "sync", expiresIn: 600 });
    expect(services.syncPairings.peek(answer.token)).toBe("sync");
    expect(services.redeemCodes.redeem(answer.code)).toEqual({ kind: "sync", pairToken: answer.token, mode: "sync" });
});

test("the folder and takeover the editor sends, and mirror mode, ride the code", async () => {
    const { services, pair } = syncPair();
    const answer = PairingAnswerSchema.parse(await (await pair("?mode=mirror", { syncDir: "~/intentic/web", takeover: true })).json());
    expect(services.redeemCodes.redeem(answer.code)).toEqual({
        kind: "sync",
        pairToken: answer.token,
        mode: "mirror",
        syncDir: "~/intentic/web",
        takeover: true,
    });
});

test("a folder that could not ride one KEY=value line is refused, and nothing is minted", async () => {
    const { pair } = syncPair();
    expect((await pair("", { syncDir: "~/a\nPAIR_TOKEN=x" })).status).toBe(400);
});
