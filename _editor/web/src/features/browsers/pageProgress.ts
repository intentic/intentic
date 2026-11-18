import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type Ref } from "vue";
import { useLineWithElapsed } from "../../components/progress/useProgress";

// What a browser's address bar says while its page is on its way, said again here because the picture is the page alone:
// the host the navigation waits on and for how long. Without it, a click that sent a page to a host that never answered
// looked like a click that did nothing, for as long as the connection took to time out (2026-11-18). It reads off the
// daemon's page record; a daemon from before that field says nothing. The tab's own glyph is stripTab.ts pageTabLook.

const hostOf = (url: string): string => {
    try {
        const host = new URL(url).host;
        return host === `` ? url : host;
    } catch {
        // allow(silent-catch): an address with no host (a data: or about: page) is named as written.
        return url;
    }
};

/** "Waiting for host… · 12s" while the page's navigation is in flight, the line a browser shows at its foot; undefined otherwise. */
export const useNavigationLine = (page: Ref<BrowserPage | undefined>): ComputedRef<string | undefined> => {
    const navigation = computed(() => page.value?.navigation);
    const line = computed(() => {
        const going = navigation.value;
        return going === undefined ? undefined : t(`browsers.browsers.waitingFor`, { host: hostOf(going.url) });
    });
    return useLineWithElapsed(line, () => navigation.value?.since);
};
