import type { BundleExport } from "@intentic/sandbox-contract/schemas/environment";
import type { RawJsonOutput } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { refuse } from "@intentic/contract-serve";
import { gzipSync, strToU8 } from "fflate";
import { DEMO_SANDBOX_NAME } from "./definition";

// Exports of this sandbox as the Move out panel lists them (the daemon's bundles: a tar.gz packed in the background,
// read back off the export directory): a press starts one that fills in as it packs, the list polls it to ready, a ticket
// opens its download, and deleting it takes it off the list.

const MB = 1024 * 1024;
// What the whole bundle weighs once packed, and how long packing takes here: long enough to watch the bytes climb.
const PACKED_BYTES = 61.4 * MB;
const PACK_MS = 14_000;
const TICKET_MS = 60_000;

interface Packing {
    readonly name: string;
    readonly secrets: boolean;
    readonly startedAt: number;
}

const ready: BundleExport[] = [];
const packing = new Map<string, Packing>();
const tickets = new Map<string, string>();

// A packing export's bytes so far: the tar grows fastest at first (the workspace's files), slower through history.
const packedSoFar = (job: Packing, now: number): number => Math.round(PACKED_BYTES * Math.sqrt(Math.min(1, (now - job.startedAt) / PACK_MS)));

// Finished ones are moved to `ready` when read past their end, which is when the real list first sees the .tar.gz.
const settle = (now: number): void => {
    for (const job of packing.values()) {
        if (now - job.startedAt >= PACK_MS) {
            packing.delete(job.name);
            ready.unshift({ name: job.name, status: `ready`, bytes: PACKED_BYTES + (job.secrets ? 18_432 : 0), createdAt: job.startedAt + PACK_MS, secrets: job.secrets });
        }
    }
};

export const bundleExports = (): BundleExport[] => {
    const now = Date.now();
    settle(now);
    const live: BundleExport[] = [...packing.values()].map((job) => ({
        name: job.name,
        status: `packing`,
        bytes: packedSoFar(job, now),
        createdAt: now,
        secrets: job.secrets,
    }));
    return [...live, ...ready];
};

// Timestamped like the daemon's own names, so two exports a minute apart never collide.
const stamp = (at: number): string => new Date(at).toISOString().replace(/[-:]/g, ``).replace(/\.\d+Z$/, `Z`);

/** Starts an export, refused while another is packing as the daemon refuses a second one. */
export const startBundle = (secrets: boolean): RawJsonOutput<`POST /bundles`> => {
    settle(Date.now());
    if (packing.size > 0) {
        return refuse(`an export is already being packed; wait for it to finish`, 409);
    }
    const startedAt = Date.now();
    const name = `${DEMO_SANDBOX_NAME}-${stamp(startedAt)}${secrets ? `-with-secrets` : ``}.tar.gz`;
    packing.set(name, { name, secrets, startedAt });
    return { name };
};

const known = (name: string): boolean => packing.has(name) || ready.some((entry) => entry.name === name);

export const removeBundle = (name: string): RawJsonOutput<`DELETE /bundles`> => {
    if (!known(name)) {
        return refuse(`no export by that name`, 404);
    }
    packing.delete(name);
    const at = ready.findIndex((entry) => entry.name === name);
    if (at !== -1) {
        ready.splice(at, 1);
    }
    return { ok: true };
};

export const bundleTicket = (name: string): RawJsonOutput<`POST /bundles/ticket`> => {
    settle(Date.now());
    if (!ready.some((entry) => entry.name === name)) {
        return refuse(`that export is not ready to download`, 404);
    }
    const ticket = `bt_${crypto.randomUUID().replaceAll(`-`, ``)}`;
    tickets.set(ticket, name);
    return { ticket, expiresAt: Date.now() + TICKET_MS };
};

// One file in a ustar archive: a 512-byte header, then the bytes padded to a whole block.
const tarEntry = (path: string, body: Uint8Array): Uint8Array => {
    const header = new Uint8Array(512);
    const write = (at: number, text: string): void => header.set(strToU8(text), at);
    write(0, path);
    write(100, `0000644\0`);
    write(108, `0000000\0`);
    write(116, `0000000\0`);
    write(124, `${body.byteLength.toString(8).padStart(11, `0`)}\0`);
    write(136, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, `0`)}\0`);
    write(148, `        `);
    write(156, `0`);
    write(257, `ustar\0`);
    write(263, `00`);
    const sum = header.reduce((total, byte) => total + byte, 0);
    write(148, `${sum.toString(8).padStart(6, `0`)}\0 `);
    const padded = new Uint8Array(Math.ceil(body.byteLength / 512) * 512);
    padded.set(body);
    const entry = new Uint8Array(512 + padded.byteLength);
    entry.set(header);
    entry.set(padded, 512);
    return entry;
};

/** The export's bytes for the ticket's download: a real gzipped tar, carrying the manifest a bundle opens with. */
export const bundleDownload = (name: string, ticket: string): Response => {
    if (tickets.get(ticket) !== name) {
        return refuse(`that download link has expired; start the download again`, 401);
    }
    const manifest = strToU8(
        JSON.stringify({ version: 3, sandbox: { name: `intentic-sandbox-${DEMO_SANDBOX_NAME}` }, createdAt: Date.now(), secrets: name.includes(`-with-secrets`) }, null, 2),
    );
    const archive = [...tarEntry(`manifest.json`, manifest), ...new Uint8Array(1024)];
    return new Response(gzipSync(new Uint8Array(archive)), {
        headers: { "content-type": `application/gzip`, "content-disposition": `attachment; filename="${name}"` },
    });
};
