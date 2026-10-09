#!/usr/bin/env node
// Every tool the sandbox image downloads at a fixed version reads back ONE version, at every site that writes it, from
// the table the bumper writes through (_tools/scripts/tools/tool-pins.mjs). Where a tool is pinned twice — ruff and
// pyright in the python pack and the CI base image, cloudflared in nine files, pnpm in five — a hand edit that moves one
// copy is caught here rather than by the runtime skew it causes. Plain file reading: no install, no network.

import { TOOL_PINS, readToolPins } from "../scripts/tools/tool-pins.mjs";
import { finish } from "./lib/report.mjs";

const problems = Object.entries(readToolPins()).flatMap(([id, pin]) => pin.problems.map((problem) => `${id}: ${problem}`));

finish([["a pinned tool disagrees with itself", problems]], [`tool pins: ${TOOL_PINS.length} tools read back one version at every site`]);
