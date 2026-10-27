import type { GroupSamples } from "./context.ts";

// Google's redirect sign-in from start to finish; the account it lands is the first address no Google row holds yet
// (ops@, beside the recording's four), and the disconnect takes it off again.
export const translatorSamples: GroupSamples<`translator`> = () => ({
    accounts: undefined,
    connect: { provider: `gemini` },
    status: { provider: `gemini`, state: `demo-routed-gemini-1` },
    complete: { provider: `gemini`, redirectUrl: `http://localhost:51121/oauth-callback?code=smoke&state=demo-routed-gemini-1`, state: `demo-routed-gemini-1` },
    disconnect: { provider: `gemini`, name: `antigravity-ops.json` },
});
