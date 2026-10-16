#!/usr/bin/env node
// The home-dir check: its rule, and why, is doors.rules.mjs's `home-dir` entry.
import { doorRule } from "./doors.rules.mjs";
import { runDoorRule } from "./lib/doors.mjs";

runDoorRule(doorRule(`home-dir`));
