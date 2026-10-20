import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { Presented } from "../peers/enrollment.js";
import { webextRawRoutes } from "./webext.routes.js";

const TOKEN = "iwx_chrome";
const TOKENS = new Map<string, Presented>([[TOKEN, { kind: "enrolled", id: "chrome", card: "chrome" }]]);

test("POST /system/webext/grants-changed refreshes the browser and rechecks needs", async () => {
    const refreshed: string[] = [];
    let rechecked = 0;
    const app = new Hono();
    app.post(
        "/system/webext/grants-changed",
        webextRawRoutes({
            webexts: unstubbed("webexts", { verify: async (token: string) => TOKENS.get(token) ?? { kind: "unknown" } }),
            webextHub: unstubbed("webextHub", { refresh: async (id) => void refreshed.push(id) }),
            needs: unstubbed("needs", { recheck: async () => void (rechecked += 1) }),
            workspace: unstubbed("workspace", {}),
            capabilities: unstubbed("capabilities", { list: async () => [] }),
            logger: unstubbed("logger", { info: () => undefined }),
            secretTickets: unstubbed("secretTickets", {}),
        })["POST /system/webext/grants-changed"],
    );
    const response = await app.request("/system/webext/grants-changed", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    expect(refreshed).toEqual(["chrome"]);
    expect(rechecked).toBe(1);
});
