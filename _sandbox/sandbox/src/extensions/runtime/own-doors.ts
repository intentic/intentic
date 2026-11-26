import { declaredReachOf, extensionIdOf } from "@intentic/extension-manifest";
import {
    EXTENSION_EVENTS_HEARTBEAT_MS,
    type ExtensionEvent,
    ExtensionExecSchema,
    type ExtensionExecResult,
    ExtensionWorkHoldSchema,
} from "@intentic/sandbox-contract/extension-protocol";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { runExtensionExec } from "./extension-exec.js";
import { holdExtensionWork } from "./extension-holds.js";

// (2026-11-26) The two doors an extension's declared `permissions` open beside its own settings and events
// (own.routes.ts): holding work in flight (`work`) and running a command under a workload class (`exec`). Reached by
// every extension token undeclared in `permissions.daemon` (extension-manifest's EXTENSION_OWN_ROUTES); each resolves
// the caller from its token again and checks the declaration its manifest makes now.

// The calling extension, or the refusal to answer with (own.routes.ts ownCaller).
type OwnCaller = (c: Context<AppEnv>) => Promise<InstalledExtension | Response>;

// A request's JSON body read by `schema`; a body that is not JSON reads as nothing, which the schema then refuses.
const bodyOf = async <S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.ZodSafeParseResult<z.output<S>>> => {
    let raw: unknown;
    try {
        raw = await c.req.json();
    } catch {
        // allow(silent-catch): a body that is not JSON is no request, which the schema below refuses
        raw = undefined;
    }
    return schema.safeParse(raw);
};

export const createExtensionDoors = (services: Services, ownCaller: OwnCaller) => ({
    // Work in flight, held for as long as the extension keeps this answer open (extension-holds.ts): an ndjson heartbeat
    // on the events' beat, so its runtime can tell a daemon gone quiet and hold again. Refused unless the manifest
    // declares `permissions.work`.
    hold: async (c: Context<AppEnv>): Promise<Response> => {
        const extension = await ownCaller(c);
        if (extension instanceof Response) {
            return extension;
        }
        if (!declaredReachOf(extension.manifest.permissions).work) {
            return c.json({ error: `extension "${extension.id}" did not declare permissions.work, so it holds no work in flight` }, 403);
        }
        const asked = await bodyOf(c, ExtensionWorkHoldSchema);
        if (!asked.success) {
            return c.json({ error: "a hold carries { label }, one line of up to 120 characters" }, 400);
        }
        c.header("content-type", "application/x-ndjson");
        return stream(c, async (ndjson) => {
            // Held before the first byte goes out, so a holder that sees the answer begin is already counted.
            const release = holdExtensionWork(extensionIdOf(extension.manifest), asked.data.label);
            // allow(silent-catch): the only failure is a holder that went away, which the abort below also ends
            const beat = (): void => void ndjson.writeln(JSON.stringify({ kind: "heartbeat" } satisfies ExtensionEvent)).catch(() => undefined);
            beat();
            const beating = setInterval(beat, EXTENSION_EVENTS_HEARTBEAT_MS);
            try {
                await new Promise<void>((resolve) => ndjson.onAbort(resolve));
            } finally {
                clearInterval(beating);
                release();
            }
        });
    },

    // One command run under a workload class the manifest declares (`permissions.exec`), admitted as the daemon's own
    // background work is (extension-exec.ts); answered once it ends. The caller letting go ends it.
    exec: async (c: Context<AppEnv>): Promise<Response> => {
        const extension = await ownCaller(c);
        if (extension instanceof Response) {
            return extension;
        }
        const asked = await bodyOf(c, ExtensionExecSchema);
        if (!asked.success) {
            return c.json({ error: `not a command to run: ${asked.error.issues[0]?.message ?? "the body does not parse"}` }, 400);
        }
        if (!declaredReachOf(extension.manifest.permissions).exec.includes(asked.data.class)) {
            return c.json(
                { error: `extension "${extension.id}" did not declare the workload class "${asked.data.class}": add it to permissions.exec in its manifest` },
                403,
            );
        }
        return c.json(await runExtensionExec(services, extensionIdOf(extension.manifest), asked.data, c.req.raw.signal) satisfies ExtensionExecResult);
    },
});
