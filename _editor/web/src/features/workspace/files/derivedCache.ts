import { sandboxValue } from "@intentic/extension-api";
import type { WorkspaceDerived } from "@intentic/sandbox-contract";

// What a path's derived text answered last, for the life of this tab. The durable cache is on disk: the daemon keys a
// shadow by the source file's content hash and re-derives only when that hash moves, so a reopened file was never being
// read again. This spares the reader the round trip to that answer, which is what a spinner over an already-rendered
// file looked like. Every hit is revalidated behind the text it paints, so a file that did change corrects itself.
// Sandbox-scoped, since paths collide across sandboxes: a switch makes every entry here another file's.
const remembered = sandboxValue(() => new Map<string, WorkspaceDerived>());

// Bounded by bytes rather than entries: one 512 KiB shadow costs what forty small ones do.
const REMEMBERED_BYTES = 4 * 1024 * 1024;

/** Keeps what a read answered, evicting the oldest once the kept text passes the cap. */
export const rememberDerived = (path: string, derived: WorkspaceDerived): WorkspaceDerived => {
    // Re-inserted, not updated: Map keeps insertion order, and that order is what the eviction below reads as age.
    remembered.value.delete(path);
    remembered.value.set(path, derived);
    let total = 0;
    for (const [key, value] of [...remembered.value].toReversed()) {
        total += value.present ? value.content.length : 0;
        if (total > REMEMBERED_BYTES) {
            remembered.value.delete(key);
        }
    }
    return derived;
};

/** What this path answered last, if it has been read in this tab: what a reopened file paints before the daemon answers. */
export const rememberedDerivedText = (path: string): WorkspaceDerived | undefined => remembered.value.get(path);

// One version of one file that has already had a derivation asked for it. Opening a file derives it rather than
// offering a button, and this pane re-reads often (its text landing, a sweep finishing, the tab reopening): without
// this, a file that legitimately renders to nothing would have the same work spawned for it over and over.
const attempted = sandboxValue(() => new Set<string>());

/** Records an attempt at this version of this file, answering whether it is the first one. */
export const firstDeriveAttempt = (path: string, version: number): boolean => {
    const key = `${version}:${path}`;
    if (attempted.value.has(key)) {
        return false;
    }
    attempted.value.add(key);
    return true;
};

