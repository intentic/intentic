import type { WorkspaceSearchFreshness, WorkspaceSearchTag } from "@intentic/sandbox-contract";
import type { RankedGroup, RankedHit } from "../types.js";
import { estimateTokens } from "./budget.js";
import { encodeCursor } from "./cursor.js";

export interface RenderRequest {
    readonly verb: string;
    readonly echo: string;
    // What one hit is called in headers/footers: "matches", "refs", "symbols", "hits", "files", …
    readonly unit: string;
    // "hits" = line-anchored hits per file group; "paths" = one line per file (iq files, iq recent);
    // "plain" = hit text without line prefixes (iq log, iq who, line numbers are synthetic there).
    readonly style: "hits" | "paths" | "plain";
    readonly showTags: boolean;
    readonly groups: readonly RankedGroup[];
    // Groups already delivered by an earlier page, skipped here, but counted in the totals.
    readonly offset: number;
    readonly freshness: WorkspaceSearchFreshness;
    readonly budget: number;
    readonly limit?: number;
    readonly filesOnly?: boolean;
    readonly count?: boolean;
    readonly headerNote?: string;
    readonly hint?: string;
    // Code-graph neighbor lines, rendered (and budget-reserved) like hint.
    readonly related?: readonly string[];
    // Whether the capsule opens with an `answer:` anchor, true for the "where is it" verbs, false where the
    // ranking itself is the answer (path lists, git history, whole-file skeletons).
    readonly lead?: boolean;
    // Whether the top result stands out from the field, when a reranker was there to judge it.
    readonly confidence?: "confident" | "ambiguous";
    // Spool id for continuation cursors; the renderer only formats it, the caller persists the spool.
    readonly cursorId: string;
}

export interface Rendered {
    readonly text: string;
    readonly shownGroups: number;
    readonly shownHits: number;
    readonly truncated: boolean;
    readonly cursor?: string;
    // The paths the candidates line named, so the structured result can report exactly what the text did instead
    // of re-deriving it from a shown-count and drifting the moment the budget rules change.
    readonly candidates?: readonly string[];
    readonly exitCode: 0 | 1;
}

// How many unshown paths the candidates line names, benchmarked, the true answer often sits at rank 5–13,
// invisible behind the packed top groups.
const CANDIDATE_COUNT = 12;
// Ceiling on what the capsule's optional lines may take, so the code they point at still fits beside them.
const CAPSULE_SHARE = 0.5;

const tagText = (tags: readonly WorkspaceSearchTag[]): string =>
    tags.map((tag) => (tag.score === undefined ? `[${tag.kind}]` : `[${tag.kind} ${tag.score.toFixed(2)}]`)).join(" ");

const freshnessText = (freshness: WorkspaceSearchFreshness): string => {
    if (freshness.state === "building") {
        return `index building ${Math.round((freshness.progress ?? 0) * 100)}%`;
    }
    if (freshness.state === "stale") {
        // Naming the lag is the difference between a fact and an alarm: transcript analytics found 69% of answers
        // led with a bare "index stale" while the answer was correct, and text matches are read from disk anyway.
        const behind = freshness.behind ?? 0;
        return behind > 0 ? `index ${behind} files behind (text matches are live)` : "index catching up (text matches are live)";
    }
    return `index fresh (${((freshness.ageMs ?? 0) / 1000).toFixed(1)}s)`;
};

const hitLine = (hit: RankedHit, showTags: boolean, plain: boolean): string => {
    const tags = showTags && hit.tags.length > 0 ? `    ${tagText(hit.tags)}` : "";
    const context = hit.context !== undefined ? `  ⟨in ${hit.context}⟩` : "";
    return plain ? `  ${hit.text}${tags}` : `  ${hit.line}: ${hit.text}${tags}${context}`;
};

const pathLine = (group: RankedGroup, showTags: boolean): string => {
    const tags = showTags ? (group.hits[0]?.tags ?? []) : [];
    // iq recent carries a change summary in the hit text, show it beside the path.
    const summary = group.hits[0] !== undefined && group.hits[0].text !== group.path ? `   ${group.hits[0].text}` : "";
    return `  ${group.path}${summary}${tags.length > 0 ? `    ${tagText(tags)}` : ""}`;
};

const candidateLine = (anchors: readonly string[]): string => `candidates: ${anchors.join(" · ")}`;

const bestHit = (group: RankedGroup): RankedHit | undefined =>
    group.hits.reduce<RankedHit | undefined>((best, hit) => (best === undefined || hit.score > best.score ? hit : best), undefined);

// A candidate names its best hit's line, not just its file. Four more characters buy the one thing that decides
// whether the reader opens the file at the right place or greps it again, and a bare path was the only anchor iq
// ever handed back without a line, in the line-anchored response format the whole tool is built on.
const candidateAnchor = (group: RankedGroup): string => {
    const hit = bestHit(group);
    return hit === undefined ? group.path : `${group.path}:${hit.line}`;
};

// The one line that answers the question: where the top-ranked evidence sits, what symbol encloses it, whether
// it stands out, and which engines agreed. Everything else in the response elaborates on it.
const answerLine = (group: RankedGroup, confidence: RenderRequest["confidence"]): string | undefined => {
    const hit = bestHit(group);
    if (hit === undefined) {
        return undefined;
    }
    const parts = [`${group.path}:${hit.line}`];
    if (hit.context !== undefined) {
        parts.push(hit.context);
    }
    if (confidence !== undefined) {
        parts.push(confidence);
    }
    if (hit.tags.length > 0) {
        parts.push(tagText(hit.tags));
    }
    return `answer: ${parts.join(" · ")}`;
};

// Render ranked groups under a hard token budget. The capsule, answer anchor, graph neighbours, the paths that
// did NOT fit, and the continuation command, is reserved first and printed BEFORE the body, because transcript
// analytics found 90% of answers piped through `head`/`sed`: anything below the code was never read.
export const renderText = (request: RenderRequest): Rendered => {
    const { groups, offset, unit, style } = request;
    const totalHits = style === "paths" ? groups.length : groups.reduce((sum, group) => sum + group.hits.length, 0);
    const totalFiles = groups.length;
    const pending = groups.slice(offset, request.limit !== undefined ? offset + request.limit : undefined);
    // A path list, a commit log and a --files-only sweep already ARE their own candidate map.
    const wantsCandidates = style === "hits" && request.filesOnly !== true && request.count !== true;

    const header = (shown: number, note?: string): string => {
        const scope = style === "paths" ? `${totalHits} ${unit}` : `${totalHits} ${unit} in ${totalFiles} files`;
        const noteText = note !== undefined ? ` · ${note}` : "";
        return `iq: ${request.echo}, ${scope} · ${freshnessText(request.freshness)}${noteText} · showing ${shown}/${totalHits}`;
    };
    const moreLine = (remainingHits: number, remainingFiles: number, cursor: string): string =>
        style === "paths"
            ? `more: ${remainingHits} ${unit}, iq ${request.echo} --after ${cursor}`
            : `more: ${remainingHits} ${unit} in ${remainingFiles} files, iq ${request.echo} --after ${cursor}`;

    // Reserve with worst-case widths so the final assembly can only shrink: the totals are the widest counts, the
    // cursor the widest offset, and the candidates line the longest paths it could possibly name. The header and
    // the continuation command are unconditional, an answer nobody can page through is a dead end.
    const worstCursor = encodeCursor(request.cursorId, offset + pending.length);
    let remaining =
        request.budget - estimateTokens(header(totalHits, request.headerNote)) - estimateTokens(moreLine(totalHits, totalFiles, worstCursor));
    // The capsule must not crowd out the code it describes, so its optional lines share a fraction of the budget
    // and each is admitted only if it fits, in priority order, because a 100-token budget can afford some.
    let allowance = Math.floor(request.budget * CAPSULE_SHARE);
    const admit = (line: string): boolean => {
        const cost = estimateTokens(line);
        if (cost > allowance || cost > remaining) {
            return false;
        }
        allowance -= cost;
        remaining -= cost;
        return true;
    };
    const answer = request.lead === true && pending[0] !== undefined ? answerLine(pending[0], request.confidence) : undefined;
    const leadLine = answer !== undefined && admit(answer) ? answer : undefined;
    const hintLine = request.hint !== undefined && admit(`hint: ${request.hint}`) ? `hint: ${request.hint}` : undefined;
    const worstCandidates = wantsCandidates
        ? pending
              .map(candidateAnchor)
              .toSorted((a, b) => b.length - a.length)
              .slice(0, CANDIDATE_COUNT)
        : [];
    const showCandidates = worstCandidates.length > 0 && admit(candidateLine(worstCandidates));
    const relatedLines = (request.related ?? []).map((line) => `related: ${line}`).filter(admit);

    const groupCap = Math.max(200, Math.floor(request.budget / 6));
    const bodyLines: string[] = [];
    let shownGroups = 0;
    let shownHits = 0;

    for (const group of pending) {
        const lines: string[] = [];
        let groupTokens = 0;
        if (style === "paths") {
            const line = pathLine(group, request.showTags);
            lines.push(line);
            groupTokens = estimateTokens(line);
        } else if (request.filesOnly || request.count) {
            const line = request.count ? `  ${group.path}: ${group.hits.length}` : `  ${group.path} (${group.hits.length})`;
            lines.push(line);
            groupTokens = estimateTokens(line);
        } else {
            const head = `════ ${group.path} (${group.hits.length}) ════`;
            lines.push(head);
            groupTokens = estimateTokens(head);
            for (let i = 0; i < group.hits.length; i++) {
                const hit = group.hits[i]!;
                const line = hitLine(hit, request.showTags, style === "plain");
                const lineTokens = estimateTokens(line);
                const elided = group.hits.length - i;
                if (groupTokens + lineTokens > groupCap && i > 0) {
                    const elision = `     … ${elided} more: iq context ${group.path}:${hit.line}`;
                    lines.push(elision);
                    groupTokens += estimateTokens(elision);
                    break;
                }
                lines.push(line);
                groupTokens += lineTokens;
            }
        }
        if (groupTokens > remaining && shownGroups > 0) {
            break;
        }
        if (groupTokens > remaining) {
            // Not even the first group fits whole: trim its hit lines to the remaining budget.
            const trimmed: string[] = [];
            let used = 0;
            for (const line of lines) {
                const lineTokens = estimateTokens(line);
                if (used + lineTokens > remaining) {
                    break;
                }
                trimmed.push(line);
                used += lineTokens;
            }
            if (trimmed.length === 0) {
                break;
            }
            bodyLines.push(...trimmed);
            remaining -= used;
            shownGroups++;
            shownHits += style === "paths" ? 1 : Math.max(0, trimmed.length - 1);
            break;
        }
        bodyLines.push(...lines);
        remaining -= groupTokens;
        shownGroups++;
        shownHits += style === "paths" ? 1 : Math.min(group.hits.length, lines.length - 1);
    }

    const truncated = offset + shownGroups < groups.length;
    const cursor = truncated ? encodeCursor(request.cursorId, offset + shownGroups) : undefined;
    const shownTotal = style === "paths" ? shownGroups : shownHits;
    const unshown = groups.slice(offset + shownGroups);
    const capsule = [header(shownTotal, request.headerNote)];
    if (leadLine !== undefined) {
        capsule.push(leadLine);
    }
    const candidates = showCandidates ? unshown.slice(0, CANDIDATE_COUNT).map(candidateAnchor) : [];
    if (candidates.length > 0) {
        capsule.push(candidateLine(candidates));
    }
    capsule.push(...relatedLines);
    if (truncated && cursor !== undefined) {
        const remainingHits = style === "paths" ? unshown.length : unshown.reduce((sum, group) => sum + group.hits.length, 0);
        capsule.push(moreLine(remainingHits, unshown.length, cursor));
    }
    if (hintLine !== undefined) {
        capsule.push(hintLine);
    }
    return {
        text: `${[...capsule, ...bodyLines].join("\n")}\n`,
        shownGroups,
        shownHits: shownTotal,
        truncated,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(candidates.length > 0 ? { candidates } : {}),
        exitCode: totalHits > 0 ? 0 : 1,
    };
};
