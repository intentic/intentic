import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "@intentic/base/errors";
import { APPROVAL_ID, digestOf, mediaDir, OPERATION_FILE, type Operation, operationBlock, OperationSchema, sha256 } from "./guard.js";

// What an approved act will send, read ONCE into memory and held to the yes: the operation and every file copy from the
// item's own media folder, the digest recomputed over exactly those bytes, and the approval card checked to have shown
// exactly this operation. Whatever is sent afterwards is these bytes, so nothing written to the workspace between the
// check and the office call can change it. Runs in the backend, on what the daemon handed over (server/perform.ts).

// A refusal: the act did not happen and nothing reached the office.
export class Refused extends Error {
    constructor(message: string) {
        super(message);
        this.name = "Refused";
    }
}

export interface LoadedFile {
    readonly name: string;
    readonly bytes: Uint8Array;
}

export interface LoadedOperation {
    readonly operation: Operation;
    readonly digest: string;
    readonly files: readonly LoadedFile[];
}

// What the daemon vouches for: the item's id, the digest the yes pinned and the details the person read.
export interface ApprovalClaim {
    readonly id: string;
    readonly digest: string;
    readonly details: string;
}

// A regular file inside `folder`, read without following a link: a copy swapped for a symlink to anything else in the
// sandbox is refused rather than sent to an office.
const readCopy = async (folder: string, name: string): Promise<Uint8Array> => {
    const handle = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: Error) => {
        throw new Refused(`the approved copy ${name} cannot be read (${errnoCode(error) ?? error.message})`);
    });
    try {
        if (!(await handle.stat()).isFile()) {
            throw new Refused(`the approved copy ${name} is not a plain file`);
        }
        return new Uint8Array(await handle.readFile());
    } finally {
        await handle.close();
    }
};

export const loadApproved = async (root: string, claim: ApprovalClaim): Promise<LoadedOperation> => {
    if (!APPROVAL_ID.test(claim.id)) {
        throw new Refused(`"${claim.id}" is not an e-urzad approval id`);
    }
    const folder = mediaDir(await realpath(root), claim.id);
    const real = await realpath(folder).catch((error: Error) => {
        throw new Refused(`approval ${claim.id} has no operation on record (${errnoCode(error) ?? error.message})`);
    });
    if (real !== folder) {
        throw new Refused(`approval ${claim.id}'s folder resolves elsewhere (a symlink?)`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(await readCopy(folder, OPERATION_FILE)));
    } catch (error) {
        throw error instanceof Refused ? error : new Refused(`approval ${claim.id}'s operation is not JSON`);
    }
    const parsed = OperationSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Refused(`approval ${claim.id}'s operation is not one this version carries out (it may predate the approval boundary; propose it again)`);
    }
    const operation = parsed.data;
    const files: LoadedFile[] = [];
    for (const file of operation.files) {
        const bytes = await readCopy(folder, file.file);
        if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
            throw new Refused(`the approved file ${file.name} changed after it was approved`);
        }
        files.push({ name: file.name, bytes });
    }
    const digest = digestOf(operation);
    if (digest !== claim.digest) {
        throw new Refused(`approval ${claim.id} no longer matches the operation that was approved`);
    }
    if (!claim.details.includes(operationBlock(operation, digest))) {
        throw new Refused(`approval ${claim.id} did not show this exact operation when it was approved`);
    }
    return { operation, digest, files };
};
