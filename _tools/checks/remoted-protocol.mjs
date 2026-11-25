#!/usr/bin/env node
// remoted outlives the machine agent and the next agent adopts it over its control endpoint (remoted's src/control.rs),
// so the protocol they speak crosses releases: an agent must adopt the remoted the release before it started, or an
// upgrade ends every open remote terminal. Fails when remoted and the agent declare different protocols, or when the
// protocol moved from the one at the change's base without keeping it in both previous lists. The base is the merge-base
// with main (REMOTED_PROTOCOL_BASE names another), and on main itself the commit before.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_SOURCE, agentProtocols, protocolProblems, RUST_SOURCE, rustProtocols } from "./lib/remoted-protocol.mjs";
import { finish } from "./lib/report.mjs";
import { git, root } from "./lib/repo.mjs";

const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined);

const baseRef = () => {
    const named = process.env["REMOTED_PROTOCOL_BASE"]?.trim();
    if (named !== undefined && named !== "") {
        return named;
    }
    const head = git("rev-parse", "HEAD")?.trim();
    const mergeBase = (git("merge-base", "HEAD", "origin/main") ?? git("merge-base", "HEAD", "main"))?.trim();
    if (mergeBase !== undefined && mergeBase !== head) {
        return mergeBase;
    }
    return git("rev-parse", "--verify", "--quiet", "HEAD~1")?.trim() || undefined;
};

const rustText = read(RUST_SOURCE);
const agentText = read(AGENT_SOURCE);
const problems = [];
let said = "remoted's control protocol: not in this tree";
if (rustText !== undefined || agentText !== undefined) {
    const ref = baseRef();
    const baseText = ref === undefined ? undefined : git("show", `${ref}:${RUST_SOURCE}`);
    const base = baseText === undefined ? undefined : rustProtocols(baseText);
    const rust = rustText === undefined ? undefined : rustProtocols(rustText);
    problems.push(...protocolProblems({ rust, agent: agentText === undefined ? undefined : agentProtocols(agentText), base }));
    said = `remoted's control protocol ${rust?.protocol ?? "?"}, agent and remoted agree${
        base === undefined ? "; no protocol at the base to cross from" : `, and ${base.protocol} at ${ref?.slice(0, 12)} is still adopted`
    }`;
}

finish([["The remoted control protocol would strand terminals across an upgrade", problems]], [said]);
