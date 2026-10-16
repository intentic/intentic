#!/usr/bin/env node
// The run-settings check: its rule, and why, is doors.rules.mjs's `run-settings` entry.
import { doorRule } from "./doors.rules.mjs";
import { runDoorRule } from "./lib/doors.mjs";

runDoorRule(doorRule(`run-settings`));
