import type { Provider, ProviderContext, ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { z } from "zod";
import { composeDown, composeUp, containerImage, containerLabel, restampBacking, stateDir, waitReady } from "./backing-ssh.js";
import { type EnvEntry, type HostFile, writeEnvOnce, writeHostFiles } from "./host-files.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "./inputs.js";
import { listStampedContainers } from "./list-stamped.js";
import { type SshExecutor, type SshSession, sshExecutor } from "./ssh.js";

/* ONE BACKING INSTANCE, AND EVERY BACKING IS THIS SHAPE.
 *
 * A backing is a single-container compose project deployed per instance on a host: a Postgres, a Valkey, a
 * Garage, an Authentik. The engine's six entry points around one are the same six every time, and were
 * written out four times, differing only in which word appeared in two log lines:
 *
 *   read     , SSH in, run a host-side readiness probe, and report the running image + the drift stamp.
 *              An unreachable host is NOT a failure, it is "not created yet", because a plan runs against
 *              hosts that may themselves still be pending creates.
 *   diff     , the image pin, and nothing else. Everything else about a backing is derived from its inputs.
 *   apply    , write the config files, `up -d`, wait for the probe, hand back the outputs.
 *   delete   , `down -v` and remove the state dir, parsing ONLY the ssh block so it works from a removed
 *              node's inputs and from a scan's ListedResource alike.
 *   list     , the stamped containers of this kind across the scan's hosts.
 *   restamp  , move a renamed instance's data volume rather than orphaning it.
 *
 * The copies had drifted, which is the argument for this file rather than a matter of taste: three of the
 * four wrote a `.env` and one did not, and composeUp passes `--env-file` unconditionally, so valkey could
 * not bring up a fresh instance at all (see writeEnvOnce). What is genuinely per-backing is small enough to
 * read in one screen: a schema, a compose file, a probe, and at most two hooks.
 *
 * The catalog SERVICES (compose-service.ts) are the same idea one level up: singleton stacks of several
 * containers, keyed by kind rather than by node id, diffed per compose service. The two factories share
 * their file-writing (host-files.ts) and their stamp (backing-ssh.ts) and stay separate above that, because
 * per-instance and singleton is a difference in identity, not a flag.
 */

// What every backing's inputs carry, whatever it is a backing OF: where the host is (the ssh block), the
// host-internal address it publishes on, the fully-pinned image, and the engine's protect convention.
export const backingSchema = sshSchema.extend({
    internalIp: z.string(),
    // The host port the instance's service port is published on; resolver-assigned, disjoint per instance.
    publishPort: z.number(),
    image: z.string(),
    // Never pruned while true (the engine's protect convention); stamped so orphan pruning honors it too.
    protect: z.boolean().default(false),
});

export interface BackingSpec<S extends z.ZodType> {
    // The compose project + `/opt/intentic/<kind>/<id>` state dir, the intentic.type stamp, and the word
    // that names this thing in every log line and error the factory produces.
    readonly kind: string;
    readonly schema: S;
    // How long the instance gets to answer its probe after `up -d`. Wildly different per backing (a Valkey
    // is up in seconds, an Authentik runs database migrations first), so there is no default worth having.
    readonly readyTimeoutMs: number;
    /* The $ref-derived inputs `read` must not parse while they are still pending. Every backing depends on
     * its host's internalIp, which is why that is the default; a backing wiring in more of its host's
     * outputs names them all. */
    readonly pendingRefs?: readonly string[];
    // The resource's produced outputs, derived from the inputs alone, so a noop reconcile re-derives them
    // without touching the host.
    readonly outputs: (parsed: z.infer<S>) => Record<string, unknown>;
    // The state dir's config files, rewritten on every apply (that is how an image-pin bump reaches the
    // host). Must include compose.yaml, whose stamped service carries `stampLabels`.
    readonly files: (parsed: z.infer<S>, id: string, hash: string) => Record<string, string | HostFile>;
    // The write-once .env. Omitted when the backing keeps its secrets elsewhere (valkey's requirepass rides
    // its own conf file); the file is still created, because compose is given `--env-file` regardless.
    readonly env?: (parsed: z.infer<S>) => readonly EnvEntry[];
    // A host-side command exiting 0 once the instance is serving. `execProbe` builds the usual one (a
    // command run inside the stamped container); an HTTP backing wgets its own health route instead.
    readonly probe: (parsed: z.infer<S>, id: string) => string;
    // Host-side material that must exist before the stack starts but must NOT be rewritten on later applies
    // (garage's RPC secret, generated on the host). Runs after the config files land, before `up -d`.
    readonly prepare?: (session: SshSession, parsed: z.infer<S>, dir: string) => Promise<void>;
    // First-boot bootstrap, run after the probe passes on apply, and therefore on EVERY apply: it has to
    // tolerate an instance that is already bootstrapped (garage's layout assignment is guarded on its own
    // state, which is what that looks like).
    readonly ready?: (session: SshSession, parsed: z.infer<S>, id: string) => Promise<void>;
    /* Whether a renamed node moves its data instead of being destroyed and recreated. True only for a
     * backing whose whole state is ONE compose volume named `data` (postgres, valkey), which is what
     * restampBacking knows how to migrate. A multi-volume backing (garage's meta+data, authentik's five)
     * would need its volume set enumerated here, and until one is renamed in anger, publishing no restamp
     * and letting the engine warn is the honest answer rather than a half-correct migration. */
    readonly restamp?: boolean;
}

export const createBackingProvider = <S extends typeof backingSchema>(spec: BackingSpec<S>, executor: SshExecutor = sshExecutor): Provider => {
    const parse = (inputs: ResolvedInputs): z.infer<S> => parseInputs(spec.schema, inputs, spec.kind);
    const pendingRefs = spec.pendingRefs ?? ["internalIp"];

    return {
        read: async (inputs, ctx) => {
            // A dependency of these $ref inputs is still a pending create (plan resolves leniently),
            // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
            if (hasPendingRef(inputs, ...pendingRefs)) {
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
                if ((await session.exec(spec.probe(parsed, ctx.id))).code !== 0) {
                    return undefined;
                }
                const stampHash = await containerLabel(session, ctx.id, HASH_KEY);
                return {
                    outputs: spec.outputs(parsed),
                    detail: { image: await containerImage(session, ctx.id) },
                    ...(stampHash === "" ? {} : { stampHash }),
                };
            } finally {
                await session.dispose();
            }
        },
        diff: (inputs, observed) => {
            const parsed = parse(inputs);
            const image = (observed.detail?.["image"] ?? "") as string;
            return image === parsed.image
                ? { action: "noop" }
                : { action: "update", reason: `${spec.kind} image differs (running ${image}, want ${parsed.image})` };
        },
        apply: async (inputs, _observed, ctx) => {
            const parsed = parse(inputs);
            const session = await executor.connect(sshTarget(parsed));
            try {
                const dir = stateDir(spec.kind, ctx.id);
                await writeHostFiles(session, spec.kind, dir, spec.files(parsed, ctx.id, ctx.inputsHash ?? ""));
                await writeEnvOnce(session, spec.kind, dir, spec.env?.(parsed) ?? []);
                await spec.prepare?.(session, parsed, dir);
                await composeUp(session, spec.kind, ctx.id);
                await waitReady(session, spec.kind, ctx.id, spec.probe(parsed, ctx.id), spec.readyTimeoutMs);
                await spec.ready?.(session, parsed, ctx.id);
                return spec.outputs(parsed);
            } finally {
                await session.dispose();
            }
        },
        // Parses only the SSH block, so it works from a removed node's inputs AND a ListedResource's (a host's).
        delete: async (inputs, ctx) => {
            const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, spec.kind)));
            try {
                await composeDown(session, spec.kind, ctx.id);
            } finally {
                await session.dispose();
            }
        },
        list: (sources, ctx) => listStampedContainers(executor, spec.kind, sources, ctx.log),
        ...(spec.restamp === true
            ? {
                  // Inputs are resolved leniently (the new node's internalIp ref is absent), so parse only the
                  // SSH block to connect; the image (a literal) drives the volume-copy container.
                  restamp: async (oldId: string, inputs: ResolvedInputs, ctx: ProviderContext): Promise<void> => {
                      const target = sshTarget(parseInputs(sshSchema, inputs, spec.kind));
                      const image = typeof inputs["image"] === "string" ? inputs["image"] : "busybox";
                      const session = await executor.connect(target);
                      try {
                          await restampBacking(session, spec.kind, oldId, ctx.id, image);
                      } finally {
                          await session.dispose();
                      }
                  },
              }
            : {}),
    };
};
