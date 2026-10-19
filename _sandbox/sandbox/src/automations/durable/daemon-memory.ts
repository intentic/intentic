import type { Services } from "../../composition.js";

// What the automation dispatchers keep in memory (fire lanes, listener batchers, chore queues, what the inboxes carry),
// one copy per daemon, found by its automations store. A process runs one daemon, so in production there is one copy,
// as when these were module singletons. A restart test runs a second daemon on the same history beside the first, and
// that one starts with nothing of the first's in memory, exactly as a restarted process does.
export const perDaemon = <T>(make: () => T) => {
    const copies = new Map<Services["automations"], T>();
    return {
        of: (services: Pick<Services, "automations">): T => {
            const found = copies.get(services.automations);
            if (found !== undefined) {
                return found;
            }
            const made = make();
            copies.set(services.automations, made);
            return made;
        },
        all: (): readonly T[] => [...copies.values()],
    };
};
