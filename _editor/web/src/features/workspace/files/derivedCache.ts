import type { WorkspaceDerived } from "@intentic/sandbox-contract";

// What a path's derived text answered last, for the life of this tab. The durable cache is on disk: the daemon keys a
// shadow by the source file's content hash and re-derives only when that hash moves, so a reopened file was never being
// read again. This spares the reader the round trip to that answer, which is what a spinner over an already-rendered
// file looked like. Every hit is revalidated behind the text it paints, so a file that did change corrects itself.
// A module of its own, and deliberately free of the rpc client: the live-change store resets it, and must not have to
// load a daemon connection to do so.
const remembered = new Map<string, WorkspaceDerived>();

// Bounded by bytes rather than entries: one 512 KiB shadow costs what forty small ones do.
const REMEMBERED_BYTES = 4 * 1024 * 1024;

/** Keeps what a read answered, evicting the oldest once the kept text passes the cap. */
export const rememberDerived = (path: string, derived: WorkspaceDerived): WorkspaceDerived => {
    // Re-inserted, not updated: Map keeps insertion order, and that order is what the eviction below reads as age.
    remembered.delete(path);
    remembered.set(path, derived);
    let total = 0;
    for (const [key, value] of [...remembered].toReversed()) {
        total += value.present ? value.content.length : 0;
        if (total > REMEMBERED_BYTES) {
            remembered.delete(key);
        }
    }
    return derived;
};

/** What this path answered last, if it has been read in this tab: what a reopened file paints before the daemon answers. */
export const rememberedDerivedText = (path: string): WorkspaceDerived | undefined => remembered.get(path);

/** Drops every remembered shadow. Paths collide across sandboxes, so switching one makes all of them another file's. */
export const forgetDerivedText = (): void => remembered.clear();
