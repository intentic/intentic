import type { z } from "zod";
import { ControlTokenMintedSchema, ControlTokenMintSchema, ControlTokensListSchema } from "../../policy/control-scopes.js";
import { EngineChannelInputSchema, EngineRevertInputSchema, EnginesViewSchema, EngineUpdateInputSchema, EngineWriteResultSchema } from "../../schemas/engines.js";
import {
    BundleExportsSchema,
    BundleStartedSchema,
    BundleTicketSchema,
    EnvironmentApproveSchema,
    EnvironmentContentsSchema,
    EnvironmentRebuildWhenIdleSchema,
    EnvironmentRemoveSchema,
    EnvironmentRuntimeDecisionSchema,
    EnvironmentSchema,
} from "../../schemas/environment.js";
import { SyncStatusSchema } from "../../schemas/devices.js";
import { HostsListSchema } from "../../schemas/hosts.js";
import { VoicesViewSchema } from "../../schemas/voice.js";
import { MemberEmailSchema, MemberGrantSchema, MemberSelfSchema, MembersListSchema, MembersRosterSchema } from "../../schemas/members.js";
import { PhonesListSchema, PhoneWakeRegistrationSchema } from "../../schemas/phone.js";
import { OkSchema } from "../../schemas/shared.js";
import { EnrollCodeAnswerSchema, EnrollCodeRequestSchema, PeerPairingAnswerSchema, SyncPairAnswerSchema, SyncPairRequestSchema } from "../../schemas/short-codes.js";
import { SpeechStatusSchema, SpeechTranscriptSchema } from "../../schemas/speech.js";
import {
    AuthenticationOptionsSchema,
    DaemonSessionSchema,
    PasskeyAssertRequestSchema,
    PasskeyPolicyAnswerSchema,
    PasskeyPolicySchema,
    PasskeyRecoverRequestSchema,
    PasskeyRegisteredSchema,
    PasskeyRegisterRequestSchema,
    PasskeysListSchema,
    RecoveryCodesSchema,
    RegistrationOptionsSchema,
    SessionRecoveredSchema,
} from "../../schemas/system.js";
import { WebExtsListSchema } from "../../schemas/webext.js";
import { UploadManifestSchema, UploadSkipSchema } from "../../schemas/workspace/workspace-upload.js";
import {
    ArrivalAbandonedSchema,
    ArrivalApplySchema,
    ArrivalHostsSchema,
    ArrivalPlanSchema,
    ArrivalReportSchema,
    ArrivalScanSchema,
    ProviderKeysAppliedSchema,
    ProviderKeysApplySchema,
    ProviderKeysSchema,
} from "../../state/arrival.js";
import { DefinitionDiffSchema, DefinitionExportSchema, WorkspacePublishResultSchema, WorkspacePublishSchema, WorkspaceRemoteSchema } from "../../state/definition.js";
import { RunnerDefinitionAppliedSchema, RunnersListSchema } from "../doors/runner-protocol.js";
import type { RawRouteKey } from "./raw-routes.js";

// What a raw route that answers plain JSON takes and answers, under its RAW_ROUTES key. `input` is the JSON body a write
// sends; `text` marks one whose body is a document rather than JSON (a sandbox.toml to diff), and `bytes` one whose body
// is the thing itself (a file's bytes, a WAV, a tar), which the caller hands over as a Blob, an ArrayBuffer or a string.
// A caller reaches these by key through a typed helper that parses the answer with `output`, so a hand-written route is
// as typed as a procedure. What a route takes in its query string (`?id=`, `?path=`) and in a header is the helper's
// `query` and `headers`, since the daemon reads them by name and there is nothing to parse. A refusal is the daemon's
// `{ "error": … }` with a 4xx status on every one of them, outside these schemas.
export interface RawJsonRoute {
    readonly input?: z.ZodType;
    readonly text?: true;
    readonly bytes?: true;
    readonly output: z.ZodType;
}

export const RAW_JSON_ROUTES = {
    // The voices a sandbox speaks with, for the Voice settings (schemas/voice.ts).
    "GET /speech/voices": { output: VoicesViewSchema },
    // A server-connect code for the owner's command (short-codes.ts).
    "POST /system/enroll/code": { input: EnrollCodeRequestSchema, output: EnrollCodeAnswerSchema },
    // The roster is ownership's; every write answers the roster after it.
    "GET /members": { output: MembersRosterSchema },
    "POST /members": { input: MemberGrantSchema, output: MembersListSchema },
    "DELETE /members": { input: MemberEmailSchema, output: MembersListSchema },
    "DELETE /members/self": { output: OkSchema },
    "GET /members/self": { output: MemberSelfSchema },
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
    // Sandboxes moving in: a plan read off an archive (`bytes`) or a connected device, applied by its token, and the
    // model keys the owner's devices hold.
    "GET /arrivals/hosts": { output: ArrivalHostsSchema },
    "POST /arrivals/scan": { input: ArrivalScanSchema, output: ArrivalPlanSchema },
    "POST /arrivals/plan": { bytes: true, output: ArrivalPlanSchema },
    "POST /arrivals/apply": { input: ArrivalApplySchema, output: ArrivalReportSchema },
    "GET /arrivals/keys": { output: ProviderKeysSchema },
    "POST /arrivals/keys/apply": { input: ProviderKeysApplySchema, output: ProviderKeysAppliedSchema },
    "DELETE /arrivals": { output: ArrivalAbandonedSchema },
    // Exports: `?secrets=1` on the start, `?name=` on the delete and the ticket.
    "GET /bundles": { output: BundleExportsSchema },
    "POST /bundles": { output: BundleStartedSchema },
    "DELETE /bundles": { output: OkSchema },
    "POST /bundles/ticket": { output: BundleTicketSchema },
    // Paired machines: each door's roster, the pairing minted for one id (`?id=`), and dropping one's enrollment. The
    // devices' answer is `hosts`, the browsers' `browsers`, the phones' `phones`, the runners' `runners`.
    "GET /system/hosts": { output: HostsListSchema },
    "POST /system/hosts/pair": { output: PeerPairingAnswerSchema },
    "DELETE /system/hosts/{id}": { output: OkSchema },
    "GET /system/webext": { output: WebExtsListSchema },
    "POST /system/webext/pair": { output: PeerPairingAnswerSchema },
    "DELETE /system/webext/{id}": { output: OkSchema },
    "GET /system/phones": { output: PhonesListSchema },
    "POST /system/phones/pair": { output: PeerPairingAnswerSchema },
    "DELETE /system/phones/{id}": { output: OkSchema },
    "POST /system/phones/{id}/wake": { input: PhoneWakeRegistrationSchema, output: OkSchema },
    "GET /system/runners": { output: RunnersListSchema },
    "DELETE /system/runners/{id}": { output: OkSchema },
    "POST /system/runners/{id}/definition/sync": { output: RunnerDefinitionAppliedSchema },
    // Desktop sync: the sandbox-level state, the pairing (`?mode=mirror` asks for the narrower one), one machine's key.
    "GET /system/sync": { output: SyncStatusSchema },
    "POST /system/sync/pair": { input: SyncPairRequestSchema, output: SyncPairAnswerSchema },
    "DELETE /system/authorized-key/{machine}": { output: OkSchema },
    // Every browser session revoked, the owner's own included.
    "POST /system/sessions/revoke": { output: OkSchema },
    "GET /system/control/tokens": { output: ControlTokensListSchema },
    "POST /system/control/tokens": { input: ControlTokenMintSchema, output: ControlTokenMintedSchema },
    "DELETE /system/control/tokens/{id}": { output: OkSchema },
    // One's own passkeys, the require rule and its recovery codes. The two registration calls carry the WebAuthn ceremony's
    // options out and its response back, the shapes the browser's own parser reads and writes.
    "GET /system/passkeys": { output: PasskeysListSchema },
    "POST /system/passkeys/register/options": { output: RegistrationOptionsSchema },
    "POST /system/passkeys/register": { input: PasskeyRegisterRequestSchema, output: PasskeyRegisteredSchema },
    "POST /system/passkeys/policy": { input: PasskeyPolicySchema, output: PasskeyPolicyAnswerSchema },
    "POST /system/passkeys/recovery": { output: RecoveryCodesSchema },
    "DELETE /system/passkeys/{id}": { output: OkSchema },
    // The sign-in's own calls, before any session exists: the assertion is how one is minted, and recovery is the owner's
    // way back in with the code a policy handed out. Their credential is the door's (a challenge, a recovery code under the
    // caller's own proof), so the editor sends them outside its session client (client/session/passkeySignIn.ts) and reads
    // their answers with these schemas.
    "POST /system/passkeys/assert/options": { output: AuthenticationOptionsSchema },
    "POST /system/passkeys/assert": { input: PasskeyAssertRequestSchema, output: DaemonSessionSchema },
    "POST /system/session/recover": { input: PasskeyRecoverRequestSchema, output: SessionRecoveredSchema },
    // Dictation over HTTP, for a daemon without the phrase stream (`?lang=`): the model's readiness, arming it, and one
    // phrase as WAV.
    "GET /speech/status": { output: SpeechStatusSchema },
    "POST /speech/prepare": { output: SpeechStatusSchema },
    "POST /speech/transcribe": { bytes: true, output: SpeechTranscriptSchema },
    // A file written into the tree (`?path=`, the body its bytes, `x-intentic-base-hash` refusing a stale save), and the
    // pre-drop check of which dropped files are already there.
    "POST /workspace/upload": { bytes: true, output: OkSchema },
    // A dropped tree as one tar, extracted entry by entry.
    "POST /workspace/upload-archive": { bytes: true, output: OkSchema },
    "POST /workspace/upload-diff": { input: UploadManifestSchema, output: UploadSkipSchema },
} as const satisfies Partial<Record<RawRouteKey, RawJsonRoute>>;

export type RawJsonRouteKey = keyof typeof RAW_JSON_ROUTES;

// What a JSON raw route answers, parsed.
export type RawJsonOutput<Key extends RawJsonRouteKey> = z.output<(typeof RAW_JSON_ROUTES)[Key]["output"]>;

// The routes that take their body as bytes: a file, a WAV, a tar. Some of these also go up in parts with progress.
export type RawBytesRouteKey = {
    [Key in RawJsonRouteKey]: (typeof RAW_JSON_ROUTES)[Key] extends { readonly bytes: true } ? Key : never;
}[RawJsonRouteKey];

// The body a `bytes` route takes: a Blob or typed array (a file, a tar), an ArrayBuffer (an encoded WAV) or a string
// (a saved file's text).
export type RawBytes = Blob | ArrayBuffer | ArrayBufferView | string;

// What a JSON raw route's body is: its input's shape, a string for a document body, the bytes for a `bytes` route,
// undefined for one that takes none.
export type RawJsonInput<Key extends RawJsonRouteKey> = (typeof RAW_JSON_ROUTES)[Key] extends { readonly input: infer Input extends z.ZodType }
    ? z.input<Input>
    : (typeof RAW_JSON_ROUTES)[Key] extends { readonly text: true }
      ? string
      : (typeof RAW_JSON_ROUTES)[Key] extends { readonly bytes: true }
        ? RawBytes
        : undefined;
