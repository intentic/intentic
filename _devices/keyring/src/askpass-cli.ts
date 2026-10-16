#!/usr/bin/env node
import { askpass } from "./askpass/askpass-run.js";

// The npm bin `intentic-askpass`: the same answer the compiled binary gives under that name.
process.exitCode = await askpass(process.argv.slice(2).join(" "), process.stdout, process.stderr);
