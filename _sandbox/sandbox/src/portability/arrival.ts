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
import { ArrivalFormatError, ArrivalStaleError } from "../arrival-error.js";
import { BUNDLE_MANIFEST_ENTRY } from "./bundle.js";
import { applyBundle, bundleActions, bundleItems, dropSpool, type HeldBundle, spoolBundle } from "./bundle-arrival.js";
import { parseDefinitionToml } from "./definition.js";
import { MAX_UPLOAD_BYTES } from "../workspace/files/workspace-files-upload.js";

// Arrival pipeline: one plan → apply → report for everything that can arrive (sandbox.toml, a bundle, a Hermes/OpenClaw
// home), replacing four near-identical surfaces. Only one artifact is held at a time, dropped asynchronously since a
// bundle spools to a file. Apply re-derives its checklist from the held artifact, never the wire plan the browser
// rendered.

// How much of the upload to read before deciding what it is: generous, yet bounded.
const SNIFF_BYTES = 64 * 1024;

type Held =
    | { readonly kind: "definition"; readonly token: string; readonly definition: SandboxDefinition }
    | { readonly kind: "bundle"; readonly token: string; readonly held: HeldBundle }
    | { readonly kind: "assistant"; readonly token: string; readonly setup: AssistantSetup };

export interface Arrivals {
    // Reads an uploaded artifact, any of the four, and answers with the checklist it produces.
    readonly plan: (body: ReadableStream<Uint8Array>, limit: number) => Promise<ArrivalPlan>;
    // Every enrolled machine, and whether a setup sits on it; probed on the card's first render.
    readonly hosts: () => Promise<ArrivalHost[]>;
    // Reads one machine's setup directly: the same plan, without the packing.
    readonly scan: (hostId: string) => Promise<ArrivalPlan>;
    readonly apply: (input: ArrivalApply) => Promise<ArrivalReport>;
    readonly abandon: () => Promise<boolean>;
}

// Takes the first bytes off the stream without consuming it, and returns something that replays them. Driven by
// `next()` alone — never `return()` — so `for await` breaking wouldn't destroy the rest of the upload.
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

// First tar entry's name from a gzip prefix; a truncated prefix that never reaches one resolves undefined rather than
// throwing — "not a bundle" is a valid answer from a partial read.
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

// Decides which of the three this is from the bytes, not a filename or a separate route.
// - not gzip → a document (a definition, unless the TOML parser says otherwise)
// - gzip, first entry is the manifest → a bundle
// - gzip, anything else → a packed foreign home
// The bundle writes its manifest first precisely so this is answerable from a prefix.
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

    // Drops the previous hold before the next is held; a spool is a file, so this and `plan` are async.
    const release = async (): Promise<boolean> => {
        const held = pending;
        pending = undefined;
        if (held?.kind === "bundle") {
            await dropSpool(held.held.spool);
        }
        return held !== undefined;
    };

    // Everything a held artifact says about itself, in the one shape the card renders; derived fresh, never stored, so
    // `plan` and `apply` see the same answer.
    const describe = async (held: Held): Promise<Omit<ArrivalPlan, "token">> => {
        if (held.kind === "definition") {
            return {
                source: "definition",
                ...(held.definition.name === undefined ? {} : { name: held.definition.name }),
                items: await definitionItems(services, held.definition),
                // A definition carries secret names, never a value, so there's nothing for the second consent to gate.
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
                // Whatever its owner chose at export; false just means the values aren't in the file.
                carriesSecrets: manifest.secrets,
                refused: [...held.held.index.refused],
                needsAction: bundleActions(manifest, false),
            };
        }
        const planned = assistantPlan(held.setup);
        // Sorted here, not in the browser: a definition and bundle already emit apply order, so a foreign setup gets
        // the same treatment — what the agent will know, run, connect, then its keys.
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
            // Cleared unconditionally: per-item failures are about the target, not the held bytes, and cleared first so
            // a throw below can't strand it.
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
                // A bundle writes manifests this daemon derives state from (capabilities, the approved overlay), so
                // this recomposes here, against this sandbox's own image. The other two sources converge inside their
                // own apply loops.
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
