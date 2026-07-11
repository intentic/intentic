import type { AstroIntegration } from "astro";

/** Per-page OpenGraph image generation (satori + resvg) on `astro:build:done`. */
export function ogImages(): AstroIntegration;

export interface IndexNowOptions {
    key: string;
    enabled?: boolean;
    siteUrl?: string;
    cacheDir?: string;
    waitForPublicKeyFile?: boolean;
    publicKeyCheckTimeoutMs?: number;
    publicKeyCheckIntervalMs?: number;
    submissionRetryCount?: number;
    submissionRetryDelayMs?: number;
}

/** Submit changed pages to the IndexNow API after each build. */
export function indexnow(options?: IndexNowOptions): AstroIntegration;

/** ISO `lastmod` for a sitemap URL from git history, or null if unavailable. */
export function lastModForUrl(url: string): string | null;
