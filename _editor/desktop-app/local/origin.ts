// Where the local face's platform stand-in answers (platform.ts), spelled once. The page's window.env names it by a
// slot (local.html) that vite.local.config.ts fills as the page is served and built. The vite config loads this module
// in node, so it touches nothing of a page. `.invalid` never resolves: a call that slipped past the stand-in fails
// rather than reaching a server.

export const LOCAL_PLATFORM_ORIGIN = `https://platform.local.invalid`;

export const PLATFORM_ORIGIN_SLOT = `%LOCAL_PLATFORM_ORIGIN%`;

export const withPlatformOrigin = (html: string): string => html.replaceAll(PLATFORM_ORIGIN_SLOT, LOCAL_PLATFORM_ORIGIN);
