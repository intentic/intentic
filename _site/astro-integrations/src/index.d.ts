import type { AstroIntegration } from "astro";

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

export interface GitStats {
    /** Commits reachable from HEAD. */
    total: number;
    /** How many of them an agent authored. */
    agent: number;
    /** The agent share as a whole percentage. */
    share: number;
    /** First commit date, YYYY-MM-DD. */
    since: string;
}

/** Commit counts from git at build time, or null when the clone is shallow or git is unavailable. */
export function gitStats(): GitStats | null;

export interface ScorecardCheck {
    name: string;
    /** 0-10, or -1 where the check did not apply. */
    score: number;
}

export interface Scorecard {
    /** Overall score, 0-10, one decimal. */
    score: number;
    checks: ScorecardCheck[];
    /** The date the published scan ran, YYYY-MM-DD. */
    date: string;
    /** The public report card behind the number. */
    url: string;
}

/** The published OpenSSF Scorecard for this repository, or null when the API cannot be read at build time. */
export function scorecard(): Promise<Scorecard | null>;

export interface LatestRelease {
    /** The release version, without the tag's `v` prefix. */
    version: string;
    /** The day it was published, YYYY-MM-DD. */
    date: string;
    /** The release page, where its notes are. */
    notes: string;
}

/** The newest published release, or null when the API cannot be read at build time. */
export function latestRelease(): Promise<LatestRelease | null>;

/**
 * Downloads in the last month for each named npm package, keyed by name. A package resolves to null when the
 * registry cannot be read at build time, so one bad name costs only its own figure.
 */
export function npmDownloads(names: readonly string[]): Promise<Record<string, number | null>>;

export interface SearchBlock {
    /** Section heading, or "" for the prose above the first one. */
    heading: string;
    /** The id the renderer gave that heading, or "" when there is none to link to. */
    anchor: string;
    text: string;
}

export interface SearchEntry {
    url: string;
    title: string;
    /** Shelf label, so a result can say which part of the docs it is from. */
    section: string;
    blurb: string;
    blocks: SearchBlock[];
}

export interface DocsSearchPage {
    url: string;
    title: string;
    section: string;
    blurb: string;
}

/** Split one rendered documentation page into heading-led blocks. */
export function blocksFromPage(html: string): SearchBlock[];

/** Assemble the search index from pages and a source of each page's rendered HTML. */
export function docsSearchIndex(pages: DocsSearchPage[], htmlFor: (page: DocsSearchPage) => string | undefined): SearchEntry[];

/** Write dist/search.json from the documentation pages that were just built. */
export function docsSearch(options: { pages: DocsSearchPage[] }): AstroIntegration;
