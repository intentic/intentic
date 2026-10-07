import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { createAccessRoutes } from "./access.routes.js";
import { createMediaTickets } from "./tokens/media-tickets.js";
import { createWsTickets } from "./tokens/ws-tickets.js";

const FILM = join(WORKSPACE_ROOT, "film.mp4");

// Signing every browser out ends what every session minted, not only the sessions: a media or download ticket lives for
// hours and would otherwise keep fetching the file it names.
test("signing every browser out drops every outstanding ws and media ticket", async () => {
    const services = { auth: undefined, wsTickets: createWsTickets(), mediaTickets: createMediaTickets() };
    const ws = services.wsTickets.mint({ email: "ada@example.com", role: "owner" });
    const media = services.mediaTickets.mint(FILM, undefined, "ada@example.com").ticket;
    const bundle = services.mediaTickets.mint("bundle:export.tar.gz", undefined, "ada@example.com").ticket;
    const app = new Hono<AppEnv>().post("/system/sessions/revoke", createAccessRoutes(services).revokeSessions);

    expect((await app.request("/system/sessions/revoke", { method: "POST" })).status).toBe(200);
    expect(services.wsTickets.redeem(ws)).toBeUndefined();
    expect(services.mediaTickets.valid(media, FILM)).toBe(false);
    expect(services.mediaTickets.valid(bundle, "bundle:export.tar.gz")).toBe(false);
});
