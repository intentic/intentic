import type { WorkspaceSearchFreshness, WorkspaceSearchTag } from "@intentic/sandbox-contract";
import type { RankedGroup, RankedHit } from "../types.js";
import { estimateTokens } from "./budget.js";
import { encodeCursor } from "./cursor.js";

export interface RenderRequest {
    readonly verb: string;
    readonly echo: string;
    // Word for one hit in headers/footers: "matches", "refs", "hits", …
    readonly unit: string;
    // "hits": per-file line-anchored hits; "paths": one line per file; "plain": hit text, no line prefixes.
    readonly style: "hits" | "paths" | "plain";
    readonly showTags: boolean;
    readonly groups: readonly RankedGroup[];
    // Groups already sent in an earlier page; skipped here but counted in the totals.
    readonly offset: number;
    readonly freshness: WorkspaceSearchFreshness;
    readonly budget: number;
    readonly limit?: number;
    readonly filesOnly?: boolean;
    readonly count?: boolean;
    readonly headerNote?: string;
    readonly hint?: string;
    // Code-graph neighbor lines; rendered and budgeted like hint.
    readonly related?: readonly string[];
    // True if the capsule opens with an `answer:` anchor; false where the ranking itself is the answer.
    readonly lead?: boolean;
    // Whether the top result clearly stands out, when a reranker was present to judge it.
    readonly confidence?: "confident" | "ambiguous";
    // Spool id for continuation cursors; the caller persists the spool, this only formats it.
    readonly cursorId: string;
}

export interface Rendered {
    readonly text: string;
    readonly shownGroups: number;
    readonly shownHits: number;
    readonly truncated: boolean;
    readonly cursor?: string;
    // Paths named in the candidates line; kept in step with the text rather than re-derived from counts.
    readonly candidates?: readonly string[];
    readonly exitCode: 0 | 1;
}

// How many unshown paths the candidates line names.
const CANDIDATE_COUNT = 12;
// Fraction of the budget the capsule's optional lines may use, leaving room for the code body.
const CAPSULE_SHARE = 0.5;

const tagText = (tags: readonly WorkspaceSearchTag[]): string =>
    tags.map((tag) => (tag.score === undefined ? `[${tag.kind}]` : `[${tag.kind} ${tag.score.toFixed(2)}]`)).join(" ");

const freshnessText = (freshness: WorkspaceSearchFreshness): string => {
    if (freshness.state === "building") {
        return `index building ${Math.round((freshness.progress ?? 0) * 100)}%`;
    }
    if (freshness.state === "stale") {
        // Naming the lag, not just "stale", since matches are read live from disk regardless.
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
    // iq recent's hit text holds a change summary; shown beside the path here.
    const summary = group.hits[0] !== undefined && group.hits[0].text !== group.path ? `   ${group.hits[0].text}` : "";
    return `  ${group.path}${summary}${tags.length > 0 ? `    ${tagText(tags)}` : ""}`;
};

const candidateLine = (anchors: readonly string[]): string => `candidates: ${anchors.join(" · ")}`;

const bestHit = (group: RankedGroup): RankedHit | undefined =>
    group.hits.reduce<RankedHit | undefined>((best, hit) => (best === undefined || hit.score > best.score ? hit : best), undefined);

// A candidate names its best hit's line, not just its file, so the reader can open straight to it instead of grepping
// again.
const candidateAnchor = (group: RankedGroup): string => {
    const hit = bestHit(group);
    return hit === undefined ? group.path : `${group.path}:${hit.line}`;
};

// The one line answering where the top evidence sits, its enclosing symbol, and whether it stands out. Anchor is the
// symbol's declaration when found, not the best-scoring line, which lands mid-symbol; that line follows as `match :N`.
const answerLine = (group: RankedGroup, confidence: RenderRequest["confidence"]): string | undefined => {
    const hit = bestHit(group);
    if (hit === undefined) {
        return undefined;
    }
    const anchor = hit.contextLine ?? hit.line;
    const parts = [`${group.path}:${anchor}`];
    if (hit.context !== undefined) {
        parts.push(hit.context);
    }
    if (anchor !== hit.line) {
        parts.push(`match :${hit.line}`);
    }
    if (confidence !== undefined) {
        parts.push(confidence);
    }
    if (hit.tags.length > 0) {
        parts.push(tagText(hit.tags));
    }
    return `answer: ${parts.join(" · ")}`;
};

// Renders ranked groups under a hard token budget. The capsule (answer anchor, candidates, continuation) is reserved
// first and printed before the body, since callers may truncate output.
export const renderText = (request: RenderRequest): Rendered => {
    const { groups, offset, unit, style } = request;
    const totalHits = style === "paths" ? groups.length : groups.reduce((sum, group) => sum + group.hits.length, 0);
    const totalFiles = groups.length;
    const pending = groups.slice(offset, request.limit !== undefined ? offset + request.limit : undefined);
    // A path list, a commit log or a --files-only sweep is already its own candidate map.
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

    // Reserved with worst-case widths so assembly only shrinks; header and continuation are always included.
    const worstCursor = encodeCursor(request.cursorId, offset + pending.length);
    let remaining =
        request.budget - estimateTokens(header(totalHits, request.headerNote)) - estimateTokens(moreLine(totalHits, totalFiles, worstCursor));
    // Optional capsule lines share a fraction of the budget; each is admitted only if it fits, in priority order.
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
            // First group doesn't fit whole; trim its lines to what remains of the budget.
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
