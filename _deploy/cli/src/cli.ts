#!/usr/bin/env node
import type { StricliProcess } from "@stricli/core";
import { run } from "@stricli/core";
import { app } from "./app.js";

// Node's process satisfies StricliProcess at runtime; the cast only bridges exactOptionalPropertyTypes
// (process.exitCode is typed with undefined). stricli writes the resolved exit code back onto it.
await run(app, process.argv.slice(2), { process: process as StricliProcess });
