// Which build is running, as `intentic-keyring version` prints it and the `state` answer reports it. Stamped at compile
// time (bun's --define, build-agent-binaries.sh). Falls back to 0.0.0, the sentinel every intentic agent uses for a
// working-tree build.
declare const INTENTIC_AGENT_VERSION: string | undefined;

const stamped = (): string => {
    try {
        return INTENTIC_AGENT_VERSION ?? "0.0.0";
    } catch {
        // allow(silent-catch): without the define the identifier does not exist at all, which is a working-tree build
        return "0.0.0";
    }
};

export const KEYRING_VERSION: string = stamped();
