#!/usr/bin/env node
// The primitive-tiers check: its rule, and why, is doors.rules.mjs's `primitive-tiers` entry.
import { doorRule } from "./doors.rules.mjs";
import { runDoorRule } from "./lib/doors.mjs";

runDoorRule(doorRule(`primitive-tiers`));
