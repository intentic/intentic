import { availableParallelism } from "node:os";

// onnxruntime sizes its intra-op thread pool to one thread per core by default. Left uncapped, the boot-time
// index warm-up (embedPending over the whole workspace) pegs EVERY core on a many-core host: 2400% CPU on a
// 24-core box, which starves the user's own builds and tests running in the same sandbox. Cap it: indexing is
// a background task, and q8 bge-small / MiniLM-L6 inference throughput plateaus by ~4 threads, so 4 buys full
// embedding speed without monopolizing the machine. A 1-3 core host just uses what it has. interOp parallelism
// stays 1, both models run a single graph, so there's nothing to split across sessions.
const EMBED_INTRA_OP_THREADS = Math.max(1, Math.min(4, availableParallelism()));

// Both models' sessions. The CPU memory arena is off because it holds its high-water mark for the life of the
// session: the resident engine's workers stayed at their largest call's size between searches (1.2 GB measured on a
// sandbox after boot). Without it a reranker call of 32 passages settled back from 566 to 186 MB (2026-11-09), and
// one-at-a-time calls (embedder.ts, reranker.ts) cost no more CPU without it.
export const ONNX_SESSION_OPTIONS = { intraOpNumThreads: EMBED_INTRA_OP_THREADS, interOpNumThreads: 1, enableCpuMemArena: false } as const;
