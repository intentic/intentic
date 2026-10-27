import { workspaceContract } from "@intentic/sandbox-contract/contracts/workspace.contract";
import type { Fence } from "@intentic/sandbox-contract/policy/fence-paths";
import { includeGlobs } from "@intentic/sandbox-contract/policy/search-globs";
import type { WorkspaceSearchQuery, WorkspaceSearchResult } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import type { PerfFields } from "../system/resources/perf.js";
import { searchPaths } from "./layout/workspace-fence.js";
import { streamText, type TextAnswer, type TextQuery } from "./text-search.js";
import { workspaceReads } from "./workspace-reads.js";

// The workspace's search routes: text search (`mode` find) answered by ripgrep from the daemon itself (text-search.ts),
// every other kind by the resident iq engine. Beside workspace.routes.ts rather than in it: router.ts merges them into
// the `workspace` group.
//
// Every search, either way, leaves a `workspace.search` perf line when it is slow (system/resources/perf.ts), naming
// which path answered and where its time went: the scan, a kept answer, or the engine (and whether that was cold or
// queued). A streamed search is held open, so the request timer never sees it; this line is how it is measured.

// Row cap for one /workspace/search page, sized to the virtualized list's visible rows.
const GUI_SEARCH_HITS = 1_000;
const GUI_SEARCH_FILES = 300;
// Token budget for the paths named in a zero-hit hint; nothing else reads it.
const GUI_SEARCH_BUDGET = 2_000;

// What one search asks, read once for both paths: the caller's fence met with the folder it named, the include box's
// globs, the switches.
interface SearchPlan {
    readonly verb: NonNullable<WorkspaceSearchQuery["mode"]>;
    readonly dir: string;
    readonly ignored: boolean;
    readonly paths: readonly string[] | undefined;
    readonly globs: readonly string[];
    readonly notGlobs: readonly string[];
    readonly literal: boolean;
    readonly word: boolean;
    readonly caseSensitive: boolean;
    readonly page: { readonly hits: number; readonly files: number };
}

// The index covers the whole tree, so a fenced caller searching it would get snippets out of folders they cannot open:
// the scope is narrowed to the caller's folders before the query runs, and a folder outside them runs over nothing.
const planOf = (input: WorkspaceSearchQuery, fence: Fence): SearchPlan => {
    // One subtree, normalized the way the engine's own prefix filter normalizes it, so the scope and the echo below
    // cannot disagree about the same folder.
    const dir = (input.dir ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
    const { globs, notGlobs } = includeGlobs(input.include);
    return {
        verb: input.mode ?? "q",
        dir,
        ignored: input.includeIgnored === true,
        paths: searchPaths(fence, dir),
        globs,
        notGlobs,
        literal: input.literal === true,
        word: input.word === true,
        caseSensitive: input.caseSensitive === true,
        page: { hits: GUI_SEARCH_HITS, files: Math.min(input.limit ?? GUI_SEARCH_FILES, GUI_SEARCH_FILES) },
    };
};

// The literal `iq` command a GUI search stands for. It mirrors the CLI's own flag order (echoOf in iq/lib/flags) and
// seeds the engine's cursor id, so it must stay byte-stable for the same query + mode + scope: two searches that echo
// alike page as one.
const echoOf = (plan: SearchPlan, query: string): string =>
    [
        `${plan.verb === "q" ? "" : `${plan.verb} `}"${query}"`,
        ...(plan.dir === "" ? [] : [`--in '${plan.dir}'`]),
        ...(plan.ignored ? ["--ignored"] : []),
        ...(plan.literal ? ["--literal"] : []),
        ...(plan.word ? ["--word"] : []),
        ...(plan.caseSensitive ? ["--case"] : []),
        ...plan.globs.map((glob) => `--glob '${glob}'`),
        ...plan.notGlobs.map((glob) => `--not-glob '${glob}'`),
    ].join(" ");

// A switch as the engine's request carries it: present only when on, as the CLI's own flags are.
const flag = (on: boolean): true | undefined => (on ? true : undefined);
const nonEmpty = (globs: readonly string[]): readonly string[] | undefined => (globs.length === 0 ? undefined : globs);

const textQueryOf = (root: string, plan: SearchPlan, input: WorkspaceSearchQuery): TextQuery => ({
    root,
    query: input.query,
    literal: plan.literal,
    word: plan.word,
    caseSensitive: plan.caseSensitive,
    ignored: plan.ignored,
    paths: plan.paths,
    globs: plan.globs,
    notGlobs: plan.notGlobs,
    page: plan.page,
    after: input.after,
});

// What every search's perf line carries: the shape of the ask (never its words) and of the answer.
const fieldsOf = (plan: SearchPlan, input: WorkspaceSearchQuery, result: WorkspaceSearchResult | undefined): PerfFields => ({
    mode: plan.verb,
    page: input.after === undefined ? "first" : "more",
    ignored: plan.ignored,
    scoped: plan.paths !== undefined,
    globs: plan.globs.length + plan.notGlobs.length,
    literal: plan.literal,
    queryChars: input.query.length,
    files: result?.files,
    total: result?.total,
    partial: result?.partial === true,
});

const textFieldsOf = (answer: TextAnswer | undefined): PerfFields => ({
    path: "text",
    kept: answer?.timing.kept,
    scanMs: answer?.timing.scanMs === undefined ? undefined : Math.round(answer.timing.scanMs),
    firstMs: answer?.timing.firstMs === undefined ? undefined : Math.round(answer.timing.firstMs),
    ceiling: answer?.timing.ceiling,
});

// What the search routes reach: the caller's fence, the shared tree's root, both searches and the perf recorder.
type SearchServices = Pick<Services, "areas" | "agents" | "workspaceScope" | "workspace" | "iq" | "textSearch" | "perf">;

export const createWorkspaceSearchRoutes = (services: SearchServices) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    const { fenceFor } = workspaceReads(services);
    const record = (from: number, fields: PerfFields, failed: boolean): void =>
        services.perf.record("workspace.search", performance.now() - from, fields, failed);

    // Runs the resident iq engine (in its own child process, minus the per-query spawn and sweep). A GUI caller asks for
    // a `list` page (rows), skipping the capsule, symbol lookup and continuation spool.
    const engineSearch = async (plan: SearchPlan, input: WorkspaceSearchQuery, signal: AbortSignal | undefined): Promise<WorkspaceSearchResult> => {
        const from = performance.now();
        // Read before the ask: a child that has not swept yet (just started, or started again after resting) pays that
        // first, and a busy query worker queues the semantic half behind its own work.
        const before = services.iq.metrics();
        const engine: PerfFields = {
            path: "engine",
            engineCold: !before.revalidated,
            queryQueue: before.queryWorker.pendingRequests,
            embedBacklog: before.embedBacklog,
        };
        const options = { ...opt("literal", flag(plan.literal)), ...opt("word", flag(plan.word)), ...opt("caseSensitive", flag(plan.caseSensitive)) };
        try {
            const outcome = await services.iq.run(
                {
                    verb: plan.verb,
                    query: input.query,
                    scope: {
                        ...opt("ignored", flag(plan.ignored)),
                        ...opt("paths", plan.paths),
                        ...opt("globs", nonEmpty(plan.globs)),
                        ...opt("notGlobs", nonEmpty(plan.notGlobs)),
                    },
                    render: { budget: GUI_SEARCH_BUDGET, list: plan.page, ...opt("after", input.after) },
                    options,
                    echo: echoOf(plan, input.query),
                },
                signal,
            );
            record(from, { ...fieldsOf(plan, input, outcome.result), ...engine }, false);
            return outcome.result;
        } catch (error) {
            record(from, { ...fieldsOf(plan, input, undefined), ...engine }, true);
            throw error;
        }
    };

    const textSearch = async (plan: SearchPlan, input: WorkspaceSearchQuery, signal: AbortSignal | undefined): Promise<WorkspaceSearchResult> => {
        const from = performance.now();
        try {
            const answer = await services.textSearch.find(textQueryOf(services.workspace.root, plan, input), signal);
            record(from, { ...fieldsOf(plan, input, answer.result), ...textFieldsOf(answer), stream: false }, false);
            return answer.result;
        } catch (error) {
            record(from, { ...fieldsOf(plan, input, undefined), ...textFieldsOf(undefined), stream: false }, true);
            throw error;
        }
    };

    return {
        search: i.search.handler(async ({ input, signal, context }) => {
            const plan = planOf(input, await fenceFor(context));
            return plan.verb === "find" ? await textSearch(plan, input, signal) : await engineSearch(plan, input, signal);
        }),
        // The text search a search box runs, its files sent as they are found and then its first page; a later page
        // comes from `search` with the cursor that page carries.
        searchStream: i.searchStream.handler(async function* ({ input, signal, context }) {
            const plan = planOf(input, await fenceFor(context));
            if (plan.verb !== "find") {
                throw new ORPCError("BAD_REQUEST", { message: "only a text search (mode find) streams; ask /workspace/search for the others" });
            }
            const from = performance.now();
            let answered: TextAnswer | undefined;
            try {
                yield* streamText(services.textSearch, textQueryOf(services.workspace.root, plan, input), signal, (answer) => {
                    answered = answer;
                });
            } finally {
                // Left before its answer (the box typed on) is not a failure: the scan was stopped on purpose.
                record(
                    from,
                    { ...fieldsOf(plan, input, answered?.result), ...textFieldsOf(answered), stream: true, left: answered === undefined },
                    false,
                );
            }
        }),
    };
};
