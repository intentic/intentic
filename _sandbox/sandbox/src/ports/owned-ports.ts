import type { Logger } from "pino";
import { panePids } from "../terminal/terminal-session.js";
import { type ListeningPort, scanListeningPorts, withOwningSessions } from "./port-scan.js";

// Pane listing rides with the scan rather than behind it: both are cheap, and an unowned port is unactionable.
export const scanPortsWith = (logger: Pick<Logger, "warn">) => async (): Promise<ListeningPort[]> => {
    const [listeners, panes] = await Promise.all([
        scanListeningPorts(),
        // The ports list never fails for want of owners: unknown panes leave each port unowned, said in the log.
        panePids().catch((error: Error) => {
            logger.warn({ err: error }, "ports: terminal panes could not be listed, ports show no owning session");
            return new Map<number, string>();
        }),
    ]);
    return withOwningSessions(listeners, panes);
};
