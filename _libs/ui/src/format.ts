// Human-readable byte size for the breadcrumb / file-info chips. Empty string when the size is unknown.
export const formatBytes = (bytes: number | undefined): string => {
    if (bytes === undefined) {
        return ``;
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = [`KB`, `MB`, `GB`, `TB`];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

// Token counts, at the width a chip or a summary line can spare: "1.4M" past a million, "142k" once thousands
// are reached, the exact number below that. The same rounding wherever tokens are quoted (context meter,
// per-account usage, cleaner savings, the fleet board's per-agent counts), so two surfaces quoting the same
// number never disagree about it — which is what a second copy in agentStatus.ts had quietly stopped being
// true: it carried the megabyte tier this one lacked, so a 1.5M-token agent read "1500k" on one screen and
// "1.5M" on the next.
export const formatTokens = (tokens: number): string =>
    tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);

// Coarse "time since" for activity/log/history rows: "just now" under a minute, "Nm ago"/"Nh ago" within a
// day, else the absolute local timestamp. Distinct on purpose from chat's compact `relativeTime` (no "ago",
// adds a day tier) — different surfaces want different formats.
export const timeAgo = (at: number): string => {
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) {
        return `just now`;
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    if (minutes < 60 * 24) {
        return `${Math.round(minutes / 60)}h ago`;
    }
    return new Date(at).toLocaleString();
};
