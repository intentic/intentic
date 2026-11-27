import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import type { GatewayCtx } from "@intentic/connector-runtime";
import { z } from "zod";
import { EVENTS_ROUTE, socketModeAsleepNotice } from "./app-manifest.js";

// (2026-11-27) A Slack app set up before HTTP mode, on a sandbox the platform hosts, keeps Socket Mode until its card
// holds the app's signing secret (mode.ts), so it goes on answering while the sandbox is awake; its owner is told so
// once, with the way to have it answer while the sandbox sleeps too.

// The apps already told, on a sandbox the platform hosts, that Socket Mode only answers while it is awake: digests of
// their app-level tokens, so it is said once per app rather than at every wake.
export const TOLD_FILE = "socket-mode-told.json";
const ToldSchema = z.array(z.string());

const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 16);

// Says once, through the listener's failure report (the Slack automations' last run, and Activity), that an app on
// Socket Mode only answers while this hosted sandbox is awake, with the one step that switches it and a link that
// creates an app already switched.
export const tellSocketModeAsleep = async (ctx: GatewayCtx, appToken: string): Promise<void> => {
    const file = join(ctx.api.stateDir, TOLD_FILE);
    // allow(silent-catch): no file yet is nobody told yet
    const told = parseJsonWith(await readFile(file, "utf8").catch(() => "[]"), ToldSchema) ?? [];
    const digest = digestOf(appToken);
    if (told.includes(digest)) {
        return;
    }
    const requestUrl = await ctx.api.sleep.wakeUrl(EVENTS_ROUTE);
    await ctx.daemon.failure(socketModeAsleepNotice(requestUrl));
    await writeFile(file, JSON.stringify([...told, digest]));
};
