// The kit's formatters, reachable without the component barrel: `index.ts` pulls in every .vue component, which breaks
// an extension's node-environment tests that have no Vue plugin to parse SFCs with. A source-level door for in-repo
// extensions and their tests; a git-installed bundle resolves through the import map instead, which carries the same
// names.
export {
    formatBytes,
    formatDate,
    formatDateTime,
    formatDayMonth,
    formatTime,
    formatTimestamp,
    formatTokens,
    formatWeekdayTime,
    freshness,
    timeAgo,
} from "@intentic/ui/format";
