import type { Capability } from "@intentic/sandbox-contract";
import { browserUrls, contributionKey, type ResolvedContribution } from "./contributions.js";
import { identityLoginUrl } from "./handlers/identity.handler.js";

// The addresses an account signs in on, the same ones its guided login opens (browser-profile.routes.ts): a browser account's
// card URLs with its config's overrides, an identity's email-provider sign-in page. Empty when nothing on record names
// a site: a platform whose extension is gone and no URL of its own.
export const accountSignInUrls = async (
    connectors: () => Promise<ReadonlyMap<string, ResolvedContribution>>,
    capability: Capability,
): Promise<readonly string[]> => {
    if (capability.kind === "identity") {
        return [identityLoginUrl(capability.config)];
    }
    if (capability.kind !== "browser") {
        return [];
    }
    const { config } = capability;
    const contribution = (await connectors()).get(contributionKey("browser", config.platform));
    if (contribution !== undefined) {
        const urls = browserUrls(contribution.spec, config);
        return urls === undefined ? [] : [urls.loginUrl, urls.homeUrl];
    }
    return [config["loginUrl"], config["homeUrl"]].filter((url): url is string => url !== undefined && url !== "");
};
