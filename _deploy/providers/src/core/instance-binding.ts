import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { containerId } from "./backing-ssh.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "./inputs.js";
import { type SshExecutor, type SshSession, sshExecutor } from "./ssh.js";

// One app's slice of a shared backing (a Postgres database+role, a Valkey ACL user, a Garage bucket+key); reaches
// into the instance's container over SSH + `docker exec` rather than owning one. A missing container reads as
// absent on read, fails on apply, and is a noop on delete; a binding never diffs since its identity and password derive
// from the graph.

// Every binding's inputs: the host's ssh block plus the stamped instance to exec into; connection-string
// coordinates differ per backing and live on its own schema.
export const bindingSchema = sshSchema.extend({
    // Id of the backing instance's container (stamped intentic.id=<instance>), found without a container id.
    instance: z.string(),
});

export interface InstanceBindingSpec<S extends z.ZodType> {
    // Names this binding in every log line, error and parse failure.
    readonly kind: string;
    readonly schema: S;
    // $ref-derived inputs a read must not parse while pending: what this binding takes from its instance.
    readonly pendingRefs: readonly string[];
    // Binding's outputs if it already exists inside the running instance, undefined otherwise.
    readonly present: (session: SshSession, cid: string, parsed: z.infer<S>) => Promise<Record<string, unknown> | undefined>;
    // Create-or-update, idempotent; apply re-runs on every reconcile.
    readonly create: (session: SshSession, cid: string, parsed: z.infer<S>) => Promise<Record<string, unknown>>;
    // Tears down from inside the still-running instance; never called once the instance itself is gone.
    readonly drop: (session: SshSession, cid: string, parsed: z.infer<S>) => Promise<void>;
}

export const createInstanceBindingProvider = <S extends typeof bindingSchema>(
    spec: InstanceBindingSpec<S>,
    executor: SshExecutor = sshExecutor,
): Provider => {
    const parse = (inputs: ResolvedInputs): z.infer<S> => parseInputs(spec.schema, inputs, spec.kind);

    return {
        read: async (inputs, ctx) => {
            // A pending dependency means this resource cannot be introspected yet; parsing would crash on the symbol.
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
        // Identifiers and the generated credential never drift, so a present binding is always a noop.
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
