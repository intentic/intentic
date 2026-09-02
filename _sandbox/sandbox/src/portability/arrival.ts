import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import type { ArrivalApply, ArrivalHost, ArrivalItem, ArrivalPlan, ArrivalReport, SandboxDefinition } from "@intentic/sandbox-contract";
import { extract } from "tar-stream";
import {
    type AssistantSetup,
    applyAssistantSetup,
    assistantHosts,
    assistantPlan,
    readAssistantArchive,
    scanAssistantHost,
    skippedLines,
} from "../migrations/assistants.js";
import type { Services } from "../composition.js";
import { composeEnvironment } from "../environment/environment.js";
import { applyDefinitionItems, definitionActions, definitionItems } from "./apply-definition.js";
import { ArrivalFormatError, ArrivalStaleError } from "./arrival-error.js";
import { BUNDLE_MANIFEST_ENTRY } from "./bundle.js";
import { applyBundle, bundleActions, bundleItems, dropSpool, type HeldBundle, spoolBundle } from "./bundle-arrival.js";
import { parseDefinitionToml } from "./definition.js";
import { MAX_UPLOAD_BYTES } from "../workspace/workspace-files.js";

/* THE ARRIVAL PIPELINE: one plan → apply → report, for every artifact that can come INTO this sandbox.
 *
 * Four things can arrive — a `sandbox.toml`, an environment bundle, a Hermes home directory, an OpenClaw one —
 * and each used to have a surface of its own: its own routes, its own schemas, its own held state, its own
 * card. Read side by side they were the same feature four times, and the differences between them were not
 * design, they were drift:
 *
 *   - the definition and the two assistants previewed; the BUNDLE wrote on file pick, though it is the only
 *     one of the four that lands over a workspace rather than beside it
 *   - the assistants asked about credentials at apply, on the way IN; the bundle asked at EXPORT, on the way
 *     out, of a different person at a different moment
 *   - all four ended in a "what landed / what didn't / what still needs you" report, rendered three times from
 *     three schemas whose only real difference was which words they used for the same three lists
 *
 * So the artifact became a PARSER and everything else moved here. What each source still owns is exactly what
 * is particular to it: recognizing itself, listing what it would land, and writing that through native paths.
 *
 * ONE HELD ARRIVAL AT A TIME, and a second read replaces the first — an owner changing their mind is the
 * ordinary case, not a conflict. Where it is held is the one thing the sources genuinely differ on and this
 * file is honest about it: a definition is a parsed document, an assistant setup is a bounded file map kept in
 * MEMORY because it is somebody's credential store, and a bundle is a spooled file because it can be tens of
 * gigabytes. Dropping the held arrival therefore has to be async — a spool is a file to delete.
 *
 * THE APPLY RE-DERIVES. The wire plan the browser rendered is never the input a write trusts: the ticked ids
 * are matched against a checklist derived again from the held artifact, so a plan that went stale names fewer
 * items rather than writing something nobody reviewed.
 */

// How much of the upload to read before deciding what it is. A gzip member's first tar header is inside the
// first block; this is generous by three orders of magnitude and still bounded.
const SNIFF_BYTES = 64 * 1024;

type Held =
    | { readonly kind: "definition"; readonly token: string; readonly definition: SandboxDefinition }
    | { readonly kind: "bundle"; readonly token: string; readonly held: HeldBundle }
    | { readonly kind: "assistant"; readonly token: string; readonly setup: AssistantSetup };

export interface Arrivals {
    // Read an uploaded artifact — any of the four — and answer with the checklist it produces.
    readonly plan: (body: ReadableStream<Uint8Array>, limit: number) => Promise<ArrivalPlan>;
    // Every enrolled machine, and whether a setup is sitting on it. Probed on the card's first render.
    readonly hosts: () => Promise<ArrivalHost[]>;
    // Read one machine's setup directly: the same plan, without the packing.
    readonly scan: (hostId: string) => Promise<ArrivalPlan>;
    readonly apply: (input: ArrivalApply) => Promise<ArrivalReport>;
    readonly abandon: () => Promise<boolean>;
}

/* Take the first chunks off the stream without consuming it, and hand back something that replays them.
 *
 * Iterating with `for await` and breaking would DESTROY the source, which is why the iterator is driven by
 * hand: `next()` pulls, and nothing ever calls `return()`, so the rest of the upload is still there to be
 * piped afterwards. */
const peek = async (body: ReadableStream<Uint8Array>, bytes: number): Promise<{ head: Buffer; replay: ReadableStream<Uint8Array> }> => {
    const iterator = Readable.fromWeb(body as NodeReadableStream<Uint8Array>)[Symbol.asyncIterator]();
    const chunks: Buffer[] = [];
    let taken = 0;
    while (taken < bytes) {
        const next = await iterator.next();
        if (next.done === true) {
            break;
        }
        const chunk = next.value as Buffer;
        chunks.push(chunk);
        taken += chunk.length;
    }
    const replay = Readable.from(
        (async function* () {
            yield* chunks;
            for (;;) {
                const next = await iterator.next();
                if (next.done === true) {
                    return;
                }
                yield next.value;
            }
        })(),
    );
    return { head: Buffer.concat(chunks), replay: Readable.toWeb(replay) as ReadableStream<Uint8Array> };
};

/* The first tar entry's name, out of a gzip PREFIX. Truncation is expected and ignored: the decoders are
 * destroyed the moment the header arrives, and a prefix that does not reach one answers undefined rather than
 * throwing, because "this is not a bundle" is a fine thing to learn from a failed read. */
const firstEntryName = (head: Buffer): Promise<string | undefined> =>
    new Promise((resolve) => {
        const gunzip = createGunzip();
        const ex = extract();
        let settled = false;
        const finish = (name?: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            gunzip.destroy();
            ex.destroy();
            resolve(name);
        };
        ex.on("entry", (header) => finish(header.name));
        ex.on("finish", () => finish(undefined));
        ex.on("error", () => finish(undefined));
        gunzip.on("error", () => finish(undefined));
        Readable.from([head]).pipe(gunzip).pipe(ex);
    });

/* WHICH OF THE FOUR THIS IS, decided from the bytes rather than from a filename, a form field or a separate
 * route per format. Two questions and no guessing:
 *
 *   not gzip                     → a document, so a definition (the TOML parser answers if it is not one)
 *   gzip, first entry the manifest → our own bundle
 *   gzip, anything else          → a packed foreign home directory
 *
 * A bundle's manifest is guaranteed to be the tar's FIRST entry (bundle.ts writes it first precisely so a
 * reader knows the shape before the bytes), which is what makes the second question answerable from a prefix.
 */
const sniff = async (head: Buffer): Promise<"definition" | "bundle" | "assistant"> => {
    if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) {
        return "definition";
    }
    return (await firstEntryName(head)) === BUNDLE_MANIFEST_ENTRY ? "bundle" : "assistant";
};

const readAll = async (body: ReadableStream<Uint8Array>, limit: number): Promise<string> => {
    const chunks: Buffer[] = [];
    let taken = 0;
    for await (const chunk of Readable.fromWeb(body as NodeReadableStream<Uint8Array>)) {
        taken += (chunk as Buffer).length;
        if (taken > limit) {
            throw new ArrivalFormatError("that file is far too large to be a sandbox definition");
        }
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

export const createArrivals = (services: Services): Arrivals => {
    let pending: Held | undefined;

    // Whatever the last read left behind, dropped before the next one is held. A spool is a file, so this is
    // the reason `abandon` and `plan` are async where the old surfaces' were not.
    const release = async (): Promise<boolean> => {
        const held = pending;
        pending = undefined;
        if (held?.kind === "bundle") {
            await dropSpool(held.held.spool);
        }
        return held !== undefined;
    };

    // Everything a held artifact says about itself, in the one shape the card renders. Derived, never stored:
    // the same call answers `plan` and re-derives at `apply`.
    const describe = async (held: Held): Promise<Omit<ArrivalPlan, "token">> => {
        if (held.kind === "definition") {
            return {
                source: "definition",
                ...(held.definition.name === undefined ? {} : { name: held.definition.name }),
                items: await definitionItems(services, held.definition),
                // A definition carries secret NAMES and never a value, so there is nothing for the second
                // consent to gate and the card does not ask.
                carriesSecrets: false,
                refused: [],
                needsAction: definitionActions(held.definition),
            };
        }
        if (held.kind === "bundle") {
            const manifest = held.held.index.manifest;
            return {
                source: "bundle",
                ...(manifest.sandbox === undefined ? {} : { name: manifest.sandbox.name }),
                items: bundleItems(held.held.index),
                // Whatever its owner chose at export. False means the values are simply not in the file.
                carriesSecrets: manifest.secrets,
                refused: [...held.held.index.refused],
                needsAction: bundleActions(manifest, false),
            };
        }
        const planned = assistantPlan(held.setup);
        /* Sorted HERE and not in the browser, because the checklist's order is the daemon's answer for every
         * source: a definition and a bundle already emit in the order their apply lands things, and an adapter
         * emits in the order it walked a stranger's folder. This is that order for a foreign setup — what the
         * agent will KNOW, then what RUNS, then what CONNECTS, then the keys — so the card renders
         * `plan.items` as given and there is one authority on reading order rather than two. */
        const groups: ArrivalItem["group"][] = ["memory", "skill", "automation", "capability", "files", "secret"];
        const items = planned.planned
            .map((entry): ArrivalItem => ({ ...entry.item, applicable: true }))
            .toSorted((left, right) => groups.indexOf(left.group) - groups.indexOf(right.group));
        return {
            source: held.setup.source,
            items,
            carriesSecrets: items.some((item) => item.secrets.length > 0),
            refused: [...planned.refused, ...skippedLines(held.setup.skipped)],
            needsAction: [...planned.needsAction],
        };
    };

    const hold = async (make: (token: string) => Held | Promise<Held>): Promise<ArrivalPlan> => {
        await release();
        const token = randomUUID();
        const held = await make(token);
        pending = held;
        return { token, ...(await describe(held)) };
    };

    return {
        plan: async (body, limit) => {
            const { head, replay } = await peek(body, SNIFF_BYTES);
            const kind = await sniff(head);
            if (kind === "definition") {
                const toml = await readAll(replay, SNIFF_BYTES);
                return hold((token) => ({ kind: "definition", token, definition: parseDefinitionToml(toml) }));
            }
            if (kind === "assistant") {
                return hold(async (token) => ({ kind: "assistant", token, setup: await readAssistantArchive(replay, limit) }));
            }
            return hold(async (token) => ({ kind: "bundle", token, held: await spoolBundle(replay, services.config.historyRoot, limit) }));
        },
        hosts: () => assistantHosts(services),
        scan: async (hostId) => {
            const setup = await scanAssistantHost(services, hostId);
            return hold((token) => ({ kind: "assistant", token, setup }));
        },
        apply: async (input) => {
            if (pending === undefined || pending.token !== input.token) {
                throw new ArrivalStaleError("no held arrival matches that plan: read the file again and re-review");
            }
            const held = pending;
            /* Consumed on the way out whatever happens item by item: the failures a re-run can fix are about
             * the TARGET (activate DevOps, free disk, remove a colliding repo), not about the held bytes, and
             * keeping a credential store or a multi-gigabyte spool past its use would be a lifetime somebody
             * has to remember. `pending` is cleared first so a throw below cannot strand it. */
            pending = undefined;
            const chosen = new Set(input.items);
            if (held.kind === "definition") {
                return applyDefinitionItems(services, held.definition, (item) => chosen.has(item.id));
            }
            if (held.kind === "assistant") {
                return applyAssistantSetup(services, held.setup, { items: input.items, includeSecrets: input.includeSecrets });
            }
            try {
                const report = await applyBundle(
                    held.held,
                    { workspaceRoot: services.workspace.root, historyRoot: services.config.historyRoot },
                    { items: input.items, includeSecrets: input.includeSecrets },
                    MAX_UPLOAD_BYTES,
                );
                /* A bundle writes manifests the daemon's own state is DERIVED from (the capability list, the
                 * approved custom overlay section), so recompose before answering: the Environment card then
                 * renders this sandbox's own composition, against ITS base image, instead of whatever the
                 * source sandbox last had. The other two sources converge inside their own apply loops, which
                 * know which of their items touched what; a bundle only knows it wrote files. */
                await composeEnvironment(services);
                return report;
            } finally {
                await dropSpool(held.held.spool);
                services.history.notifyUserWrite();
            }
        },
        abandon: release,
    };
};
