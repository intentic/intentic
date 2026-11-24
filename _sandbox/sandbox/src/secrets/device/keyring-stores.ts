import { rm } from "node:fs/promises";
import { KeyringPointerSchema, KeyringPublicKeySchema, KeyringRememberSchema } from "@intentic/sandbox-contract/schemas/keyring";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { writeJsonFile } from "../../store/json-file.js";
import { openDocument } from "../../store/open-document.js";

// What this sandbox keeps of the keyrings on the owner's computers, every file under the auth root (0600):
// - what each computer's keyring last said: the entries it shares here, names and rules only, never a value, so an
//   offline computer's secrets still list, and the keys this sandbox pinned for it the first time it heard them;
// - the `copy` entries, kept as ordinary secrets (sealed at rest where the sandbox has an at-rest key);
// - the values released for one use each, kept a few minutes only so the terminal's output filter can mask them
//   (released-values).

// One computer's keyring as last heard. `keyring` is its state the last time it answered; `pinned` its keys as first
// heard, which a typing or an inbox item is sealed to and which a keyring reporting different ones does not replace
// unasked (keyring-link.ts says when it does).
const HeardSchema = z.object({
    pointers: z.array(KeyringPointerSchema),
    keyring: z
        .object({
            version: z.string(),
            locked: z.boolean(),
            pendingInbox: z.number().int().nonnegative(),
            // Which sources the person lets that keyring remember from (absent from one older than 2026-10-19): a sandbox
            // terminal's capture and the phone's are sent only where theirs is on.
            remember: KeyringRememberSchema.optional(),
        })
        .optional(),
    pinned: z.object({ seal: KeyringPublicKeySchema, inbox: KeyringPublicKeySchema, at: z.number() }).optional(),
    heardAt: z.number(),
});
export type HeardKeyring = z.infer<typeof HeardSchema>;

// Connection id (`rog`, `rog::wsl:archlinux`: each OS install runs a keyring of its own) -> what its keyring said.
export const keyringDevicesDocument = defineDocument({ root: "auth", path: "keyring-devices.json", schema: HeardSchema, granularity: "record" });

export interface KeyringBook {
    readonly all: () => Promise<Readonly<Record<string, HeardKeyring>>>;
    readonly set: (machine: string, heard: HeardKeyring) => Promise<void>;
}

export const fileKeyringBook = (path: string): KeyringBook => {
    const file = openDocument(keyringDevicesDocument, path, { fallback: (): Record<string, HeardKeyring> => ({}), mode: 0o600 });
    return {
        all: () => file.read(),
        set: async (machine, heard) => {
            await file.update((current) => ({ ...current, [machine]: heard }));
        },
    };
};

// name -> value: a keyring entry shared in `copy` mode, opened with this sandbox's key and kept here, so it resolves like
// any sandbox secret with the computer off. The terminal filter reads it raw (SECRET_STORES), so its layout is fixed.
export const keyringCopiesDocument = defineDocument({ root: "auth", path: "keyring-copies.json", schema: z.string(), granularity: "record" });

export interface KeyringCopies {
    readonly all: () => Promise<Readonly<Record<string, string>>>;
    // Replaces the whole set at once: what the keyrings shared in copy mode, less what they stopped sharing.
    readonly change: (change: (current: Readonly<Record<string, string>>) => Readonly<Record<string, string>>) => Promise<void>;
}

export const fileKeyringCopies = (path: string): KeyringCopies => {
    const file = openDocument(keyringCopiesDocument, path, {
        fallback: (): Record<string, string> => ({}),
        mode: 0o600,
        // A fresh store over an unreadable one would drop every copy, which the next refresh brings back anyway; refused
        // all the same, like the sandbox's own secrets, so an at-rest key gone missing is said rather than papered over.
        onUnreadable: "refuse",
        atRestPurpose: keyringCopiesDocument.path,
    });
    return {
        all: () => file.read(),
        change: async (change) => {
            await file.update((current) => {
                const next = change(current);
                return next === current ? current : { ...next };
            });
        },
    };
};

// The released values' file name, which the terminal filter's SECRET_STORES lists beside the other stores.
export const RELEASED_VALUES_FILE = "keyring-released.json";

// Values a computer's keyring released for one use each, for masking and nothing else. In memory for the daemon's own
// masking; the ones a process was handed (a shell's, a script's) also written whole to a file only the terminal's output
// filter reads, a separate process that cannot ask the daemon, in the flat layout it reads every store in (sealed at
// rest under the same rule as the sandbox's own secrets). Never read back: the daemon's memory is the record, so the file
// is rewritten from it on every change and once as the daemon starts. (2026-11-24) Each is dropped from both once its
// use has had RELEASED_MASK_MS to print what it prints: every value a computer released was kept, in the clear in
// memory and on disk, for the daemon's whole life, a store of one-use values any later reader of the auth root could
// open. A value typed into a browser or a window prints nowhere the filter reads, so it is never written. Resolution
// never reads any of it (secret-access.ts).
const RELEASED_MASK_MS = 10 * 60_000;

// Where a released value went, as keyring-link-types.ts names a release's lane.
export type ReleaseLane = "shell" | "code" | "browser" | "desktop";

export interface ReleasedDeviceValues {
    readonly add: (name: string, value: string, lane: ReleaseLane) => void;
    // The values still masked, none past its window.
    readonly all: () => Readonly<Record<string, string>>;
    // Rewrites the file from this process's memory, which drops whatever an earlier process left in it: called once as
    // the daemon starts.
    readonly reset: () => Promise<void>;
}

interface Released {
    readonly value: string;
    readonly until: number;
    // Whether the terminal's filter reads it: a process was handed it.
    readonly filed: boolean;
}

export const releasedDeviceValues = (
    path: string,
    warn: (message: string, error: Error) => void,
    clock: { readonly now?: () => number; readonly keepMs?: number } = {},
): ReleasedDeviceValues => {
    const now = clock.now ?? Date.now;
    const keepMs = clock.keepMs ?? RELEASED_MASK_MS;
    const values = new Map<string, Released>();
    // Writes queue behind each other, so the file ends as the last change left memory; with nothing to mask it goes.
    let writing: Promise<void> = Promise.resolve();
    const write = (): void => {
        const snapshot = Object.fromEntries([...values].flatMap(([name, held]) => (held.filed ? [[name, held.value] as const] : [])));
        writing = writing
            .then(() => (Object.keys(snapshot).length === 0 ? rm(path, { force: true }) : writeJsonFile(path, snapshot, 0o600, false, RELEASED_VALUES_FILE)))
            .catch((error: Error) => warn("keyring: the released values could not be written for the terminal's masking", error));
    };
    // Drops every value past its window, and rewrites the file when the filter was reading one of them.
    const expire = (): void => {
        const at = now();
        let filed = false;
        for (const [name, held] of values) {
            if (held.until <= at) {
                values.delete(name);
                filed ||= held.filed;
            }
        }
        if (filed) {
            write();
        }
    };
    return {
        add: (name, value, lane) => {
            const before = values.get(name);
            const filed = lane === "shell" || lane === "code";
            values.set(name, { value, until: now() + keepMs, filed });
            setTimeout(expire, keepMs + 1).unref();
            if (filed || before?.filed === true) {
                write();
            }
        },
        all: () => {
            expire();
            return Object.fromEntries([...values].map(([name, held]) => [name, held.value]));
        },
        reset: async () => {
            await writing;
            expire();
            write();
            await writing;
        },
    };
};
