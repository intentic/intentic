import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { Presented } from "../../peers/enrollment.js";
import { hostKeyringRawRoutes } from "./host-keyring.routes.js";

const TOKEN = "ihost_rog";
const TOKENS = new Map<string, Presented>([[TOKEN, { kind: "enrolled", id: "rog", card: "rog" }]]);

const appWith = (refreshed: string[]): Hono => {
    const app = new Hono();
    app.post(
        "/system/hosts/keyring-changed",
        hostKeyringRawRoutes({
            hosts: unstubbed("hosts", { verify: async (token: string) => TOKENS.get(token) ?? { kind: "unknown" } }),
            keyringLink: unstubbed("keyringLink", { refresh: async (machine) => void refreshed.push(machine ?? "") }),
            logger: unstubbed("logger", { warn: () => undefined }),
        })["POST /system/hosts/keyring-changed"],
    );
    return app;
};

test("a connected computer's push reads that computer's keyring, and only that one", async () => {
    const refreshed: string[] = [];
    const response = await appWith(refreshed).request("/system/hosts/keyring-changed", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(202);
    expect(refreshed).toEqual(["rog"]);
});

test("a push without a machine's token reads nothing", async () => {
    const refreshed: string[] = [];
    const response = await appWith(refreshed).request("/system/hosts/keyring-changed", { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(refreshed).toEqual([]);
});
