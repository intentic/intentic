import { buildApplication, buildRouteMap } from "@stricli/core";
import { cacheCommand } from "./commands/cache.command.js";
import { crawlCommand } from "./commands/crawl.command.js";
import { fetchCommand } from "./commands/fetch.command.js";
import { version } from "./lib/version.js";

// The agent-facing contract, kept small — this is what `webq --help` prints.
const HELP = `Web pages as clean markdown, built for an agent's context window.

  webq fetch <url>                        one page: capsule + budgeted markdown on stdout, whole page saved to a file
  webq fetch <url> --query "rate limits"  keep only the blocks relevant to a question
  webq fetch <url> --raw                  whole page, no chrome-pruning
  webq crawl <url> --max-pages 30         bounded same-site crawl: a file per page + index.md
  webq crawl <url> --query "webhooks"     best-first: links about the query are visited first
  webq cache [--clear]                    the shared fetch cache

Every fetch is cached for 15 minutes (--fresh bypasses, --max-age tunes), so parallel agents and repeated
runs stop paying the network. JS-heavy pages render in the image's Chromium automatically when the static
HTML is an empty app shell (--browser never|force overrides); without the browser pack webq says so and
serves the static HTML. Crawls obey robots.txt (--ignore-robots is on you), stay on the start origin
(--external follows out), and report every skipped-URL count — a capped crawl never poses as a complete one.

Read the capsule first: title · final URL · token cost · fit/raw · cache|network|browser. The saved file
carries front matter (url, title, fetched_at) so it stays self-describing when found later.
Exit codes: 0 content, 1 none (HTTP error / empty crawl), 2 broken invocation.`;

export const app = buildApplication(
    buildRouteMap({
        routes: {
            fetch: fetchCommand,
            crawl: crawlCommand,
            cache: cacheCommand,
        },
        defaultCommand: "fetch",
        docs: { brief: "webq, agent-native web fetch: URLs as clean budgeted markdown", fullDescription: HELP },
    }),
    {
        name: "webq",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        determineExitCode: () => 2,
    },
);
