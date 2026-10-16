#!/usr/bin/env node
// The process-tiers check: its rule, and why, is doors.rules.mjs's `process-tiers` entry.
import { doorRule } from "./doors.rules.mjs";
import { runDoorRule } from "./lib/doors.mjs";

runDoorRule(doorRule(`process-tiers`));
