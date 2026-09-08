import type { Provider, ProviderContext, ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { z } from "zod";
import { composeDown, composeUp, containerImage, containerLabel, restampBacking, stateDir, waitReady } from "./backing-ssh.js";
import { type EnvEntry, type HostFile, writeEnvOnce, writeHostFiles } from "./host-files.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "./inputs.js";
import { listStampedContainers } from "./list-stamped.js";
import { type SshExecutor, type SshSession, sshExecutor } from "./ssh.js";

// A backing is a single-container compose project per instance (Postgres, Valkey, Garage, Authentik). The six
// entry points below (read/diff/apply/delete/list/restamp) are the same shape for every kind; only the schema,
// compose file, probe, and at most two hooks are genuinely per-backing.

// What every backing's inputs carry: the host (ssh block), its internal address, the pinned image, and protect.
export const backingSchema = sshSchema.extend({
    internalIp: z.string(),
    // The host port the instance's service port is published on; resolver-assigned, disjoint per instance.
    publishPort: z.number(),
    image: z.string(),
    // Never pruned while true (the engine's protect convention); stamped so orphan pruning honors it too.
    protect: z.boolean().default(false),
});

export interface BackingSpec<S extends z.ZodType> {
    // The compose project + `/opt/intentic/<kind>/<id>` state dir, the intentic.type stamp, and this kind's name.
    readonly kind: string;
    readonly schema: S;
    // How long the instance gets to answer its probe after `up -d`; no default, it varies wildly per backing.
    readonly readyTimeoutMs: number;
    // The $ref-derived inputs `read` must not parse while still pending; every backing depends on its host's
    // internalIp, hence the default.
    readonly pendingRefs?: readonly string[];
    // The resource's produced outputs, derived from the inputs alone, so a noop reconcile re-derives them without
    // touching the host.
    readonly outputs: (parsed: z.infer<S>) => Record<string, unknown>;
    // The state dir's config files, rewritten on every apply (how an image-pin bump reaches the host). Must include
    // compose.yaml, whose stamped service carries `stampLabels`.
    readonly files: (parsed: z.infer<S>, id: string, hash: string) => Record<string, string | HostFile>;
    // The write-once .env. Omitted when the backing keeps its secrets elsewhere; the file is still created, since
    // compose is given `--env-file` regardless.
    readonly env?: (parsed: z.infer<S>) => readonly EnvEntry[];
    // A host-side command exiting 0 once the instance is serving. `execProbe` builds the usual one; an HTTP backing
    // wgets its own health route instead.
    readonly probe: (parsed: z.infer<S>, id: string) => string;
    // Host-side material that must exist before the stack starts but must never be rewritten on later applies. Runs
    // after the config files land, before `up -d`.
    readonly prepare?: (session: SshSession, parsed: z.infer<S>, dir: string) => Promise<void>;
    // First-boot bootstrap, run after the probe passes on apply, and therefore on every apply: it must tolerate an
    // instance that is already bootstrapped.
    readonly ready?: (session: SshSession, parsed: z.infer<S>, id: string) => Promise<void>;
    // Whether a renamed node moves its data instead of being destroyed and recreated. True only for a backing whose
    // whole state is one compose volume named `data`; a multi-volume backing needs its own restamp.
    readonly restamp?: boolean;
}

export const createBackingProvider = <S extends typeof backingSchema>(spec: BackingSpec<S>, executor: SshExecutor = sshExecutor): Provider => {
    const parse = (inputs: ResolvedInputs): z.infer<S> => parseInputs(spec.schema, inputs, spec.kind);
    const pendingRefs = spec.pendingRefs ?? ["internalIp"];

    return {
        read: async (inputs, ctx) => {
            // A dependency of these $ref inputs is still a pending create; parsing would crash on the PENDING symbol.
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
                  // Inputs are resolved leniently (the new node's ref is absent); parse only the SSH block to connect.
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
