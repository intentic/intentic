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
