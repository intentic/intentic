import type { IconName } from "@intentic/ui";
import { computed, type ComputedRef, type Ref, watch } from "vue";
import { z } from "zod";
import { storedValue, storeValue } from "../composables/browserStorage";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* WHAT THE RAIL LOOKED LIKE LAST TIME, SO IT DOESN'T ASSEMBLE ITSELF IN FRONT OF THE READER.
 *
 * The rail's navigation run arrives in waves on every load. The three core tiles are there in the first frame;
 * every extension tile waits for the daemon to be reachable, then for its list of extensions, then for each
 * one's activate() — and the repo-driven ones wait again for /panels to say which repositories exist. A tile
 * does not append when it lands, it takes its RANKED seat (registry.ts), so each wave re-seats everything below
 * it: the run itself, and with it the terminal, the "+" and the account control at the foot of the column. The
 * one piece of chrome a hand aims at from muscle memory is the one piece that moves while it is being aimed at.
 *
 * The composition, though, is the same on every load of the same sandbox — it changes when a repository is added
 * or an extension is switched off, which is rare and deliberate. So the rail is remembered once it is complete,
 * and on the next load the seats it will occupy are held open by dim placeholders. Each tile lights up in its
 * own seat as it wakes, and nothing moves.
 *
 * REMEMBERED, NOT CACHED. Nothing here is read as truth: a ghost is inert, it renders no badge, and it is
 * dropped the moment the live rail is complete, so a tile that has genuinely gone away costs one settle at the
 * end of a load rather than being resurrected. A first-ever visit has nothing remembered and grows as it always
 * did — the one load per browser where there is nothing to know yet.
 *
 * Per sandbox, because a different sandbox has different repositories and therefore a different rail. In
 * localStorage rather than the query cache: it must be readable in the first frame, before anything is
 * restored or connected, which is the entire window this exists to cover. */

// One seat in the rail's navigation run — the identity the shell's AreaTile builds on, and the whole of what is
// worth keeping. A badge is deliberately not kept: it is live state ("3 need you"), and a remembered count is a
// claim that is already stale by the time it is drawn.
export interface RailSeat {
    readonly id: string;
    readonly to: string;
    readonly label: string;
    readonly icon?: IconName;
}

// A seat held open for a tile that has not come back yet. The same shape, flagged — so the rail renders ONE
// list through one template rather than a second run of placeholder markup beside the real one.
export type GhostSeat = RailSeat & { readonly ghost: true };

const asGhost = (seat: RailSeat): GhostSeat => ({ ...seat, ghost: true });

const storageKey = (sandboxId: string | undefined): string => `intentic.railSeats.${sandboxId ?? `local`}`;

// The icon is stored as a plain string and handed back as an `IconName`, exactly as the rail already treats the
// icon an extension names: the icon set renders its fallback for a name it doesn't know, so a glyph renamed
// between builds costs one placeholder its picture, never the seat.
const StoredSeatsSchema = z.array(
    z.object({
        id: z.string(),
        to: z.string(),
        label: z.string(),
        icon: z.string().optional(),
    }),
);

const readSeats = (sandboxId: string | undefined): readonly RailSeat[] => {
    const raw = storedValue(storageKey(sandboxId));
    if (raw === undefined) {
        return [];
    }
    // A payload this build can't read — truncated, or written by a shape that has since changed — is simply not
    // a memory: the rail grows the way it does without one rather than holding seats it can't describe.
    try {
        const parsed = StoredSeatsSchema.safeParse(JSON.parse(raw) as unknown);
        return parsed.success ? (parsed.data as readonly RailSeat[]) : [];
    } catch {
        return [];
    }
};

/* The seats to draw beside the live ones, and the writer that keeps them current.
 *
 * `settled` is "the rail is complete" — every source that can still add a tile has answered. Until it does, the
 * remembered seats the live run has not filled yet are held; after it, there are none, and what is on screen is
 * the record. Note that the ghosts clear THEMSELVES as tiles arrive (a seat with a live tile in it is not a
 * ghost), so `settled` only decides two things: when a seat whose tile is never coming back is finally released,
 * and when the memory is worth overwriting. */
export function useRailMemory(live: Ref<readonly RailSeat[]>, settled: Ref<boolean>): ComputedRef<readonly GhostSeat[]> {
    const { activeSandboxId } = useSandbox();
    const remembered = computed<readonly RailSeat[]>(() => readSeats(activeSandboxId.value));

    // The live run recomputes whenever a BADGE changes — a poll landing a new count, an agent finishing — and
    // that is several times a minute on a busy sandbox. Only the seats are stored, so the payload is identical
    // across all of it; comparing against the last write keeps the memory a write-on-change rather than a
    // write-per-poll. Keyed with the sandbox id so a switch always writes its first payload.
    let written: string | undefined;
    watch(
        [settled, live, activeSandboxId] as const,
        ([isSettled, seats, sandboxId]) => {
            // An empty run can only mean the shell is mid-teardown — the three core tiles are unconditional —
            // and overwriting a good memory with it would cost the next load the very thing this is for.
            if (!isSettled || seats.length === 0) {
                return;
            }
            const key = storageKey(sandboxId);
            const payload = JSON.stringify(seats.map(({ id, to, label, icon }) => ({ id, to, label, ...(icon === undefined ? {} : { icon }) })));
            if (written === `${key}|${payload}`) {
                return;
            }
            written = `${key}|${payload}`;
            storeValue(key, payload);
        },
        { immediate: true },
    );

    return computed<readonly GhostSeat[]>(() => {
        if (settled.value) {
            return [];
        }
        // By route, not by id: one extension can contribute several tiles (a Deployments tile per connection),
        // and they share an id — the route is what tells one of its seats from another.
        const present = new Set(live.value.map((seat) => seat.to));
        return remembered.value.filter((seat) => !present.has(seat.to)).map(asGhost);
    });
}
