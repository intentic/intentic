import { workspaceContract } from "@intentic/sandbox-contract/contracts/workspace.contract";
import type { Fence } from "@intentic/sandbox-contract/policy/fence-paths";
import { includeGlobs } from "@intentic/sandbox-contract/policy/search-globs";
import type { WorkspaceSearchQuery, WorkspaceSearchResult } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import type { PerfFields } from "../system/resources/perf.js";
import { searchPaths } from "./layout/workspace-fence.js";
import { type FileQuery, streamText, type TextAnswer, type TextQuery } from "./text-search.js";
import { workspaceReads } from "./workspace-reads.js";

// The workspace's search routes: text search (`mode` find, and `q`, its older name) and file-name search (`mode` files),
// both answered by ripgrep from the daemon itself (text-search.ts). Beside workspace.routes.ts rather than in it:
// router.ts merges them into the `workspace` group.
//
// Every search leaves a `workspace.search` perf line when it is slow (system/resources/perf.ts), naming which search
// answered and where its time went: the scan or a kept answer. A streamed search is held open, so the request timer
// never sees it; this line is how it is measured.

// Row cap for one /workspace/search page, sized to the virtualized list's visible rows.
const GUI_SEARCH_HITS = 1_000;
const GUI_SEARCH_FILES = 300;

// What one search asks, read once for both searches: the caller's fence met with the folder it named, the include box's
// globs, the switches.
interface SearchPlan {
    readonly verb: "find" | "files";
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

// A search walks the whole tree, so a fenced caller would get snippets out of folders they cannot open: the scope is
// narrowed to the caller's folders before the query runs, and a folder outside them runs over nothing.
const planOf = (input: WorkspaceSearchQuery, fence: Fence): SearchPlan => {
    // One subtree, normalized the way the search's own prefix filter normalizes it.
    const dir = (input.dir ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
    const { globs, notGlobs } = includeGlobs(input.include);
    return {
        // `q` is an older editor's name for the text search.
        verb: input.mode === "files" ? "files" : "find",
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

const fileQueryOf = (root: string, plan: SearchPlan, input: WorkspaceSearchQuery): FileQuery => ({
    root,
    query: input.query,
    ignored: plan.ignored,
    paths: plan.paths,
    globs: plan.globs,
    notGlobs: plan.notGlobs,
    limit: plan.page.files,
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
type SearchServices = Pick<Services, "areas" | "agents" | "workspaceScope" | "workspace" | "textSearch" | "perf">;

export const createWorkspaceSearchRoutes = (services: SearchServices) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    const { fenceFor } = workspaceReads(services);
    const record = (from: number, fields: PerfFields, failed: boolean): void =>
        services.perf.record("workspace.search", performance.now() - from, fields, failed);

    const filesSearch = async (plan: SearchPlan, input: WorkspaceSearchQuery, signal: AbortSignal | undefined): Promise<WorkspaceSearchResult> => {
        const from = performance.now();
        try {
            const result = await services.textSearch.files(fileQueryOf(services.workspace.root, plan, input), signal);
            record(from, { ...fieldsOf(plan, input, result), path: "files" }, false);
            return result;
        } catch (error) {
            record(from, { ...fieldsOf(plan, input, undefined), path: "files" }, true);
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
            return plan.verb === "find" ? await textSearch(plan, input, signal) : await filesSearch(plan, input, signal);
        }),
        // The text search a search box runs, its files sent as they are found and then its first page; a later page
        // comes from `search` with the cursor that page carries.
        searchStream: i.searchStream.handler(async function* ({ input, signal, context }) {
            const plan = planOf(input, await fenceFor(context));
            if (plan.verb !== "find") {
                throw new ORPCError("BAD_REQUEST", { message: "only a text search (mode find) streams; ask /workspace/search for file names" });
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
