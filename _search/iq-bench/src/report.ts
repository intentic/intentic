import { CONFIGS } from "./configs.js";
import { IMPACT_BASELINES, IMPACT_STRATEGIES, type ImpactMeta, type ImpactRow } from "./impact.js";
import type { RepoMeta } from "./retrieval.js";
import type { CaseRow, CaseScore, RunRecord } from "./schema.js";
import { meanScores } from "./score.js";

const fmt = (value: number | undefined, digits = 2): string => (value === undefined ? "—" : value.toFixed(digits));

const median = (values: readonly number[]): number | undefined => {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
};

const scoreLine = (name: string, scores: CaseScore[], skipped: number): string => {
    if (skipped > 0) {
        return `| ${name} | skipped (models missing) | | | | | | |`;
    }
    const mean = meanScores(scores);
    if (mean === undefined) {
        return `| ${name} |: |, |, |, |, |, |, |`;
    }
    const p50 = median(scores.map((score) => score.latencyMs));
    return `| ${name} | ${fmt(mean.recallAt1)} | ${fmt(mean.recallAt5)} | ${fmt(mean.recallAt10)} | ${fmt(mean.mrr)} | ${fmt(mean.ndcg)} | ${fmt(mean.tokens, 0)} | ${fmt(p50, 0)} |`;
};

const configTable = (rows: readonly CaseRow[]): string => {
    const lines = ["| config | recall@1 | recall@5 | recall@10 | MRR@10 | nDCG@10 | tokens/q | p50 ms |", "|---|---:|---:|---:|---:|---:|---:|---:|"];
    for (const config of CONFIGS) {
        const configRows = rows.filter((row) => row.config === config.name);
        if (configRows.length === 0) {
            continue;
        }
        const scores = configRows.flatMap((row) => (row.score === undefined ? [] : [row.score]));
        lines.push(scoreLine(config.name, scores, configRows.filter((row) => row.skipped !== undefined).length));
    }
    return lines.join("\n");
};

const LOSS_ROWS_CAP = 10;

// Paired per-case comparison of every config against `full`, the decision view. Means at small N invite
// over-reading; a stage's fate is decided by win/loss direction and the sign test, plus its recall/token cost.
const configVsFull = (rows: readonly CaseRow[]): string => {
    const fullByCase = new Map(
        rows.flatMap((row) => (row.config === "full" && row.score !== undefined ? [[`${row.repo}/${row.caseId}`, row.score] as const] : [])),
    );
    if (fullByCase.size === 0) {
        return "";
    }
    const summary = [
        "\n## Paired vs `full` (per-case nDCG)\n",
        "| config | wins | losses | ties | sign p | Δrecall@10 | Δtokens/q |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ];
    const lossTables: string[] = [];
    for (const config of CONFIGS) {
        if (config.name === "full") {
            continue;
        }
        const pairs = rows.flatMap((row) => {
            if (row.config !== config.name || row.score === undefined) {
                return [];
            }
            const full = fullByCase.get(`${row.repo}/${row.caseId}`);
            return full === undefined ? [] : [{ row, score: row.score, full }];
        });
        if (pairs.length === 0) {
            continue;
        }
        const wins = pairs.filter((pair) => pair.score.ndcg > pair.full.ndcg).length;
        const losses = pairs.filter((pair) => pair.score.ndcg < pair.full.ndcg).length;
        const p = signTest(wins, losses);
        const mean = (pick: (pair: (typeof pairs)[number]) => number): number => pairs.reduce((sum, pair) => sum + pick(pair), 0) / pairs.length;
        const dRecall = mean((pair) => pair.score.recallAt10 - pair.full.recallAt10);
        const dTokens = mean((pair) => pair.score.tokens - pair.full.tokens);
        summary.push(
            `| ${config.name} | ${wins} | ${losses} | ${pairs.length - wins - losses} | ${p === undefined ? "—" : p.toFixed(3)} | ${dRecall >= 0 ? "+" : ""}${dRecall.toFixed(2)} | ${dTokens >= 0 ? "+" : ""}${dTokens.toFixed(0)} |`,
        );
        const lossRows = pairs
            .filter((pair) => pair.score.ndcg < pair.full.ndcg)
            .toSorted((a, b) => a.score.ndcg - a.full.ndcg - (b.score.ndcg - b.full.ndcg))
            .slice(0, LOSS_ROWS_CAP)
            .map((pair) => `| ${pair.row.repo}/${pair.row.caseId} | ${pair.row.verb} | ${fmt(pair.full.ndcg)} | ${fmt(pair.score.ndcg)} |`);
        if (lossRows.length > 0) {
            lossTables.push(
                `\n### \`${config.name}\` losses vs \`full\`\n`,
                `| case | verb | full nDCG | ${config.name} nDCG |`,
                "|---|---|---:|---:|",
                ...lossRows,
            );
        }
    }
    return [...summary, ...lossTables].join("\n");
};

// ---- tier 2 ----

const binomial = (n: number, k: number): number => {
    let value = 1;
    for (let i = 1; i <= k; i += 1) {
        value = (value * (n - i + 1)) / i;
    }
    return value;
};

// Exact two-sided sign test over non-tie pairs (H0: wins and losses equally likely).
export const signTest = (wins: number, losses: number): number | undefined => {
    const n = wins + losses;
    if (n === 0) {
        return undefined;
    }
    let sum = 0;
    for (let i = 0; i <= Math.min(wins, losses); i += 1) {
        sum += binomial(n, i);
    }
    return Math.min(1, (2 * sum) / 2 ** n);
};

// Seeded LCG so the report is reproducible from the same runs.jsonl.
const lcg = (seed: number): (() => number) => {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
};

// Percentile-bootstrap 95% CI on the mean of paired deltas, descriptive, not a significance claim.
const bootstrapCi = (deltas: readonly number[]): { lo: number; hi: number } | undefined => {
    if (deltas.length < 2) {
        return undefined;
    }
    const random = lcg(42);
    const means: number[] = [];
    for (let resample = 0; resample < 10_000; resample += 1) {
        let sum = 0;
        for (let i = 0; i < deltas.length; i += 1) {
            sum += deltas[Math.floor(random() * deltas.length)] ?? 0;
        }
        means.push(sum / deltas.length);
    }
    const sorted = means.toSorted((a, b) => a - b);
    return { lo: sorted[Math.floor(0.025 * sorted.length)] ?? 0, hi: sorted[Math.floor(0.975 * sorted.length)] ?? 0 };
};

const totalTokens = (record: RunRecord): number | undefined =>
    record.tokensIn === undefined && record.tokensOut === undefined ? undefined : (record.tokensIn ?? 0) + (record.tokensOut ?? 0);

const delta = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined || b === undefined ? undefined : b - a);

const check = (success: boolean): string => (success ? "✓" : "✗");

const pairedBlock = (label: string, pairs: ReadonlyArray<{ a: RunRecord; b: RunRecord }>): string[] => {
    const lines: string[] = [];
    const wins = pairs.filter((pair) => pair.b.success && !pair.a.success).length;
    const losses = pairs.filter((pair) => !pair.b.success && pair.a.success).length;
    const ties = pairs.length - wins - losses;
    const p = signTest(wins, losses);
    lines.push(`- **${label} success**: iq wins ${wins}, losses ${losses}, ties ${ties}${p === undefined ? "" : ` (sign test p=${p.toFixed(3)})`}`);
    const tokenDeltas = pairs.flatMap((pair) => {
        const value = delta(totalTokens(pair.a), totalTokens(pair.b));
        return value === undefined ? [] : [value];
    });
    if (tokenDeltas.length > 0) {
        const mean = tokenDeltas.reduce((sum, value) => sum + value, 0) / tokenDeltas.length;
        const ci = bootstrapCi(tokenDeltas);
        const ciText = ci === undefined ? "" : ` (bootstrap 95% CI [${ci.lo.toFixed(0)}, ${ci.hi.toFixed(0)}], descriptive)`;
        lines.push(`- **${label} Δtokens (iq − baseline)**: mean ${mean.toFixed(0)}${ciText}`);
    }
    if (pairs.length < 6) {
        lines.push(`- ⚠ N=${pairs.length} is too small for significance: directional only.`);
    }
    return lines;
};

// Hard rule: runs are grouped per vendor+model and only within-model deltas are stated, never cross-model
// absolute comparisons (different tokenizers, pricing, scaffolds).
export const renderAgentsReport = (records: readonly RunRecord[]): string => {
    if (records.length === 0) {
        return "# iq agent benchmark (tier 2)\n\nNo runs recorded.";
    }
    const parts = ["# iq agent benchmark (tier 2)\n"];
    const groups = new Map<string, RunRecord[]>();
    for (const record of records) {
        const key = `${record.vendor} / ${record.model}`;
        groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    for (const [group, groupRecords] of groups) {
        parts.push(`## ${group}\n`);
        const taskIds = [...new Set(groupRecords.map((record) => record.taskId))];
        const armNames = [...new Set(groupRecords.map((record) => record.arm))].toSorted();
        const primaryIqArm = armNames.find((arm) => arm !== "a") ?? "b";
        parts.push(`| task | repo | ${armNames.map((arm) => `${arm} ✓/✗`).join(" | ")} | Δtokens | Δcost | Δturns | Δwall s |`);
        parts.push(`|---|---|${armNames.map(() => "---").join("|")}|---:|---:|---:|---:|`);
        const pairs: Array<{ a: RunRecord; b: RunRecord }> = [];
        for (const taskId of taskIds) {
            const byArm = new Map(groupRecords.filter((record) => record.taskId === taskId).map((record) => [record.arm, record]));
            const a = byArm.get("a");
            const b = byArm.get(primaryIqArm);
            if (a !== undefined && b !== undefined) {
                pairs.push({ a, b });
            }
            const marks = armNames.map((arm) => {
                const record = byArm.get(arm);
                return record === undefined ? "—" : check(record.success);
            });
            const dTokens = a !== undefined && b !== undefined ? delta(totalTokens(a), totalTokens(b)) : undefined;
            const dCost = a !== undefined && b !== undefined ? delta(a.costUsd, b.costUsd) : undefined;
            const dTurns = a !== undefined && b !== undefined ? delta(a.turns, b.turns) : undefined;
            const dWall = a !== undefined && b !== undefined ? (b.wallMs - a.wallMs) / 1000 : undefined;
            parts.push(
                `| ${taskId} | ${byArm.values().next().value?.repo ?? ""} | ${marks.join(" | ")} | ${fmt(dTokens, 0)} | ${dCost === undefined ? "—" : dCost.toFixed(3)} | ${fmt(dTurns, 0)} | ${fmt(dWall, 0)} |`,
            );
        }
        parts.push("");
        if (pairs.length > 0) {
            parts.push(...pairedBlock(`arm ${primaryIqArm} vs a`, pairs));
            parts.push("");
        }
    }
    const spend = records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
    const shas = [...new Set(records.map((record) => `${record.repo}@${record.sha.slice(0, 10)}`))].join(", ");
    parts.push(`---\nruns: ${records.length} · vendor-reported spend: $${spend.toFixed(2)} · repos: ${shas}`);
    parts.push("Deltas are within-model (iq − baseline); cross-model absolute comparisons are intentionally not reported.");
    return parts.join("\n");
};

const mean = (values: readonly number[]): number | undefined => (values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length);

// Paired on (sha, seed): every strategy saw exactly the same cases, so a win is a win on the same question.
const impactVs = (rows: readonly ImpactRow[], challenger: string, baseline: string): string => {
    const keyed = (name: string): Map<string, ImpactRow> => new Map(rows.filter((row) => row.strategy === name).map((row) => [`${row.sha}:${row.seed}`, row]));
    const left = keyed(challenger);
    const right = keyed(baseline);
    // A name that matches no rows used to render 0/0/0, which reads as a measured tie rather than a wiring
    // mistake. It is the same class of bug as a thrown tool call scoring as a win, and it stays loud.
    if (left.size === 0 || right.size === 0) {
        return `| ${challenger} vs ${baseline} | **no rows: strategy name does not exist** | | | |`;
    }
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (const [key, row] of left) {
        const other = right.get(key);
        if (other === undefined) {
            continue;
        }
        if (row.f1 > other.f1) {
            wins += 1;
        } else if (row.f1 < other.f1) {
            losses += 1;
        } else {
            ties += 1;
        }
    }
    const p = signTest(wins, losses);
    return `| ${challenger} vs ${baseline} | ${wins} | ${losses} | ${ties} | ${p === undefined ? "—" : p < 0.001 ? "<0.001" : p.toFixed(3)} |`;
};

export const renderImpactReport = (rows: readonly ImpactRow[], meta: ImpactMeta): string => {
    const parts = [
        "# iq impact benchmark (tier 1b): co-change ground truth\n",
        ...(meta.shallow
            ? [
                  `> ⚠ **${meta.repo} is a shallow clone**: there is no commit history to mine, so every number below is\n` +
                      "> computed over whatever tiny sample survived. This benchmark needs a full clone; the lock file's repos\n" +
                      "> are fetched at `--depth 1` and cannot be used for it as they stand.\n",
              ]
            : []),
        `## ${meta.repo}: ${meta.graphFiles} indexed files, ${meta.graphEdges} resolved import edges\n`,
        `Scanned ${meta.commitsScanned} commits: ${meta.commitsUsable} usable, ${meta.droppedTooSmall} dropped (fewer than two code files), ` +
            `${meta.droppedNotIndexed} dropped (code files the current index does not know: renamed or deleted since). ` +
            `${meta.cases} graded cases, each one seed file against the rest of its commit.\n`,
    ];
    const table = ["| strategy | cases | precision | recall | F1 | median F1 | predicted/case | empty | truncated/case |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"];
    for (const strategy of IMPACT_STRATEGIES) {
        const strategyRows = rows.filter((row) => row.strategy === strategy.name);
        if (strategyRows.length === 0) {
            continue;
        }
        const empty = strategyRows.filter((row) => row.predictedCount === 0).length;
        table.push(
            `| ${strategy.name} | ${strategyRows.length} | ${fmt(mean(strategyRows.map((row) => row.precision)))} | ${fmt(mean(strategyRows.map((row) => row.recall)))} | ` +
                `${fmt(mean(strategyRows.map((row) => row.f1)))} | ${fmt(median(strategyRows.map((row) => row.f1)))} | ${fmt(mean(strategyRows.map((row) => row.predictedCount)), 1)} | ` +
                `${((100 * empty) / strategyRows.length).toFixed(0)}% | ${fmt(mean(strategyRows.map((row) => row.truncated)), 1)} |`,
        );
    }
    parts.push(table.join("\n"), "");
    parts.push("## Paired head-to-head (F1 per case, exact two-sided sign test)\n");
    const pairs = ["| comparison | wins | losses | ties | p |", "|---|---:|---:|---:|---:|"];
    for (const baseline of IMPACT_BASELINES) {
        for (const strategy of IMPACT_STRATEGIES) {
            if (strategy.name === baseline) {
                continue;
            }
            pairs.push(impactVs(rows, strategy.name, baseline));
        }
    }
    parts.push(pairs.join("\n"), "");
    parts.push(
        `> THE GATE: a strategy ships only if it beats BOTH baselines, ${IMPACT_BASELINES.map((name) => `\`${name}\``).join(" and ")}.\n` +
            "> The first consults no graph at all; the second is the reach the related line already gives us, so a\n" +
            "> strategy that cannot beat it is not worth building. Co-change is a proxy: batched unrelated edits and\n" +
            "> affected-but-unedited files both push precision down, so read recall as the signal and precision as a\n" +
            "> loose upper bound on noise.",
    );
    return parts.join("\n");
};

export const renderRetrievalReport = (rows: readonly CaseRow[], metas: readonly RepoMeta[], skippedModels: boolean): string => {
    const parts = ["# iq retrieval benchmark (tier 1)\n"];
    if (skippedModels) {
        parts.push("> ⚠ embedding models unavailable: semantic/rerank configs skipped, not degraded.\n");
    }
    for (const meta of metas) {
        const build = meta.buildMs === undefined ? "index reused" : `index built in ${(meta.buildMs / 1000).toFixed(1)}s`;
        parts.push(`## ${meta.id} @ ${meta.sha.slice(0, 10)}: ${meta.files} files, ${meta.chunks} chunks, ${meta.embedded} embedded, ${build}\n`);
        parts.push(configTable(rows.filter((row) => row.repo === meta.id)));
        parts.push("");
    }
    if (metas.length > 1) {
        parts.push("## All repos\n");
        parts.push(configTable(rows));
        parts.push("");
    }
    parts.push(configVsFull(rows));
    parts.push("\n> Latency includes iq's per-run revalidation sweep: the honest CLI-equivalent number.");
    return parts.join("\n");
};
