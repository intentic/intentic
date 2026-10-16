#!/usr/bin/env node
// The format-tiers check: its rule, and why, is doors.rules.mjs's `format-tiers` entry.
import { doorRule } from "./doors.rules.mjs";
import { runDoorRule } from "./lib/doors.mjs";

runDoorRule(doorRule(`format-tiers`));
