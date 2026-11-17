import { morningAfter, nightByHandUntil, type NightHours, withinNight } from "@intentic/sandbox-contract/schemas/night-hours";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { asZone, UTC } from "@intentic/sandbox-contract/time";

/* THE NIGHT THE AGENTS BOARD'S MOON SAYS (BoardNight.vue), read from settings `nightHours` on the sandbox's clock.

   Three states, each with the morning it ends at as an instant, so the board draws it on the reader's own clock:
   - `hours`: inside the owner's night hours. Nothing to end here: those come back every evening, and are changed where
     they are kept (Sandbox ▸ Agent ▸ Finishing). Said first, since a night begun by hand inside them ends with them.
   - `hand`: a night begun by hand whose morning has not come: one press takes it back.
   - `day`: neither; `until` is the morning a night begun now would end at, which the press offering it says.

   Nobody being at the editor is the daemon's half of the rule (agent/night/night-hours.ts), left out here: the reader
   is at the editor, by definition, and the board says what will hold once they leave it. */

export type BoardNight =
    | { readonly kind: `hours`; readonly until: number }
    | { readonly kind: `hand`; readonly until: number; readonly since: number }
    | { readonly kind: `day`; readonly until: number };

type NightSettings = Pick<SandboxSettings, `nightHours` | `timezone`>;

/** The night the board shows at an instant. */
export const boardNight = (settings: NightSettings, at: number): BoardNight => {
    const hours = settings.nightHours;
    // An unset zone is UTC, as the daemon reads it.
    const zone = asZone(settings.timezone) ?? UTC;
    if (hours.on && withinNight(hours, zone, at)) {
        return { kind: `hours`, until: morningAfter(hours, zone, at) };
    }
    const byHand = nightByHandUntil(hours, zone, at);
    if (byHand !== undefined && hours.asleepSince !== undefined) {
        return { kind: `hand`, until: byHand, since: hours.asleepSince };
    }
    return { kind: `day`, until: morningAfter(hours, zone, at) };
};

/** Night hours with a night begun at `at`: the whole object, since settings are written whole. */
export const beginNight = (hours: NightHours, at: number): NightHours => ({ ...hours, asleepSince: at });

/** Night hours with the night begun by hand taken back, and nothing else changed. */
export const endNight = (hours: NightHours): NightHours => {
    const { asleepSince: _ended, ...rest } = hours;
    return rest;
};
