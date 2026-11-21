import { RunnerLabelSchema, runnerTitle } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { ORPCError } from "@orpc/client";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { ownerDenied } from "../../auth/owner-gates.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";

/* naming/: WHAT A RUNNER IS CALLED, AND WHOSE IT IS (2026-11-21). Its id never changes (runner-protocol.ts); a person
   gives it a label, kept by its parent beside its enrollment (this file), which the parent tells the runner, which keeps
   it where its machine's listing reads a sandbox's name (runner-presentation.ts). */

/* WHAT A RUNNER CALLS ITSELF ON ITS MACHINE (2026-11-21). The machine lists a runner by the name its daemon keeps in its
   presentation file (ic's loopback.rs), as it lists a person's sandbox; a runner hears that name, and whose it is, only
   from here. Said on every connect, so a rename made while it was away, or this sandbox's own new name, reaches it the
   next time it dials in, and after a rename while it is online. Never throws: a runner that cannot take it is still a
   runner, listed by its slug. */
export const pushRunnerPresentation = async (services: Pick<Services, "runners" | "runnerHub" | "presentation" | "logger">, id: string): Promise<void> => {
    const client = services.runnerHub.client(id);
    if (client === undefined) {
        return;
    }
    try {
        const runner = (await services.runners.list()).find((entry) => entry.id === id);
        if (runner === undefined) {
            return;
        }
        // A copy this sandbox cannot read is told as no name: the runner still learns its own, and whose it is by address.
        const own = await services.presentation.held().catch((err: Error) => {
            services.logger.warn({ err }, "runners: could not read this sandbox's own name to tell a runner");
            return undefined;
        });
        const parentName = own === undefined || own.name.trim() === "" ? undefined : own.name;
        await client.present({ name: runnerTitle(runner), ...opt("parentName", parentName) });
    } catch (err) {
        // An older runner has no `present` and answers NOT_FOUND; it keeps its slug as its name until it is updated.
        const older = err instanceof ORPCError && err.code === "NOT_FOUND";
        services.logger[older ? "info" : "warn"]({ err, id }, older ? "runners: this runner is too old to be told its name" : "runners: could not tell a runner its name");
    }
};

// A runner's name for people (runner-protocol.ts RunnerLabelSchema): kept beside its enrollment, so it holds while the
// runner is away, and told to the runner now when it is connected (otherwise on its next connect). Empty clears it.
export const createRunnerLabelRoute =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const id = c.req.param("id") ?? "";
        if (!(await services.runners.enrolled(id))) {
            return c.json({ error: "this sandbox has no runner with that id" }, 404);
        }
        // allow(silent-catch): a body that is not JSON is answered as the 400 just below
        const parsed = RunnerLabelSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "expected { label } of at most 64 characters" }, 400);
        }
        // A label the same as the id is no label: the runner already reads by its id.
        const label = parsed.data.label === "" || parsed.data.label === id ? undefined : parsed.data.label;
        await services.runners.amend(id, { label });
        // Every open tab's runner list (Devices, the composer's placement menu, offload) reads it again.
        publishRuntimeChange("runners");
        await pushRunnerPresentation(services, id);
        return c.json({ ok: true });
    };
