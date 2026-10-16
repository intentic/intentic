#!/usr/bin/env node
// The tones check: its rule, and why, is doors.rules.mjs's `tones` entry.
import { doorRule } from "./doors.rules.mjs";
import { runDoorRule } from "./lib/doors.mjs";

runDoorRule(doorRule(`tones`));
