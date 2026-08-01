import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine, estimateTokens, type QueryRequest, type Scope } from "@intentic/iq-engine";
import { anchorsOf } from "./anchors.js";
import { type BenchConfig, CONFIGS, needsModels } from "./configs.js";
import { ensureIndex, ensureModels, headSha, indexDirFor, packageRoot, repoRoot } from "./repos.js";
import { type CaseRow, type CaseScope, type QueryCase, type QueryDataset, QueryDatasetSchema } from "./schema.js";
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

const loadDatasets = (): QueryDataset[] =>
    readdirSync(join(packageRoot, "datasets"))
        .filter((name) => name.endsWith(".queries.json"))
        .toSorted()
        .map((name) => QueryDatasetSchema.parse(JSON.parse(readFileSync(join(packageRoot, "datasets", name), "utf8"))));

const runConfig = async (dataset: QueryDataset, root: string, config: BenchConfig, models: string | undefined): Promise<CaseRow[]> => {
    const base = { repo: dataset.repo, config: config.name };
    if (needsModels(config) && models === undefined) {
        return dataset.cases.map((queryCase) => ({ ...base, caseId: queryCase.id, verb: queryCase.verb, skipped: "models-missing" as const }));
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
        const score = scoreCase(anchorsOf(queryCase, root), rankedAnchors(outcome.result));
        rows.push({ ...base, caseId: queryCase.id, verb: queryCase.verb, score: { ...score, tokens: estimateTokens(outcome.text), latencyMs } });
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
        throw new Error(`iq-bench: unknown config "${filter.config}" — known: ${CONFIGS.map((config) => config.name).join(", ")}`);
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
