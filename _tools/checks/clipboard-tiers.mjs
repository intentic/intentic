#!/usr/bin/env node
// The clipboard-tiers check: its rule, and why, is doors.rules.mjs's `clipboard-tiers` entry.
import { doorRule } from "./doors.rules.mjs";
import { runDoorRule } from "./lib/doors.mjs";

runDoorRule(doorRule(`clipboard-tiers`));
