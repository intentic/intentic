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

export interface LlmsTextSection {
    label: string;
    /** Canonical pathnames, in reading order. */
    paths: string[];
}

export interface LlmsTextOptions {
    name: string;
    /** One line, rendered as the llms.txt blockquote. */
    summary: string;
    details?: string;
    /** Grouping and order for the index; anything built but unlisted lands under "More". */
    sections?: LlmsTextSection[];
}

/** Write /llms.txt, /llms-full.txt and a Markdown mirror of every indexable page. */
export function llmsText(options: LlmsTextOptions): AstroIntegration;

/** ISO `lastmod` for a sitemap URL from git history, or null if unavailable. */
export function lastModForUrl(url: string): string | null;
