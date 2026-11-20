import type { BrowserPermission, PermissionSetting, SitePermissions } from "@intentic/sandbox-contract/schemas/browser-tools";
import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import { errorMessage } from "@intentic/base/errors";
import { computed, ref, type Ref, shallowRef } from "vue";
import type { WindowToolsSeams } from "../windowTools";

// The padlock's popover (SiteInfo.vue): how the page in front is reached, what its site may do in this window's
// profile, and clearing what the site keeps. Read afresh each time it opens, since a page's asks change it meanwhile.

// The site a page belongs to, as permissions are kept for it; none for anything but a web page.
export const siteOf = (url: string | undefined): string | undefined => {
    if (url === undefined || !URL.canParse(url)) {
        return undefined;
    }
    const parsed = new URL(url);
    return parsed.protocol === `https:` || parsed.protocol === `http:` ? parsed.origin : undefined;
};

export const useSiteInfo = (seams: WindowToolsSeams, window: Ref<string | undefined>, page: Ref<BrowserPage | undefined>) => {
    const open = ref(false);
    const anchor = ref<HTMLElement | undefined>();
    const site = shallowRef<SitePermissions | undefined>();
    const error = ref<string | undefined>();
    const origin = computed(() => siteOf(page.value?.url));

    // Runs one call about the site in front, its failure said in the popover.
    const about = async (work: (name: string, at: string) => Promise<void>): Promise<void> => {
        const name = window.value;
        const at = origin.value;
        if (name === undefined || at === undefined) {
            return;
        }
        error.value = undefined;
        try {
            await work(name, at);
        } catch (caught) {
            error.value = errorMessage(caught);
        }
    };
    const read = (): Promise<void> =>
        about(async (name, at) => {
            site.value = await seams.browser.site({ name, origin: at });
        });

    return {
        open,
        anchor,
        origin,
        site,
        error,
        show: (from: HTMLElement): void => {
            anchor.value = from;
            open.value = !open.value;
            site.value = undefined;
            if (open.value) {
                void read();
            }
        },
        set: (permission: BrowserPermission, setting: PermissionSetting): Promise<void> =>
            about(async (name, at) => {
                const location = setting === `allow` && permission === `geolocation` ? await seams.locate() : undefined;
                await seams.browser.setSitePermission(
                    location === undefined ? { name, origin: at, permission, setting } : { name, origin: at, permission, setting, location },
                );
                site.value = await seams.browser.site({ name, origin: at });
            }),
        clear: (): Promise<void> =>
            about(async (name, at) => {
                await seams.browser.clearSiteData({ name, origin: at });
                open.value = false;
            }),
    };
};

export type SiteInfoTools = ReturnType<typeof useSiteInfo>;
