#!/usr/bin/env node
// First, before any module can start the I/O thread pool, which reads its size once (resident/io-pool.ts).
import { ioPoolCapped } from "./resident/io-pool.js";
import { run } from "@stricli/core";
import type { StricliProcess } from "@stricli/core";
import { app } from "./app.js";

// Settled before any command can start a program, so none inherits the pool's size.
await ioPoolCapped;
await run(app, process.argv.slice(2), { process: process as StricliProcess });
