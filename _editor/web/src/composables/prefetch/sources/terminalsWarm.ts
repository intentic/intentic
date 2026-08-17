import { fetchTerminals, terminalsKey } from "../../terminal/terminalsQuery";
import { useLayout } from "../../useLayout";
import type { WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";

/* WHAT IS RUNNING IN THIS SANDBOX — one list, wanted at two very different distances.
 *
 * The terminal panel remembers whether it was open PER SANDBOX, so switching to a sandbox that was left with its
 * terminals showing draws the panel immediately and then has nothing to put in it: the sessions are a tunnel
 * round trip away, and that gap is the whole of the panel's restoring state. Asking for the list as part of the
 * switch is what closes it — the panel's own read goes through this same entry, so it either finds the answer
 * sitting there or joins the read already in flight.
 *
 * Hence the two bands. With the panel OPEN this is `now`: the list is not somewhere the user might go, it is the
 * thing on their screen, and the strip cannot draw a single tab without it. With the panel closed it is `rail`,
 * beside the other things behind an icon — the rail's terminal badge counts off this same entry, so warming it
 * there costs a cache lookup per beat and keeps the count honest on a window whose first paint beat the badge.
 *
 * There is no second entry for the panel to read: the badge, the background-process rows and the strip are all
 * one cache entry by construction (terminal/terminalsQuery.ts), which is what makes warming it worth anything. */

export const terminalsWarmSource = (): readonly WarmTask[] => [
    warmQuery(`terminals:list`, useLayout().terminalOpen.value ? `now` : `rail`, { queryKey: terminalsKey, queryFn: fetchTerminals }),
];
