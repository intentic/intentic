// Pins what the remoted-protocol check refuses: the two sides disagreeing, and a protocol change that drops the one
// the base speaks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentProtocols, protocolProblems, rustProtocols } from "./lib/remoted-protocol.mjs";

const rust = (protocol, previous) => `pub const PROTOCOL: u32 = ${protocol};\npub const PREVIOUS_PROTOCOLS: &[u32] = &[${previous.join(", ")}];\n`;
const agent = (protocol, previous) =>
    `export const REMOTED_CONTROL_PROTOCOL = ${protocol};\nexport const PREVIOUS_REMOTED_CONTROL_PROTOCOLS: readonly number[] = [${previous.join(", ")}];\n`;
const judge = (now, previous, base) =>
    protocolProblems({ rust: rustProtocols(rust(now, previous)), agent: agentProtocols(agent(now, previous)), base: base === undefined ? undefined : rustProtocols(rust(base, [])) });

test("both sources are read as they are written", () => {
    assert.deepEqual(rustProtocols(rust(3, [1, 2])), { protocol: 3, previous: [1, 2] });
    assert.deepEqual(agentProtocols(agent(1, [])), { protocol: 1, previous: [] });
    assert.equal(rustProtocols("pub const PROTOCOL: u32 = 1;"), undefined);
});

test("an unchanged protocol, a first one, and a move that keeps the base's pass", () => {
    assert.deepEqual(judge(1, [], 1), []);
    assert.deepEqual(judge(1, [], undefined), []);
    assert.deepEqual(judge(2, [1], 1), []);
});

test("a move that drops the base's protocol, or goes backwards, fails", () => {
    assert.match(judge(2, [], 1).join("\n"), /moved from 1 to 2 without keeping 1/);
    assert.match(judge(1, [], 2).join("\n"), /went back from 2 to 1/);
});

test("remoted and the agent disagreeing fails, as does a list naming the current protocol", () => {
    const split = protocolProblems({ rust: rustProtocols(rust(2, [1])), agent: agentProtocols(agent(1, [])), base: undefined });
    assert.match(split.join("\n"), /remoted speaks control protocol 2 .* and the agent 1/);
    assert.match(split.join("\n"), /previous protocols differ/);
    assert.match(judge(2, [2], undefined).join("\n"), /names the current one/);
    assert.match(protocolProblems({ rust: undefined, agent: agentProtocols(agent(1, [])), base: undefined })[0], /could not be read/);
});
