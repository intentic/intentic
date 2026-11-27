import { extensionIdOf } from "@intentic/extension-manifest";
import {
    EXTENSION_EVENTS_HEARTBEAT_MS,
    type ExtensionSleepBoot,
    type ExtensionSleepHeard,
    type ExtensionSleepFrame,
    ExtensionSleepReadySchema,
    ExtensionWakeUrlAskSchema,
    WAKE_DOOR_PARAM,
} from "@intentic/sandbox-contract/extension-protocol";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AppEnv } from "../../app-env.js";
import type { InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { wakeRoutePath } from "../../system/sleep/wake-doors.js";
import { sleepHeardFor } from "./sleep-watch-cards.js";
import { answerSleep, sleepBootFacts, watchSleep } from "./extension-sleep.js";
import { bodyOf } from "./own-doors.js";

// (2026-11-27) HOSTED SLEEP'S FIVE DOORS for an extension's own code (`api.sleep`, the contract's extension-protocol.ts):
// the public URL of one of its `wakes` routes, what this boot follows, the before-sleep watch it answers ready on, and
// what the platform heard for its connections while the sandbox slept.
// Reached by every extension token undeclared in `permissions.daemon` (extension-manifest's EXTENSION_OWN_ROUTES); each
// resolves the caller from its token again and answers only about that extension.

type OwnCaller = (c: Context<AppEnv>) => Promise<InstalledExtension | Response>;

// The path a wake URL names for the caller, or why it names none.
const wakePathOf = (extension: InstalledExtension, route: string, automationId: string | undefined): { readonly path: string } | { readonly error: string } => {
    const declared = (extension.manifest.contributes?.publicRoutes ?? []).find((each) => each.path === route && each.wakes === true);
    if (declared === undefined) {
        return { error: `extension "${extension.id}" declares no public route "${route}" with \`wakes: true\`` };
    }
    if (declared.automation === true && automationId === undefined) {
        return { error: `the route "${route}" is an automation's: name the automation it is for` };
    }
    if (declared.automation !== true && automationId !== undefined) {
        return { error: `the route "${route}" is no automation's: name none` };
    }
    return { path: wakeRoutePath(extension.id, route, automationId) };
};

export const createExtensionSleepDoors = (services: Services, ownCaller: OwnCaller) => ({
    // The full public URL of one of its own `wakes` routes, its wake secret minted once and kept with the sandbox's other
    // door credentials (door-tokens.ts `wake`), so the same URL answers every ask and survives every restart.
    wakeUrl: async (c: Context<AppEnv>): Promise<Response> => {
        const extension = await ownCaller(c);
        if (extension instanceof Response) {
            return extension;
        }
        const asked = await bodyOf(c, ExtensionWakeUrlAskSchema);
        if (!asked.success) {
            return c.json({ error: "a wake URL is asked for { route, automationId? }" }, 400);
        }
        const named = wakePathOf(extension, asked.data.route, asked.data.automationId);
        if ("error" in named) {
            return c.json({ error: named.error }, 400);
        }
        const base = services.config.sandbox.publicUrl.replace(/\/+$/u, "");
        if (base === "") {
            return c.json({ error: "this sandbox has no public address to hand a wake URL out at" }, 409);
        }
        const secret = await services.doorTokens.ensure("wake", named.path);
        return c.json({ url: `${base}${named.path}?${WAKE_DOOR_PARAM}=${encodeURIComponent(secret)}` });
    },

    boot: async (c: Context<AppEnv>): Promise<Response> => {
        const extension = await ownCaller(c);
        if (extension instanceof Response) {
            return extension;
        }
        return c.json((await sleepBootFacts()) satisfies ExtensionSleepBoot);
    },

    // Held for as long as the extension keeps this answer open: a heartbeat on the events' beat, and a `sleep` frame right
    // before a hosted sleep (extension-sleep.ts).
    watch: async (c: Context<AppEnv>): Promise<Response> => {
        const extension = await ownCaller(c);
        if (extension instanceof Response) {
            return extension;
        }
        c.header("content-type", "application/x-ndjson");
        return stream(c, async (ndjson) => {
            // allow(silent-catch): the only failure is a watcher that went away, which the abort below also ends
            const tell = (frame: ExtensionSleepFrame): void => void ndjson.writeln(JSON.stringify(frame)).catch(() => undefined);
            const release = watchSleep(extension.id, tell);
            tell({ kind: "heartbeat" });
            const beating = setInterval(() => tell({ kind: "heartbeat" }), EXTENSION_EVENTS_HEARTBEAT_MS);
            try {
                await new Promise<void>((resolve) => ndjson.onAbort(resolve));
            } finally {
                clearInterval(beating);
                release();
            }
        });
    },

    // (2026-11-27) What the platform's sleep watch heard for the caller's own connections while the sandbox slept, handed
    // over once (sleep-watch-cards.ts); 502 when the platform could not say, which leaves it there for a retry.
    heard: async (c: Context<AppEnv>): Promise<Response> => {
        const extension = await ownCaller(c);
        if (extension instanceof Response) {
            return extension;
        }
        const heard = await sleepHeardFor(services, extension.id);
        return "error" in heard ? c.json({ error: heard.error }, 502) : c.json(heard satisfies ExtensionSleepHeard);
    },

    ready: async (c: Context<AppEnv>): Promise<Response> => {
        const extension = await ownCaller(c);
        if (extension instanceof Response) {
            return extension;
        }
        const asked = await bodyOf(c, ExtensionSleepReadySchema);
        if (!asked.success) {
            return c.json({ error: "ready names the sleep it answers: { id }" }, 400);
        }
        if (!answerSleep(extension.id, asked.data.id)) {
            services.logger.info({ extension: extensionIdOf(extension.manifest) }, "extension sleep: a ready came for a sleep it was not told, or one already past");
        }
        return c.json({ ok: true });
    },
});
