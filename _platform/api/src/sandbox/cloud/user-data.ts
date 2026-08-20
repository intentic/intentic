// The new machine's first boot IS the setup command: cloud-init runs this script as root, and it is exactly
// the wizard's copy-paste one-liner in headless dress. INSTALL_DOCKER=1 pre-consents the Docker install
// (there is no terminal to ask on), -y silences ic's coexistence prompt, and the setup code is claimed at
// /setup/claim like any pasted run, so the wizard's claim → report → announce states narrate a cloud machine
// and a pasted terminal identically. PLATFORM_URL rides along explicitly so a dev or self-hosted platform's
// machines report back to the platform that made them, not to ic's baked production default.
//
// No user input reaches this script: the setup code is platform-minted base64url and both origins come from
// validated config URLs, there is nothing to quote and no injection surface. Cloud-init logs the run to
// /var/log/cloud-init-output.log on the machine, which is where a support answer points.
export const cloudInitUserData = (args: { scriptOrigin: string; platformUrl: string; setupCode: string }): string =>
    [
        `#!/bin/sh`,
        // Ubuntu cloud images ship curl, but the one-line insurance is cheaper than a machine that boots to
        // nothing on an image that doesn't.
        `command -v curl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl; }`,
        `curl -fsSL ${args.scriptOrigin}/connect | INSTALL_DOCKER=1 PLATFORM_URL=${args.platformUrl} sh -s -- ${args.setupCode} -y`,
        ``,
    ].join(`\n`);
