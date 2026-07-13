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
    // "plain" = hit text without line prefixes (iq log, iq who — line numbers are synthetic there).
    readonly style: "hits" | "paths" | "plain";
    readonly showTags: boolean;
    readonly groups: readonly RankedGroup[];
    // Groups already delivered by an earlier page — skipped here, but counted in the totals.
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
    // Compact ranked path map so the reader can scan to a candidate that ranked below the shown/packed groups
    // (benchmarked: the true answer often sits at rank 5–13, invisible behind the packed top-2). Budget-reserved.
    readonly candidates?: readonly string[];
    // Spool id for continuation cursors; the renderer only formats it, the caller persists the spool.
    readonly cursorId: string;
}

export interface Rendered {
    readonly text: string;
    readonly shownGroups: number;
    readonly shownHits: number;
    readonly truncated: boolean;
    readonly cursor?: string;
    readonly exitCode: 0 | 1;
}

const tagText = (tags: readonly WorkspaceSearchTag[]): string =>
    tags.map((tag) => (tag.score === undefined ? `[${tag.kind}]` : `[${tag.kind} ${tag.score.toFixed(2)}]`)).join(" ");

const freshnessText = (freshness: WorkspaceSearchFreshness): string => {
    if (freshness.state === "building") {
        return `index building ${Math.round((freshness.progress ?? 0) * 100)}%`;
    }
    if (freshness.state === "stale") {
        return "index stale";
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
    // iq recent carries a change summary in the hit text — show it beside the path.
    const summary = group.hits[0] !== undefined && group.hits[0].text !== group.path ? `   ${group.hits[0].text}` : "";
    return `  ${group.path}${summary}${tags.length > 0 ? `    ${tagText(tags)}` : ""}`;
};

// Render ranked groups under a hard token budget: header and worst-case footer reserved first, then groups fill
// greedily (whole groups, with intra-group elision past a per-group soft cap). Never splits a group across pages.
export const renderText = (request: RenderRequest): Rendered => {
    const { groups, offset, unit, style } = request;
    const totalHits = style === "paths" ? groups.length : groups.reduce((sum, group) => sum + group.hits.length, 0);
    const totalFiles = groups.length;
    const pending = groups.slice(offset, request.limit !== undefined ? offset + request.limit : undefined);

    const header = (shown: number, note?: string): string => {
        const scope = style === "paths" ? `${totalHits} ${unit}` : `${totalHits} ${unit} in ${totalFiles} files`;
        const noteText = note !== undefined ? ` · ${note}` : "";
        return `iq: ${request.echo} — ${scope} · ${freshnessText(request.freshness)}${noteText} · showing ${shown}/${totalHits}`;
    };
    const footer = (remainingHits: number, remainingFiles: number, cursor: string): string =>
        style === "paths"
            ? `──── truncated: ${remainingHits} more ${unit} · next: iq ${request.echo} --after ${cursor} ────`
            : `──── truncated: ${remainingHits} ${unit} in ${remainingFiles} more files · next: iq ${request.echo} --after ${cursor} ────`;

    // Reserve with worst-case widths so the final assembly can only shrink.
    const worstCursor = encodeCursor(request.cursorId, offset + pending.length);
    const relatedLines = (request.related ?? []).map((line) => `related: ${line}`);
    const candidateLine =
        request.candidates !== undefined && request.candidates.length > 0 ? `candidates: ${request.candidates.join(" · ")}` : undefined;
    let remaining =
        request.budget -
        estimateTokens(header(totalHits, request.headerNote)) -
        estimateTokens(footer(totalHits, totalFiles, worstCursor)) -
        relatedLines.reduce((sum, line) => sum + estimateTokens(line), 0) -
        (candidateLine !== undefined ? estimateTokens(candidateLine) : 0) -
        (request.hint !== undefined ? estimateTokens(`hint: ${request.hint}`) : 0);

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
                    const elision = `     … ${elided} more — iq context ${group.path}:${hit.line}`;
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
    const parts = [header(shownTotal, request.headerNote), ...bodyLines];
    if (truncated && cursor !== undefined) {
        const remainingFiles = groups.length - offset - shownGroups;
        const remainingHits =
            style === "paths" ? remainingFiles : groups.slice(offset + shownGroups).reduce((sum, group) => sum + group.hits.length, 0);
        parts.push(footer(remainingHits, remainingFiles, cursor));
    }
    parts.push(...relatedLines);
    if (candidateLine !== undefined) {
        parts.push(candidateLine);
    }
    if (request.hint !== undefined) {
        parts.push(`hint: ${request.hint}`);
    }
    return {
        text: `${parts.join("\n")}\n`,
        shownGroups,
        shownHits: shownTotal,
        truncated,
        ...(cursor !== undefined ? { cursor } : {}),
        exitCode: totalHits > 0 ? 0 : 1,
    };
};
