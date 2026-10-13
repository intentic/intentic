/** Capture endpoint baked into a desktop release; a trailing slash in POSTHOG_HOST is harmless. */
export const captureUrl = (host: string): string => `${host.replace(/\/$/, ``)}/i/v0/e/`;
