#!/usr/bin/env node
import { run } from "@stricli/core";
import type { StricliProcess } from "@stricli/core";
import { app } from "./app.js";

await run(app, process.argv.slice(2), { process: process as StricliProcess });
