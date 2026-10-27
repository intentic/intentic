import type { Doors } from "../doors";

// What the browser saw (client/sandbox/clientReport.ts posts it): the editor reports its own errors, stalls and
// recoveries to the sandbox, which writes them down. The demo's sandbox writes every one of them down and keeps none.
export const logsDoors = {
    report: ({ events }) => ({ recorded: events.length }),
} satisfies Doors<`logs`>;
