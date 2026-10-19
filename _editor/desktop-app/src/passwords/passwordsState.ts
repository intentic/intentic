import type { PasswordsPort } from "@intentic/ext-passwords/app";
import { computed, ref } from "vue";
import type { LocalView } from "@intentic/web/local-host";
import { tauriPasswordsPort } from "./tauriPort";

type ViewBadge = NonNullable<LocalView[`badge`]>[`value`];

// THE PASSWORDS VIEW'S ONE PORT, and what its rail tile says while the reader is elsewhere (host.ts): the requests
// agents are waiting on and the passwords saved since they were last looked at. The page's own reads keep the counts
// current while it is open; elsewhere they are read once a minute while the window is on screen, since each read
// starts the machine agent.

const fresh = ref(0);
const requests = ref(0);
let port: PasswordsPort | undefined;

/** The port the page mounts the app with: this computer's, its list and requests counted as they are read. */
export const passwordsPort = (): PasswordsPort => {
    if (port === undefined) {
        const inner = tauriPasswordsPort();
        port = {
            ...inner,
            list: async () => {
                const items = await inner.list();
                fresh.value = items.filter((item) => item.fresh).length;
                return items;
            },
            requests: async () => {
                const waiting = await inner.requests();
                requests.value = waiting.length;
                return waiting;
            },
        };
    }
    return port;
};

/** Requests are owed an answer, so they are the tile's call; fresh captures only an inventory to look at. */
export const passwordsBadge = computed((): ViewBadge | undefined => {
    if (requests.value > 0) {
        return { count: requests.value + fresh.value, tone: `info` };
    }
    return fresh.value > 0 ? { count: fresh.value, tone: `neutral` } : undefined;
});

const BADGE_MS = 60_000;
let following = false;

/** Started once per window by its host: the counts read now, then once a minute while the window is on screen. */
export const followPasswords = (): void => {
    if (following) {
        return;
    }
    following = true;
    const read = async (): Promise<void> => {
        if (document.visibilityState !== `visible`) {
            return;
        }
        const own = passwordsPort();
        try {
            const status = await own.status();
            if (status.kind === `ready`) {
                await Promise.all([own.list(), own.requests()]);
            }
        } catch {
            // allow(silent-catch): a tile with nothing to say says nothing; the page itself shows why when opened
        }
    };
    void read();
    setInterval(() => void read(), BADGE_MS);
};
