import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { containerId } from "./backing-ssh.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "./inputs.js";
import { type SshExecutor, type SshSession, sshExecutor } from "./ssh.js";

/* ONE APP'S SLICE OF A SHARED BACKING: a database and its role on a Postgres, an ACL user on a Valkey, a
 * bucket and its key on a Garage. A binding owns no container of its own, it reaches into the INSTANCE's
 * container over SSH + `docker exec` and creates something inside it.
 *
 * The three bindings had written the same four bodies out with a different CLI in the middle, and the
 * plumbing around that CLI is where all three had to agree and did not:
 *
 * NOT-YET-CREATED IS NOT AN ERROR. A read runs during plan, when the instance may be a pending create and
 * the host may not exist at all, so an unreachable host and an absent container both mean "not created
 * yet". Only two of the three guarded their $ref inputs against the engine's PENDING placeholder, so a
 * plan touching the third parsed a symbol and reported malformed inputs for a graph that was simply not
 * built yet. `pendingRefs` is therefore required rather than defaulted: which inputs come from the
 * instance is the one thing no factory can infer.
 *
 * ABSENT ON READ, LOUD ON APPLY, QUIET ON DELETE. The same missing container means three different things:
 * read reports the binding absent, apply cannot proceed and says which instance it wanted, delete has
 * nothing left to drop and says so once. Every binding needs all three, and each copy had written its own
 * wording for them.
 *
 * A binding never diffs: its name, its identifiers and its (stable, generated) password are derived from
 * the graph, so a binding that EXISTS is a binding that matches. What drifts is the instance, not this.
 */

// What every binding's inputs carry: the host's ssh block and the stamped instance to exec into. The
// coordinates it renders into a connection string (a host/port pair, an S3 endpoint) differ per backing and
// live on the binding's own schema.
export const bindingSchema = sshSchema.extend({
    // The id of the backing instance's container (stamped intentic.id=<instance>), which is how a binding
    // finds the thing it lives inside without being told a container id.
    instance: z.string(),
});

export interface InstanceBindingSpec<S extends z.ZodType> {
    // Names this binding in every log line and error, and labels its parse failures.
    readonly kind: string;
    readonly schema: S;
    // The $ref-derived inputs a read must not parse while they are still pending, i.e. everything this
    // binding takes from the instance it binds to.
    readonly pendingRefs: readonly string[];
    // The binding's outputs if it already exists inside the running instance, undefined if it does not.
    readonly present: (session: SshSession, cid: string, parsed: z.infer<S>) => Promise<Record<string, unknown> | undefined>;
    // Create-or-update, idempotent: apply re-runs on every reconcile of a graph that still wants it.
    readonly create: (session: SshSession, cid: string, parsed: z.infer<S>) => Promise<Record<string, unknown>>;
    // Tear down, from inside the still-running instance. Never called when the instance is gone: that case
    // is already handled, its contents went with it.
    readonly drop: (session: SshSession, cid: string, parsed: z.infer<S>) => Promise<void>;
}

export const createInstanceBindingProvider = <S extends typeof bindingSchema>(
    spec: InstanceBindingSpec<S>,
    executor: SshExecutor = sshExecutor,
): Provider => {
    const parse = (inputs: ResolvedInputs): z.infer<S> => parseInputs(spec.schema, inputs, spec.kind);

    return {
        read: async (inputs, ctx) => {
            // A dependency of these $ref inputs is still a pending create (plan resolves leniently),
            // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
            if (hasPendingRef(inputs, ...spec.pendingRefs)) {
                return undefined;
            }
            const parsed = parse(inputs);
            let session: SshSession;
            try {
                session = await executor.connect(sshTarget(parsed));
            } catch (error) {
                ctx.log(`${spec.kind} "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
                return undefined;
            }
            try {
                const cid = await containerId(session, parsed.instance);
                if (cid === "") {
                    return undefined;
                }
                const outputs = await spec.present(session, cid, parsed);
                return outputs === undefined ? undefined : { outputs };
            } finally {
                await session.dispose();
            }
        },
        // The identifiers and the (stable, generated) credential never drift, so a present binding is a noop.
        diff: () => ({ action: "noop" }),
        apply: async (inputs, _observed, ctx) => {
            const parsed = parse(inputs);
            const session = await executor.connect(sshTarget(parsed));
            try {
                const cid = await containerId(session, parsed.instance);
                if (cid === "") {
                    throw new Error(`${spec.kind} "${ctx.id}": instance "${parsed.instance}" is not running`);
                }
                return await spec.create(session, cid, parsed);
            } finally {
                await session.dispose();
            }
        },
        delete: async (inputs, ctx) => {
            const parsed = parse(inputs);
            const session = await executor.connect(sshTarget(parsed));
            try {
                const cid = await containerId(session, parsed.instance);
                if (cid === "") {
                    ctx.log(`${spec.kind} "${ctx.id}": instance "${parsed.instance}" already gone; nothing to drop`);
                    return;
                }
                await spec.drop(session, cid, parsed);
            } finally {
                await session.dispose();
            }
        },
    };
};
