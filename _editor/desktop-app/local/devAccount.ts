import type { ApiToken, HostedPlanState, User } from "@intentic/api-contract";

/* THE ACCOUNT the dev stand-in answers as (devDesktop.ts `accountAnswer`), as the platform answers a local window's
   account calls through the app (src-tauri/src/account.rs): Ada, on a complimentary plan, with one API token. A rename
   or a new picture holds until the tab reloads. */
export const ACCOUNT: User = { id: `u_ada`, email: `ada@example.com`, name: `Ada Lovelace`, image: null };
export const PLAN: HostedPlanState = { enabled: true, onPlan: true, comped: true, priceUsd: 20 };
export const TOKENS: ApiToken[] = [{ id: `tok_1`, label: `CI deploys`, scope: `provision`, createdAt: new Date(Date.now() - 12 * 86_400_000).toISOString() }];
