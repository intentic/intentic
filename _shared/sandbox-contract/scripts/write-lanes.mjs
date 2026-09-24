#!/usr/bin/env node
// Regenerates src/protocol/tunnel-lanes.json, the lane table the Rust edge embeds, from the built dist. Run as
// `pnpm --filter @intentic/sandbox-contract lanes`, which builds first; tunnel-lanes.test.ts fails while it is stale.
import { writeFileSync } from "node:fs";
import { tunnelLaneTable } from "../dist/protocol/tunnel-lanes.js";

const table = tunnelLaneTable();
writeFileSync(new URL("../src/protocol/tunnel-lanes.json", import.meta.url), `[\n${table.map((route) => `    ${JSON.stringify(route)}`).join(",\n")}\n]\n`);
console.log(`tunnel-lanes.json: ${table.length} routes, ${table.filter(({ lane }) => lane === "bulk").length} on the bulk lane`);
