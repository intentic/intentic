import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine, estimateTokens, type QueryRequest, type Scope } from "@intentic/iq-engine";
import type { WorkspaceSearchResult } from "@intentic/sandbox-contract";
import { anchorsOf } from "./anchors.js";
import { type BenchConfig, CONFIGS, needsModels } from "./configs.js";
import { ensureIndex, ensureModels, headSha, indexDirFor, packageRoot, repoRoot } from "./repos.js";
import { type CaseRow, type CaseScope, isNoAnswer, type QueryCase, type QueryDataset, QueryDatasetSchema, slicesOf } from "./schema.js";
import { rankedAnchors, scoreCase } from "./score.js";

export interface RepoMeta {
    readonly id: string;
    readonly sha: string;
    readonly files: number;
    readonly chunks: number;
    readonly embedded: number;
    readonly buildMs?: number;
}

const scopeOf = (dataset: QueryDataset, queryCase: QueryCase): Scope => {
    const merged: CaseScope = { ...dataset.scope, ...queryCase.scope };
    return {
        ...(merged.paths !== undefined ? { paths: merged.paths } : {}),
        ...(merged.langs !== undefined ? { langs: merged.langs } : {}),
        ...(merged.only !== undefined ? { only: merged.only } : {}),
        ...(merged.notGlobs !== undefined ? { notGlobs: merged.notGlobs } : {}),
    };
};

const requestOf = (dataset: QueryDataset, queryCase: QueryCase): QueryRequest => ({
    verb: queryCase.verb,
    query: queryCase.query,
    scope: scopeOf(dataset, queryCase),
    render: { budget: 1500 },
    options: queryCase.verb === "ast" ? { astLang: queryCase.scope?.langs?.[0] ?? "ts" } : {},
    echo: `${queryCase.verb} ${queryCase.query}`,
});

// A group's best [rerank] tag, as printed: undefined when none of its shown hits reached the cross-encoder.
const rerankOf = (group: WorkspaceSearchResult["groups"][number] | undefined): number | undefined => {
    const scores = (group?.hits ?? []).flatMap((hit) => hit.tags.flatMap((tag) => (tag.kind === "rerank" && tag.score !== undefined ? [tag.score] : [])));
    return scores.length === 0 ? undefined : Math.max(...scores);
};

const loadDatasets = (): QueryDataset[] =>
    readdirSync(join(packageRoot, "datasets"))
        .filter((name) => name.endsWith(".queries.json"))
        .toSorted()
        .map((name) => QueryDatasetSchema.parse(JSON.parse(readFileSync(join(packageRoot, "datasets", name), "utf8"))));

const runConfig = async (dataset: QueryDataset, root: string, config: BenchConfig, models: string | undefined): Promise<CaseRow[]> => {
    const base = { repo: dataset.repo, config: config.name };
    const caseBase = (queryCase: QueryCase): Pick<CaseRow, "repo" | "config" | "caseId" | "verb" | "slices"> => ({
        ...base,
        caseId: queryCase.id,
        verb: queryCase.verb,
        slices: [...slicesOf(queryCase)],
    });
    if (needsModels(config) && models === undefined) {
        return dataset.cases.map((queryCase) => ({ ...caseBase(queryCase), skipped: "models-missing" as const }));
    }
    const engine = createEngine({
        root,
        indexDir: indexDirFor(dataset.repo),
        features: config.features,
        ...(models !== undefined ? { modelDir: models } : {}),
    });
    const rows: CaseRow[] = [];
    for (const queryCase of dataset.cases) {
        const start = performance.now();
        const outcome = await engine.run(requestOf(dataset, queryCase));
        const latencyMs = performance.now() - start;
        // A no-answer case has nothing to rank; it is scored by `weak` alone, which an answerable case reports too.
        const score = isNoAnswer(queryCase) ? undefined : scoreCase(anchorsOf(queryCase, root), rankedAnchors(outcome.result));
        const row: CaseRow = { ...caseBase(queryCase), weak: outcome.verdict?.confidence === "weak" || outcome.result.total === 0 };
        if (score !== undefined) {
            row.score = { ...score, tokens: estimateTokens(outcome.text), latencyMs };
        }
        if (outcome.verdict?.relevance !== undefined) {
            row.relevance = outcome.verdict.relevance;
        }
        if (outcome.verdict !== undefined) {
            if (outcome.verdict.confidence !== undefined) {
                row.confidence = outcome.verdict.confidence;
            }
            if (outcome.verdict.basis !== undefined) {
                row.basis = outcome.verdict.basis;
            }
        }
        // The engine's own scores when it reports them (unrounded, and the file's best passage even where packing left
        // that passage's line untagged); the [rerank] tags of the two leading groups for an engine that does not.
        const top = outcome.verdict?.top ?? rerankOf(outcome.result.groups[0]);
        const runnerUp = outcome.verdict?.top !== undefined ? outcome.verdict.runnerUp : rerankOf(outcome.result.groups[1]);
        if (top !== undefined) {
            row.top = top;
        }
        if (runnerUp !== undefined) {
            row.runnerUp = runnerUp;
        }
        rows.push(row);
    }
    return rows;
};

export const runRetrieval = async (filter: {
    repo?: string;
    config?: string;
}): Promise<{ rows: CaseRow[]; metas: RepoMeta[]; skippedModels: boolean }> => {
    const models = ensureModels();
    const datasets = loadDatasets().filter((dataset) => filter.repo === undefined || dataset.repo === filter.repo);
    if (datasets.length === 0) {
        throw new Error(`iq-bench: no datasets${filter.repo === undefined ? "" : ` for repo "${filter.repo}"`}`);
    }
    const configs = CONFIGS.filter((config) => filter.config === undefined || config.name === filter.config);
    if (configs.length === 0) {
        throw new Error(`iq-bench: unknown config "${filter.config}", known: ${CONFIGS.map((config) => config.name).join(", ")}`);
    }
    const rows: CaseRow[] = [];
    const metas: RepoMeta[] = [];
    for (const dataset of datasets) {
        const root = repoRoot(dataset.repo);
        console.log(`[${dataset.repo}] ensuring index…`);
        const { status, buildMs } = await ensureIndex(dataset.repo, root, models);
        metas.push({
            id: dataset.repo,
            sha: headSha(root),
            files: status.files,
            chunks: status.chunks,
            embedded: status.embedded,
            ...(buildMs !== undefined ? { buildMs } : {}),
        });
        // Warmup: the first run pays one-off model-load and page-cache costs no config should be charged for.
        const firstCase = dataset.cases[0];
        if (firstCase !== undefined) {
            const warm = createEngine({ root, indexDir: indexDirFor(dataset.repo), ...(models !== undefined ? { modelDir: models } : {}) });
            await warm.run(requestOf(dataset, firstCase));
        }
        for (const config of configs) {
            console.log(`[${dataset.repo}] config ${config.name} (${dataset.cases.length} cases)`);
            rows.push(...(await runConfig(dataset, root, config, models)));
        }
    }
    return { rows, metas, skippedModels: models === undefined };
};
