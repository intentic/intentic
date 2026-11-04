import { type ClockTime, type NightQuestions, withinNight } from "@intentic/sandbox-contract/schemas/night-hours";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { asZone, UTC } from "@intentic/sandbox-contract/time";

/* WHETHER IT IS THE OWNER'S NIGHT, RIGHT NOW.

   Three things together (settings `nightHours`): the owner switched night hours on, the sandbox's clock is inside the
   window they set, and nobody is at the editor (presence.ts `peopleAtEditor`: a tab on screen somebody touched in the
   last few minutes). The third is what keeps a person who stayed up from having their questions answered for them
   while they sit at the chat: night hours stand in for a person who is asleep, never for one who is there.

   Asked when a turn is planned (its instructions say so) and again as each card night hours may answer is raised and
   while it waits (parked-cards.ts), so a turn begun in the evening stops asking once the night has begun. */

// Night hours in force, as a turn is told them and a card is answered by them.
export interface NightNow {
    // What a question gets: answered with the agent's recommendation, or kept for the morning.
    readonly questions: NightQuestions;
    // When the night ends, on the sandbox's clock.
    readonly until: ClockTime;
}

type NightSettings = Pick<SandboxSettings, "nightHours" | "timezone">;

/** Night hours in force at an instant, from the settings and who is at the editor; undefined when they are not. */
export const nightNow = (settings: NightSettings | undefined, atEditor: readonly string[], at: number): NightNow | undefined => {
    if (settings === undefined || !settings.nightHours.on || atEditor.length > 0) {
        return undefined;
    }
    // An unset zone is UTC, as for every other wall-clock rule here: the row beside the hours says which clock it is.
    const zone = asZone(settings.timezone) ?? UTC;
    return withinNight(settings.nightHours, zone, at) ? { questions: settings.nightHours.questions, until: settings.nightHours.to } : undefined;
};

export interface NightClock {
    // From the last settings read, for a card raised now, which cannot wait on a file: undefined before any read.
    readonly now: () => NightNow | undefined;
}

export interface NightClockDeps {
    readonly read: () => Promise<NightSettings | undefined>;
    // Hears every settings write, so a change the owner just saved is the one the next card is answered by.
    readonly onSet: (listener: () => void) => () => void;
    readonly atEditor: () => readonly string[];
    readonly clock?: () => number;
}

// How old the last read may be before a card asks for a fresh one: a hand edit of settings.json is heard by no write.
const STALE_MS = 60_000;

/** A night clock over a settings snapshot it keeps fresh itself: read on first use, on every write, and once stale. */
export const nightClock = (deps: NightClockDeps): NightClock => {
    const clock = deps.clock ?? Date.now;
    let known: NightSettings | undefined;
    let readAt = Number.NEGATIVE_INFINITY;
    let reading = false;
    // A write heard while a read was already on its way, which that read may predate: read once more after it.
    let again = false;
    let listening = false;
    const refresh = (): void => {
        readAt = clock();
        if (reading) {
            again = true;
            return;
        }
        reading = true;
        void deps
            .read()
            .then((settings) => {
                known = settings ?? known;
            })
            // allow(silent-catch): an unreadable settings file keeps the last snapshot; the next card asks again.
            .catch(() => undefined)
            .finally(() => {
                reading = false;
                if (again) {
                    again = false;
                    refresh();
                }
            });
    };
    return {
        now: () => {
            if (!listening) {
                listening = true;
                deps.onSet(refresh);
            }
            if (clock() - readAt > STALE_MS) {
                refresh();
            }
            return nightNow(known, deps.atEditor(), clock());
        },
    };
};
