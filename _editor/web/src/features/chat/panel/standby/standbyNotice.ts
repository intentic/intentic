import type { Info } from "@intentic/sandbox-contract/schemas/system";
import { formatDateTime } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

/* A COPY ON STANDBY (2026-11-11). The platform names one machine to run a sandbox; a copy told it is not that machine
 * stands down (the daemon's system/standby/standby.ts) and starts no turn. Its `/info` says so (`standby`: the active
 * host's label and since when), and every chat's strip says it in one line, so a person on this copy (over loopback, on
 * its own machine) learns why nothing here runs and where the sandbox does. Undefined on the active copy and from a
 * daemon older than standby. */
export const standbyNotice = (info: Pick<Info, "standby"> | undefined): string | undefined => {
    const standby = info?.standby;
    if (standby === undefined) {
        return undefined;
    }
    const since = Date.parse(standby.since);
    return t(`chat.chatPaneNotices.standby`, { host: standby.host, since: Number.isNaN(since) ? standby.since : formatDateTime(since) });
};
