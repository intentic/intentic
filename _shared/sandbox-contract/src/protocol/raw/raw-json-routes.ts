import type { z } from "zod";
import { EngineChannelInputSchema, EngineRevertInputSchema, EnginesViewSchema, EngineUpdateInputSchema, EngineWriteResultSchema } from "../../schemas/engines.js";
import {
    EnvironmentApproveSchema,
    EnvironmentContentsSchema,
    EnvironmentRebuildWhenIdleSchema,
    EnvironmentRemoveSchema,
    EnvironmentRuntimeDecisionSchema,
    EnvironmentSchema,
} from "../../schemas/environment.js";
import { MemberEmailSchema, MemberGrantSchema, MembersListSchema, MembersRosterSchema } from "../../schemas/members.js";
import { OkSchema } from "../../schemas/shared.js";
import { DefinitionDiffSchema, DefinitionExportSchema, WorkspacePublishResultSchema, WorkspacePublishSchema, WorkspaceRemoteSchema } from "../../state/definition.js";
import type { RawRouteKey } from "./raw-routes.js";

// What a raw route that answers plain JSON takes and answers, under its RAW_ROUTES key. `input` is the JSON body a write
// sends; `text` marks one whose body is a document rather than JSON (a sandbox.toml to diff). A caller reaches these by
// key through a typed helper that parses the answer with `output`, so a hand-written route is as typed as a procedure.
// A refusal is the daemon's `{ "error": … }` with a 4xx status on every one of them, outside these schemas.
export interface RawJsonRoute {
    readonly input?: z.ZodType;
    readonly text?: true;
    readonly output: z.ZodType;
}

export const RAW_JSON_ROUTES = {
    // The roster is ownership's; every write answers the roster after it.
    "GET /members": { output: MembersRosterSchema },
    "POST /members": { input: MemberGrantSchema, output: MembersListSchema },
    "DELETE /members": { input: MemberEmailSchema, output: MembersListSchema },
    "DELETE /members/self": { output: OkSchema },
    // Every environment write answers the environment after it. `/environment/contents` takes `?refresh` to probe again.
    "GET /environment": { output: EnvironmentSchema },
    "GET /environment/contents": { output: EnvironmentContentsSchema },
    "POST /environment/approve": { input: EnvironmentApproveSchema, output: EnvironmentSchema },
    "POST /environment/reject": { output: EnvironmentSchema },
    "POST /environment/runtime-install": { input: EnvironmentRuntimeDecisionSchema, output: EnvironmentSchema },
    "POST /environment/remove": { input: EnvironmentRemoveSchema, output: EnvironmentSchema },
    "POST /environment/rebuild-when-idle": { input: EnvironmentRebuildWhenIdleSchema, output: EnvironmentSchema },
    "DELETE /environment/rebuild-when-idle": { output: EnvironmentSchema },
    "GET /engines": { output: EnginesViewSchema },
    "POST /engines/channel": { input: EngineChannelInputSchema, output: EngineWriteResultSchema },
    "POST /engines/update": { input: EngineUpdateInputSchema, output: EngineWriteResultSchema },
    "POST /engines/revert": { input: EngineRevertInputSchema, output: EngineWriteResultSchema },
    "GET /definition": { output: DefinitionExportSchema },
    "POST /definition/diff": { text: true, output: DefinitionDiffSchema },
    "GET /definition/workspace": { output: WorkspaceRemoteSchema },
    "POST /definition/workspace/publish": { input: WorkspacePublishSchema, output: WorkspacePublishResultSchema },
} as const satisfies Partial<Record<RawRouteKey, RawJsonRoute>>;

export type RawJsonRouteKey = keyof typeof RAW_JSON_ROUTES;

// What a JSON raw route answers, parsed.
export type RawJsonOutput<Key extends RawJsonRouteKey> = z.output<(typeof RAW_JSON_ROUTES)[Key]["output"]>;

// What a JSON raw route's body is: its input's shape, a string for a document body, undefined for one that takes none.
export type RawJsonInput<Key extends RawJsonRouteKey> = (typeof RAW_JSON_ROUTES)[Key] extends { readonly input: infer Input extends z.ZodType }
    ? z.input<Input>
    : (typeof RAW_JSON_ROUTES)[Key] extends { readonly text: true }
      ? string
      : undefined;
