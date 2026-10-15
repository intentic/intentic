import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isInside } from "@intentic/base/contained";
import { undefinedIfMissing } from "@intentic/base/errors";
import { envSuffix } from "@intentic/sandbox-contract/capability-env";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { type ActionRow, emptySnapshot, type SavedFile, type Snapshot, SnapshotSchema } from "./snapshot.js";

// Where one connected card's office material lands in the workspace: .intentic/records/e-urzad/<card>/. The records
// group is what happened (kept, backed up, never served publicly), which is what an office's received deliveries,
// downloaded documents and proofs are. Files are written once and never replaced: a second save of the same bytes is
// the same file, a different file under the same name gets its own content-addressed name.

const RECORDS_FOLDER = "e-urzad";

// The directory name for a card: its env suffix, lowercased, which is the one spelling the CLI (reading suffixed env
// vars) and the view (reading card ids) can both derive.
const recordKey = (card: string): string => envSuffix(card).toLowerCase();

export const recordsDir = (root: string, card: string): string => join(root, STATE_GROUP_DIR.records, RECORDS_FOLDER, recordKey(card));

const safeName = (name: string): string => {
    const cleaned = name
        .normalize("NFC")
        .replaceAll(/[^\p{L}\p{N}._ -]/gu, "_")
        .replaceAll(/\.{2,}/g, "_")
        .replace(/^[.\s]+/, "")
        .slice(-120);
    return cleaned === "" ? "file.bin" : cleaned;
};

const MAX_ACTIONS = 200;

export class OfficeRecords {
    readonly directory: string;

    constructor(
        private readonly root: string,
        readonly card: string,
        private readonly service: Snapshot["service"],
    ) {
        this.directory = recordsDir(root, card);
    }

    private async inside(directory: string): Promise<string> {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const actual = await realpath(directory);
        const workspace = await realpath(this.root);
        if (actual !== resolve(directory) || !isInside(workspace, actual)) {
            throw new Error("the records directory resolves outside the workspace (a symlink?); nothing was written");
        }
        return actual;
    }

    // Saves bytes under <card>/<folder>/, answering the workspace-relative path and the SHA-256.
    async save(folder: readonly string[], name: string, bytes: Uint8Array): Promise<SavedFile> {
        const directory = await this.inside(join(this.directory, ...folder.map(safeName)));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const plain = join(directory, safeName(name));
        const existing = await readFile(plain).catch(undefinedIfMissing);
        const path = existing === undefined || createHash("sha256").update(existing).digest("hex") === sha256 ? plain : join(directory, `${sha256.slice(0, 12)}-${safeName(name)}`);
        if (existing === undefined || path !== plain) {
            await writeFile(path, bytes, { mode: 0o600 });
        }
        return { path: relative(this.root, path).split(sep).join("/"), sha256, bytes: bytes.byteLength };
    }

    async snapshot(): Promise<Snapshot> {
        const raw = await readFile(join(this.directory, "snapshot.json"), "utf8").catch(undefinedIfMissing);
        if (raw === undefined) {
            return emptySnapshot(this.card, this.service);
        }
        const parsed = SnapshotSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : emptySnapshot(this.card, this.service);
    }

    async update(change: (current: Snapshot) => Snapshot): Promise<Snapshot> {
        const directory = await this.inside(this.directory);
        const next = change(await this.snapshot());
        const target = join(directory, "snapshot.json");
        const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(next, undefined, 2)}\n`, { mode: 0o600 });
        await rename(temporary, target);
        return next;
    }

    async recordAction(action: ActionRow): Promise<void> {
        await this.update((current) => ({ ...current, actions: [action, ...current.actions].slice(0, MAX_ACTIONS) }));
    }
}
