import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Services } from "../composition.js";
import { stateRelPath } from "../state-paths.js";
import { readDocument } from "@intentic/sandbox-contract/documents";
import { CHECK_SETTLES } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { recordManifestProblems } from "../store/manifest-problems.js";

// The workspace's stable identity at <workspace>/.intentic/identity/workspace.json, minted at the first boot of an
// empty /work and surviving with the volume. Streamed as the /events hello frame so the browser can tell a
// wiped-and-recreated workspace (same sandbox id after cleanup.sh + reconnect) from a surviving one and drop
// its persisted query cache. Minted only when the file is absent: one this build cannot read is reported and never
// written over, since a new id would tell every browser the workspace was wiped when it was not.
// ponytail: two racing first connections may each mint an id; last write wins and the loser only costs one
// extra browser cache purge.
const WorkspaceIdentitySchema = z.object({ id: z.string().min(1) });
export const workspaceIdentityDocument = defineDocument({ path: stateRelPath(".intentic/identity/workspace.json"), schema: WorkspaceIdentitySchema });

// What stands in for an id the file holds but this build cannot read: the same for as long as the bytes stay the same,
// so a browser purges its cache once, not on every connection.
const unreadableId = (text: string): string => `unreadable-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

export interface IdentitySeams {
    readonly files: Pick<Services["files"], "read" | "write">;
    readonly workspace: Pick<Services["workspace"], "root">;
}

export const workspaceIdentity = async (services: IdentitySeams): Promise<string> => {
    const path = join(services.workspace.root, workspaceIdentityDocument.path);
    const text = await services.files.read(path);
    if (text === undefined) {
        const id = randomUUID();
        await services.files.write(path, `${JSON.stringify({ id }, undefined, 2)}\n`);
        recordManifestProblems(path, []);
        return id;
    }
    const read = readDocument(text, workspaceIdentityDocument, { kind: "whole", parse: (raw) => WorkspaceIdentitySchema.safeParse(raw).data }, CHECK_SETTLES);
    recordManifestProblems(path, read.problems);
    return read.value === undefined ? unreadableId(text) : read.value.id;
};
