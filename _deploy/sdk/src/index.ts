import type { DesiredStateGraph } from "@intentic/graph";
import type { IntentSet } from "@intentic/need-resolver";
import { resolveState } from "@intentic/state-resolver";
import type { Stack } from "./handles.js";
import { createStack } from "./stack.js";

// The authoring entry, "what you want": run the declaration and capture it as an IntentSet. `intentic
// resolve` runs the resolvers (intent → needs → desired state) over it.
export const defineIntent = (declare: (stack: Stack) => void): IntentSet => {
    const { stack, intent } = createStack();
    declare(stack);
    return intent;
};

// One-shot: intent → needs → the desired-state graph the resolvers derive. `zone` is the Cloudflare zone the
// apps are exposed under (the CLI discovers it from the API token; tests/fixtures pass it directly).
export const defineStack = (declare: (stack: Stack) => void, zone?: string): DesiredStateGraph => resolveState(defineIntent(declare), zone);

export type {
    App,
    AppTeamGrant,
    Backing,
    Cache,
    Cloudflare,
    Database,
    Deployment,
    GitHub,
    GitLab,
    Have,
    Host,
    Repo,
    Service,
    Stack,
    Stripe,
    Team,
    User,
    Want,
    WantAppInput,
    WantServiceInput,
    WantTeamInput,
} from "./handles.js";
