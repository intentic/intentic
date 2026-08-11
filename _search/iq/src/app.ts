import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { ast } from "./commands/ast.command.js";
import { context } from "./commands/context.command.js";
import { def } from "./commands/def.command.js";
import { loadConfig } from "./env.config.js";
import { files } from "./commands/files.command.js";
import { find } from "./commands/find.command.js";
import { hotspots } from "./commands/hotspots.command.js";
import { indexCommand } from "./commands/index-cmd/index-cmd.routes.js";
import { version } from "./lib/version.js";
import { log } from "./commands/log.command.js";
import { map } from "./commands/map.command.js";
import { multi } from "./commands/multi.command.js";
import { outline } from "./commands/outline.command.js";
import { q } from "./commands/q.command.js";
import { recent } from "./commands/recent.command.js";
import { refs } from "./commands/refs.command.js";
import { sessionsCommand } from "./commands/sessions/sessions.routes.js";
import { sym } from "./commands/sym.command.js";
import { who } from "./commands/who.command.js";

// Agents read errors as one line, not a stack. IQ_DEBUG keeps the stack for humans chasing a bug.
const formatException = (exc: unknown): string => {
    if (exc instanceof Error) {
        return loadConfig().iqDebug ? (exc.stack ?? exc.message) : exc.message;
    }
    return String(exc);
};

// The agent-facing contract, kept under ~400 tokens — this is what `iq --help` prints.
const HELP = `One search tool, intent-first. A bare query auto-detects intent, fuses engines, and answers
natural language semantically — there is no second verb for questions:
  iq "where do we enforce the secrets floor?"

  iq find 'createServer\\(' --lang ts      text/regex match (--literal --word --case)
  iq files wkignore                       file by fuzzy name (--exact for globs)
  iq def createIgnoreScope                where a symbol is defined
  iq refs createIgnoreScope --kind call   who uses a symbol (call|import|type|write)
  iq sym 'Workspace*Schema' --kind type   symbols by name pattern
  iq ast 'await $FN($$$)' --lang ts       structural AST pattern
  iq outline src/app.ts                   file skeleton without reading it
  iq context src/app.ts:48                enclosing function of an anchor
  iq map --budget 4000                    repo skeleton: top files + their exports
  iq hotspots --in src                    churn × complexity — where risk sits
  iq recent --since 2d                    recently changed files
  iq log "MAX_MATCHES" --path src         git history of a string
  iq who src/app.ts:15                    blame an anchor
  iq multi "def foo" "refs bar"           several queries, one spawn (or one per stdin line)
  iq sessions files "auth refresh"        files past sessions touched for a topic

Read the first lines and stop: every answer opens with a capsule — \`answer:\` names the top
path:line, its enclosing symbol and whether the top result is confident or ambiguous;
\`candidates:\` names the ranked paths that did not fit; \`more:\` gives the exact --after command.
The code follows below it, so \`head\` never cuts the part that matters. Natural-language answers
carry the top hits' full enclosing bodies — read those instead of re-opening the file.

Output fits --budget (default 1500 tokens). Scope: --in <dir|file> --repo <name> --lang ts,py
--glob/--not-glob --only tests|src|docs|config --ignored (secrets floor never lifts).
Exit codes: 0 hits, 1 none, 2 error. The index self-manages — iq index rebuild only if stale.

Paths may be cwd-relative, absolute, or workspace-relative; one that matches nothing is an error,
not an empty result. Inferred/grep habits are absorbed (search→q, skeleton→outline,
--include/--path/--max/--top/-k), and find reruns invalid patterns or zero-hit prose in the mode that can
answer them — the header names what actually ran.`;

export const app = buildApplication(
    buildRouteMap({
        routes: {
            q,
            find,
            files,
            def,
            refs,
            sym,
            ast,
            outline,
            context,
            map,
            hotspots,
            recent,
            log,
            who,
            multi,
            index: indexCommand,
            sessions: sessionsCommand,
        },
        defaultCommand: "q",
        docs: { brief: "iq — agent-native workspace search", fullDescription: HELP },
    }),
    {
        name: "iq",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        determineExitCode: () => 2,
        localization: { loadText: (locale) => (locale.startsWith("en") ? { ...text_en, formatException } : undefined) },
    },
);
