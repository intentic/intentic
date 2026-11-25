// What the remoted-protocol check reads and judges, pure so its test can hand it any text.

export const RUST_SOURCE = "_devices/remoted/src/control.rs";
export const AGENT_SOURCE = "_devices/machine/src/device/remote/remoted-control.ts";

const list = (text) =>
    text
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "")
        .map(Number);

// remoted's `PROTOCOL` and `PREVIOUS_PROTOCOLS`, or undefined when either cannot be found.
export const rustProtocols = (text) => {
    const current = /^pub const PROTOCOL: u32 = (\d+);/m.exec(text);
    const previous = /^pub const PREVIOUS_PROTOCOLS: &\[u32\] = &\[([\d,\s]*)\];/m.exec(text);
    return current === null || previous === null ? undefined : { protocol: Number(current[1]), previous: list(previous[1]) };
};

// The agent's `REMOTED_CONTROL_PROTOCOL` and `PREVIOUS_REMOTED_CONTROL_PROTOCOLS`, or undefined.
export const agentProtocols = (text) => {
    const current = /^export const REMOTED_CONTROL_PROTOCOL = (\d+);/m.exec(text);
    const previous = /^(?:export )?const PREVIOUS_REMOTED_CONTROL_PROTOCOLS: readonly number\[\] = \[([\d,\s]*)\];/m.exec(text);
    return current === null || previous === null ? undefined : { protocol: Number(current[1]), previous: list(previous[1]) };
};

const same = (a, b) => JSON.stringify([...a].toSorted((x, y) => x - y)) === JSON.stringify([...b].toSorted((x, y) => x - y));

/**
 * The problems with the control protocol as `rust` and `agent` declare it now, against `base` (remoted's at the commit
 * the change is built on; undefined where it had none). An upgrade must adopt the remoted the release before started,
 * and that release's agent the remoted this one starts, so the protocol base speaks stays in both previous lists.
 */
export const protocolProblems = ({ rust, agent, base }) => {
    if (rust === undefined || agent === undefined) {
        return [
            `${rust === undefined ? RUST_SOURCE : AGENT_SOURCE}: its protocol constants could not be read; keep them one line each, as the check's lib/remoted-protocol.mjs reads them`,
        ];
    }
    const problems = [];
    if (rust.protocol !== agent.protocol) {
        problems.push(`remoted speaks control protocol ${rust.protocol} (${RUST_SOURCE}) and the agent ${agent.protocol} (${AGENT_SOURCE}): move them together`);
    }
    if (!same(rust.previous, agent.previous)) {
        problems.push(`the previous protocols differ: remoted [${rust.previous.join(", ")}], the agent [${agent.previous.join(", ")}]`);
    }
    if (rust.previous.includes(rust.protocol) || new Set(rust.previous).size !== rust.previous.length) {
        problems.push(`PREVIOUS_PROTOCOLS [${rust.previous.join(", ")}] repeats a protocol or names the current one (${rust.protocol})`);
    }
    if (base !== undefined && base.protocol > rust.protocol) {
        problems.push(`the control protocol went back from ${base.protocol} to ${rust.protocol}: a protocol only moves forward`);
    }
    if (base !== undefined && base.protocol !== rust.protocol && !rust.previous.includes(base.protocol)) {
        problems.push(
            `the control protocol moved from ${base.protocol} to ${rust.protocol} without keeping ${base.protocol}: add it to PREVIOUS_PROTOCOLS (${RUST_SOURCE}) and PREVIOUS_REMOTED_CONTROL_PROTOCOLS (${AGENT_SOURCE}), and keep speaking it, or the upgrade ends every open remote terminal instead of adopting the remoted the release before started`,
        );
    }
    return problems;
};
