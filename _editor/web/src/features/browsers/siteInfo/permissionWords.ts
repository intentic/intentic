import type { BrowserPermission } from "@intentic/sandbox-contract/schemas/browser-tools";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// How each permission a site can ask for reads in the prompt and in the site's info: what it lets the site do, and the
// glyph beside it.

export const permissionWords = (permission: BrowserPermission): string => {
    switch (permission) {
        case `notifications`:
            return t(`browsers.tools.permission.notifications`);
        case `geolocation`:
            return t(`browsers.tools.permission.geolocation`);
        case `clipboard-read`:
            return t(`browsers.tools.permission.clipboard`);
        case `camera`:
            return t(`browsers.tools.permission.camera`);
        case `microphone`:
            return t(`browsers.tools.permission.microphone`);
    }
};

export const PERMISSION_ICONS = {
    notifications: `comments`,
    geolocation: `pin`,
    "clipboard-read": `copy`,
    camera: `camera`,
    microphone: `microphone`,
} as const satisfies Readonly<Record<BrowserPermission, IconName>>;

// The ones a person decides here; the sandbox has no camera or microphone to give, and says so instead.
export const DECIDED: readonly BrowserPermission[] = [`notifications`, `geolocation`, `clipboard-read`];

// A site as a person reads it: its host, without the scheme.
export const siteName = (origin: string | undefined): string | undefined => (origin === undefined || !URL.canParse(origin) ? undefined : new URL(origin).host);
