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
