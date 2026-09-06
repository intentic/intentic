/* The kit's formatters, reachable WITHOUT the component barrel.
 *
 * `index.ts` pulls every .vue component in the kit, which is the right trade for an extension's own views but
 * the wrong one for its pure logic: a day-divider label is plain arithmetic on a number, and an extension's
 * node-environment tests run without a Vue plugin to parse SFCs with. Importing a formatter from the barrel
 * dragged the whole component library into those tests and broke them on the first `<template>` it hit. Same
 * split, and same reason, as `@intentic/ui`'s own `./path` and `./time` entry points.
 *
 * A SOURCE-level door, for in-repo extensions (whose code vite compiles into the app bundle) and their tests.
 * A git-installed bundle resolves its bare specifiers through the import map in index.html, which carries the
 * barrel alone, so nothing is exported here that the barrel does not also export, and a third-party author
 * reaching for `@intentic/extension-ui` is missing none of it. */
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
