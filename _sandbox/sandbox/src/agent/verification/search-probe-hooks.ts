import { isAbsolute, resolve } from "node:path";
import type { HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { type ProbeHit, type ProbeLabels, type ProbeOptions, probeNote, probeRgSearch, type RgSearch } from "@intentic/text-search";
import { z } from "zod";
import { fromWorktree, inWorktree, type TurnPlacement } from "../../conversations/worktrees/isolation.js";
import { namespaceTargetOf, nsenterArgv } from "../../workload/namespace-entry.js";
import { namedHook, type TurnHookList } from "../run/hook-timing.js";

// After a Grep that found nothing, what one changed switch would have found (@intentic/text-search's probes): any case,
// gitignored files, the pattern as plain text. A bare zero sends an agent through casing variants one call at a time;
// this names the cause and the files in the same result. Shell searches get the same line from the output filter
// (output-cleaners' search-probes.mjs), which covers every provider whose shell runs through the terminal panel.

// Claude Code's Grep runs rg with --hidden and these left out (its GrepTool, read from the 0.3.332 CLI: `--hidden
// --no-follow --glob !.git …`). Every probe keeps them, so the ignored probe asks only about gitignored files.
const GREP_EXCLUDED = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

// Named in Grep's own switches, since Grep has no plain-text mode and never searches a gitignored file.
const GREP_LABELS = {
    case: 'case-insensitive ("-i": true)',
    ignored: "in gitignored files, which Grep skips (rg -u in Bash searches them)",
    literal: "as literal text (escape the regex metacharacters)",
} as const satisfies ProbeLabels;

const GrepInputSchema = z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional(),
    type: z.string().optional(),
    "-i": z.boolean().optional(),
    multiline: z.boolean().optional(),
    offset: z.number().optional(),
});
type GrepInput = z.infer<typeof GrepInputSchema>;

// Whether Grep found nothing at all: no files and no lines, and not because its own clock ran out. A rendered answer is
// read by its words.
const FoundNothingSchema = z.union([
    z
        .object({ numFiles: z.number(), content: z.string().optional(), timedOut: z.boolean().optional() })
        .transform((output) => output.numFiles === 0 && (output.content ?? "").trim() === "" && output.timedOut !== true),
    z.string().transform((text) => /^No (?:files|matches) found/.test(text.trim())),
]);

// Grep's glob field split as Grep splits it: on whitespace, then on commas outside a brace group.
const globsOf = (glob: string | undefined): string[] =>
    (glob ?? "")
        .split(/\s+/)
        .flatMap((part) => (part.includes("{") && part.includes("}") ? [part] : part.split(",")))
        .filter((part) => part !== "");

// The Grep call as an rg search, in the names the agent used.
const grepSearch = (input: GrepInput, cwd: string): RgSearch => ({
    cwd,
    pattern: input.pattern,
    paths: input.path === undefined || input.path === "" ? undefined : [isAbsolute(input.path) ? input.path : resolve(cwd, input.path)],
    flags: [
        ...GREP_EXCLUDED.flatMap((dir) => ["--glob", `!${dir}`]),
        ...(input.multiline === true ? ["-U", "--multiline-dotall"] : []),
        ...(input.type === undefined || input.type === "" ? [] : ["--type", input.type]),
        ...globsOf(input.glob).flatMap((glob) => ["--glob", glob]),
    ],
    ignoreCase: input["-i"] === true,
    hidden: true,
});

// Where the probe runs, settled per turn as the edit checks settle theirs (agent-diagnostics.ts): for a turn with a
// namespace of its own, rg enters it and is asked in the agent's own names; an isolated turn without one is asked in
// its worktree's names and answered back in the agent's; an unisolated one is asked as it is.
interface PlacedSearch {
    readonly search: RgSearch;
    readonly options: ProbeOptions;
    // A listed path in the agent's own names.
    readonly named: (path: string) => string;
}

const placed = (search: RgSearch, placement: TurnPlacement | undefined): PlacedSearch => {
    const anchor = placement?.anchor;
    if (anchor !== undefined) {
        const enter = (command: string, args: readonly string[]) => nsenterArgv(namespaceTargetOf(anchor), search.cwd, command, args);
        return { search, options: { enter }, named: (path) => path };
    }
    const plan = placement?.plan;
    const mapped = { ...search, cwd: inWorktree(search.cwd, plan), paths: search.paths?.map((path) => inWorktree(path, plan)) };
    return { search: mapped, options: {}, named: (path) => (isAbsolute(path) ? fromWorktree(path, plan) : path) };
};

export type SearchProbe = (search: RgSearch, options: ProbeOptions) => Promise<ProbeHit[]>;

const said = (context: string | undefined): HookJSONOutput =>
    context === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } };

// PostToolUse on Grep: silent unless it found nothing and a probe finds something. A paged call (`offset`) can come back
// empty past its last page, so it is left alone.
export const searchProbeHooks = (placement?: TurnPlacement, probe: SearchProbe = probeRgSearch): TurnHookList => ({
    PostToolUse: [
        {
            matcher: "Grep",
            hooks: [
                namedHook("empty-grep", async (input, _id, { signal }) => {
                    if (input.hook_event_name !== "PostToolUse" || FoundNothingSchema.safeParse(input.tool_response).data !== true) {
                        return {};
                    }
                    const grep = GrepInputSchema.safeParse(input.tool_input).data;
                    if (grep === undefined || (grep.offset ?? 0) > 0) {
                        return {};
                    }
                    const at = placed(grepSearch(grep, input.cwd), placement);
                    const hits = await probe(at.search, { ...at.options, signal });
                    return said(probeNote(hits.map((hit) => ({ ...hit, examples: hit.examples.map(at.named) })), GREP_LABELS));
                }),
            ],
        },
    ],
});
