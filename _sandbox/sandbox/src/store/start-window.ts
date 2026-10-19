import { z } from "zod";
import { defineDocument } from "./evolution/documents.js";
import { openDocument } from "./open-document.js";

// THE HOURLY CEILINGS ON TURNS NOBODY ASKED FOR, kept on disk: how many turns a conversation's `agents message` started
// elsewhere (conversations/recall/fleet-message.ts) and how many a link's tasks started here (links/link-tasks.ts). Held
// in memory, each daemon start handed out a fresh hour, so two agents messaging each other got a new budget per boot and
// a crash loop was never capped at all. A start is booked by rewriting this small file, which costs one write per turn
// started: nothing beside a turn's own start. The per-minute windows on public doors stay in memory (rate-window.ts):
// forgetting a minute costs less than a write per request.

const HOUR_MS = 3_600_000;

// When each scope started a turn, by scope key (`peer:<sender>`, `link:<id>`), only the stamps still inside the window.
const StartsSchema = z.object({ starts: z.record(z.string(), z.array(z.number())) });
type Starts = z.infer<typeof StartsSchema>;

export const turnStartsDocument = defineDocument({ root: "history", path: "turn-starts.json", schema: StartsSchema });

export interface StartWindow {
    // Books one start against `key` when fewer than `max` fell inside the window; false, and nothing booked, when it is
    // full. Check and book are one write, so two starts at once cannot both slip under the ceiling.
    readonly spend: (key: string, max: number, now: number) => Promise<boolean>;
}

// Every scope's stamps still inside the window; a scope left with none is dropped, so the file stays the size of the hour.
const inWindow = (starts: Starts["starts"], now: number, windowMs: number): Starts["starts"] =>
    Object.fromEntries(
        Object.entries(starts)
            .map(([key, stamps]) => [key, stamps.filter((at) => now - at < windowMs)] as const)
            .filter(([, recent]) => recent.length > 0),
    );

export const fileStartWindow = (path: string, windowMs: number = HOUR_MS): StartWindow => {
    const file = openDocument<typeof turnStartsDocument, Starts>(turnStartsDocument, path, { fallback: () => ({ starts: {} }) });
    return {
        spend: async (key, max, now) => {
            let spent = false;
            await file.update((stored) => {
                const starts = inWindow(stored.starts, now, windowMs);
                const recent = starts[key] ?? [];
                spent = recent.length < max;
                return { starts: spent ? { ...starts, [key]: [...recent, now] } : starts };
            });
            return spent;
        },
    };
};
