import type { z } from "zod";
import { ControlTokenMintedSchema, ControlTokenMintSchema, ControlTokensListSchema } from "../../policy/control-scopes.js";
import { EngineChannelInputSchema, EngineRevertInputSchema, EnginesViewSchema, EngineUpdateInputSchema, EngineWriteResultSchema } from "../../schemas/engines.js";
import {
    BundleExportsSchema,
    BundleStartedSchema,
    BundleTicketSchema,
    EnvironmentApproveSchema,
    EnvironmentContentsSchema,
    EnvironmentDevSwapWhenIdleSchema,
    EnvironmentRebuildWhenIdleSchema,
    EnvironmentRemoveSchema,
    EnvironmentRuntimeDecisionSchema,
    EnvironmentSchema,
} from "../../schemas/environment.js";
import { SyncChangesSchema, SyncStatusSchema } from "../../schemas/devices.js";
import { ConversationBundleSchema, DiagnosticsAnswerSchema, DiagnosticsAskSchema, DiagnosticsQuerySchema } from "../../schemas/diagnostics.js";
import { HostsListSchema } from "../../schemas/hosts.js";
import { VoicesViewSchema } from "../../schemas/voice.js";
import {
    AccessAskSchema,
    AccessRequestsSchema,
    MemberEmailSchema,
    MemberGrantSchema,
    MemberSelfSchema,
    MembersListSchema,
    MembersRosterSchema,
} from "../../schemas/members.js";
import { PhonesListSchema, PhoneWakeRegistrationSchema } from "../../schemas/phone.js";
import {
    PhoneKeyringsResultSchema,
    PhonePasswordsCaptureResultSchema,
    PhonePasswordsCaptureSchema,
    PhonePasswordsFillResultSchema,
    PhonePasswordsFillSchema,
    PhonePasswordsPairResultSchema,
    PhonePasswordsPairSchema,
} from "../../schemas/phone-passwords.js";
import { OkSchema } from "../../schemas/shared.js";
import {
    DropAcceptedSchema,
    DropBodySchema,
    DropFilesSchema,
    DropSendOutcomeSchema,
    DropSendSchema,
    DropTakenSchema,
    DropTakeSchema,
    PairingMintedSchema,
    PairingMintSchema,
    PairingsListSchema,
    ReceivedDropSchema,
    ReceivedDropsSchema,
    RouteSecretSchema,
    RoutesListSchema,
} from "../../schemas/account-routes.js";
import { PeerPairingAnswerSchema, SyncPairAnswerSchema, SyncPairRequestSchema } from "../../schemas/short-codes.js";
import { SpeechStatusSchema, SpeechTranscriptSchema, SpeechWakeClaimSchema, SpeechWakeGrantSchema } from "../../schemas/speech.js";
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
import {
    InboundLinkMintedSchema,
    InboundLinkMintSchema,
    InboundLinksListSchema,
    InboundLinkSummarySchema,
    InboundLinkTermsUpdateSchema,
    LinkAnswerSchema,
    LinkExecSchema,
    LinkExecStatusSchema,
    LinkHelloSchema,
    LinkMessageReceiptSchema,
    LinkMessageSchema,
    LinkReadAnswerSchema,
    LinkReadSchema,
    LinkRequestDecisionSchema,
    LinkTaskSchema,
    LinkTaskStatusSchema,
    LinkWriteAnswerSchema,
    LinkWriteSchema,
} from "../../schemas/links.js";
import {
    AccountOutboxSchema,
    AccountProjectsSchema,
    AccountReportSchema,
    AccountSendOutcomeSchema,
    AccountSendSchema,
    IssueAcceptedSchema,
} from "../../schemas/issues.js";
import {
    S2sCallSealedSchema,
    S2sContactAcceptInputSchema,
    S2sContactAddSchema,
    S2sContactBootstrapAnswerSchema,
    S2sContactBootstrapRequestSchema,
    S2sContactChangeSchema,
    S2sContactSchema,
    S2sContactsListSchema,
    S2sContactTaskDecisionSchema,
    S2sContactTaskSchema,
    S2sContactTasksSchema,
    S2sDomainInputSchema,
    S2sEnvelopeSchema,
    S2sInboxAcceptedSchema,
    S2sLinkUpgradeAnswerSchema,
    S2sLinkUpgradeRequestSchema,
    S2sMeSchema,
    S2sMessageSendOutcomeSchema,
    S2sMessageSendSchema,
    S2sOutboxSchema,
    S2sPairedSchema,
    S2sPairingAnswerSchema,
    S2sPairingRequestSchema,
    S2sPairingUpgradeAnswerSchema,
    S2sPairingUpgradeRequestSchema,
    S2sRecoverInputSchema,
    S2sRecoveryMintedSchema,
    S2sSessionAnswerSchema,
    S2sSessionOpenSchema,
    S2sTakenSchema,
    S2sTakeSchema,
    S2sThreadSchema,
    S2sThreadsListSchema,
    S2sTrustKeySchema,
    SandboxIdentitySchema,
} from "../../schemas/s2s.js";
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
import {
    RunnerDefinitionAppliedSchema,
    RunnerLabelSchema,
    RunnersListSchema,
} from "../doors/runner-protocol.js";
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
    // The roster is ownership's; every write answers the roster after it.
    "GET /members": { output: MembersRosterSchema },
    "POST /members": { input: MemberGrantSchema, output: MembersListSchema },
    "DELETE /members": { input: MemberEmailSchema, output: MembersListSchema },
    "DELETE /members/self": { output: OkSchema },
    "GET /members/self": { output: MemberSelfSchema },
    "POST /members/requests": { input: AccessAskSchema, output: MemberSelfSchema },
    "GET /members/requests": { output: AccessRequestsSchema },
    "DELETE /members/requests": { input: MemberEmailSchema, output: AccessRequestsSchema },
    // Every environment write answers the environment after it. `/environment/contents` takes `?refresh` to probe again.
    "GET /environment": { output: EnvironmentSchema },
    "GET /environment/contents": { output: EnvironmentContentsSchema },
    "POST /environment/approve": { input: EnvironmentApproveSchema, output: EnvironmentSchema },
    "POST /environment/reject": { output: EnvironmentSchema },
    "POST /environment/runtime-install": { input: EnvironmentRuntimeDecisionSchema, output: EnvironmentSchema },
    "POST /environment/remove": { input: EnvironmentRemoveSchema, output: EnvironmentSchema },
    "POST /environment/rebuild-when-idle": { input: EnvironmentRebuildWhenIdleSchema, output: EnvironmentSchema },
    "DELETE /environment/rebuild-when-idle": { output: EnvironmentSchema },
    "POST /environment/dev-swap-when-idle": { input: EnvironmentDevSwapWhenIdleSchema, output: EnvironmentSchema },
    "DELETE /environment/dev-swap-when-idle": { output: EnvironmentSchema },
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
    "GET /system/phones/passwords/keyrings": { output: PhoneKeyringsResultSchema },
    "POST /system/phones/passwords/pair": { input: PhonePasswordsPairSchema, output: PhonePasswordsPairResultSchema },
    "POST /system/phones/passwords/capture": { input: PhonePasswordsCaptureSchema, output: PhonePasswordsCaptureResultSchema },
    "POST /system/phones/passwords/fill": { input: PhonePasswordsFillSchema, output: PhonePasswordsFillResultSchema },
    "GET /system/runners": { output: RunnersListSchema },
    "DELETE /system/runners/{id}": { output: OkSchema },
    "POST /system/runners/{id}/definition/sync": { output: RunnerDefinitionAppliedSchema },
    // A runner's name for people (its id never changes); empty clears it.
    "POST /system/runners/{id}/label": { input: RunnerLabelSchema, output: OkSchema },
    // Desktop sync: the sandbox-level state, the pairing (`?mode=mirror` asks for the narrower one), one machine's key.
    "GET /system/sync": { output: SyncStatusSchema },
    "GET /system/sync/changes": { output: SyncChangesSchema },
    "POST /system/sync/pair": { input: SyncPairRequestSchema, output: SyncPairAnswerSchema },
    "DELETE /system/authorized-key/{machine}": { output: OkSchema },
    // Every browser session revoked, the owner's own included.
    "POST /system/sessions/revoke": { output: OkSchema },
    // Inbound links: the roster, a mint (its token shown once), new terms, a revoke, and the owner's answer to a waiting task.
    "GET /system/links": { output: InboundLinksListSchema },
    "POST /system/links": { input: InboundLinkMintSchema, output: InboundLinkMintedSchema },
    "POST /system/links/{id}": { input: InboundLinkTermsUpdateSchema, output: InboundLinkSummarySchema },
    "DELETE /system/links/{id}": { output: OkSchema },
    "POST /system/links/{id}/requests/{request}": { input: LinkRequestDecisionSchema, output: InboundLinkSummarySchema },
    // Another sandbox on the owner's account reporting a problem about a project this one claims (schemas/issues.ts).
    "POST /account/report": { input: AccountReportSchema, output: IssueAcceptedSchema },
    // A task routed as a person: the link doors' own shapes, behind a pass and a pairing instead of a link token.
    "POST /account/task": { input: LinkTaskSchema, output: LinkTaskStatusSchema },
    "GET /account/task/{id}": { output: LinkTaskStatusSchema },
    "POST /account/task/{id}/messages": { input: LinkMessageSchema, output: LinkMessageReceiptSchema },
    "POST /account/task/{id}/answer": { input: LinkAnswerSchema, output: OkSchema },
    "POST /account/task/{id}/stop": { output: LinkTaskStatusSchema },
    "POST /account/outbox": { input: AccountSendSchema, output: AccountSendOutcomeSchema },
    "GET /account/outbox": { output: AccountOutboxSchema },
    "GET /account/projects": { output: AccountProjectsSchema },
    "GET /account/projects/suggest": { output: AccountProjectsSchema },
    // Routing as a person: the pairings this sandbox keeps for others, and the secrets it holds for itself.
    "POST /account/pairings": { input: PairingMintSchema, output: PairingMintedSchema },
    "GET /account/pairings": { output: PairingsListSchema },
    "DELETE /account/pairings/{from}": { output: OkSchema },
    "POST /account/routes/secret": { input: RouteSecretSchema, output: OkSchema },
    "GET /account/routes": { output: RoutesListSchema },
    // Routing as a person: a drop between daemons, the sending side's loopback send, and the inbox it lands in.
    "POST /account/drop": { input: DropBodySchema, output: DropAcceptedSchema },
    "POST /account/drops": { input: DropSendSchema, output: DropSendOutcomeSchema },
    "GET /account/inbox": { output: ReceivedDropsSchema },
    "GET /account/inbox/{id}": { output: ReceivedDropSchema },
    "GET /account/inbox/{id}/files": { output: DropFilesSchema },
    "POST /account/inbox/{id}/take": { input: DropTakeSchema, output: DropTakenSchema },
    "DELETE /account/inbox/{id}": { output: OkSchema },
    // A read as a person answers what the fleet's own reads answer (GET /fleet…, POST /diagnostics).
    "POST /account/read/diagnostics": { input: DiagnosticsQuerySchema, output: DiagnosticsAnswerSchema },
    "GET /account/read/agents/{handle}/bundle": { output: ConversationBundleSchema },
    // The link doors, as the asking sandbox's daemon reads them. A status takes `?after=<version>&wait=<seconds>` to
    // be held until it moves past that version.
    "GET /link": { output: LinkHelloSchema },
    "POST /link/conversations": { input: LinkTaskSchema, output: LinkTaskStatusSchema },
    "GET /link/conversations/{id}": { output: LinkTaskStatusSchema },
    "POST /link/conversations/{id}/messages": { input: LinkMessageSchema, output: LinkMessageReceiptSchema },
    "POST /link/conversations/{id}/answer": { input: LinkAnswerSchema, output: OkSchema },
    "POST /link/conversations/{id}/stop": { output: LinkTaskStatusSchema },
    // A link's records: the diagnostics answer and a conversation's bundle. The fleet reads answer as the `agents`
    // command's own routes do, which have no shared schema.
    "POST /link/records/diagnostics": { input: DiagnosticsQuerySchema, output: DiagnosticsAnswerSchema },
    "GET /link/records/fleet/{handle}/bundle": { output: ConversationBundleSchema },
    // A link's operating doors: a command started and read again (`?wait=<seconds>` holds a read until it ends), stopped,
    // a file or directory read, and a file written.
    "POST /link/operate/exec": { input: LinkExecSchema, output: LinkExecStatusSchema },
    "GET /link/operate/exec/{id}": { output: LinkExecStatusSchema },
    "POST /link/operate/exec/{id}/stop": { output: LinkExecStatusSchema },
    "POST /link/operate/read": { input: LinkReadSchema, output: LinkReadAnswerSchema },
    "POST /link/operate/write": { input: LinkWriteSchema, output: LinkWriteAnswerSchema },
    // Sandbox-to-sandbox (schemas/s2s.ts): the doors another daemon calls; a call's input and answer are sealed, its
    // method's own shapes inside (S2S_CALLS). A message's file (`GET /s2s/messages/{id}/files/{name}`) answers its bytes.
    "GET /s2s/identity": { output: SandboxIdentitySchema },
    "POST /s2s/inbox": { input: S2sEnvelopeSchema, output: S2sInboxAcceptedSchema },
    "POST /s2s/session": { input: S2sSessionOpenSchema, output: S2sSessionAnswerSchema },
    "POST /s2s/call/{method}": { input: S2sCallSealedSchema, output: S2sCallSealedSchema },
    "POST /link/upgrade": { input: S2sLinkUpgradeRequestSchema, output: S2sLinkUpgradeAnswerSchema },
    "POST /account/pairings/upgrade": { input: S2sPairingUpgradeRequestSchema, output: S2sPairingUpgradeAnswerSchema },
    "POST /account/contact-bootstrap": { input: S2sContactBootstrapRequestSchema, output: S2sContactBootstrapAnswerSchema },
    // The Messages tab's Identity section: every write answers the identity after it, but the recovery key, said once.
    "GET /s2s/me": { output: S2sMeSchema },
    "POST /s2s/me/domains": { input: S2sDomainInputSchema, output: S2sMeSchema },
    "DELETE /s2s/me/domains/{domain}": { output: S2sMeSchema },
    "POST /s2s/me/domains/{domain}/check": { output: S2sMeSchema },
    "POST /s2s/me/rotate": { output: S2sMeSchema },
    "POST /s2s/me/recovery": { output: S2sRecoveryMintedSchema },
    "POST /s2s/me/recover": { input: S2sRecoverInputSchema, output: S2sMeSchema },
    // Contacts: every write answers the contact after it.
    "GET /s2s/contacts": { output: S2sContactsListSchema },
    "POST /s2s/contacts/paired": { input: S2sPairedSchema, output: S2sContactSchema },
    "POST /s2s/contacts": { input: S2sContactAddSchema, output: S2sContactSchema },
    "POST /s2s/contacts/{id}": { input: S2sContactChangeSchema, output: S2sContactSchema },
    "DELETE /s2s/contacts/{id}": { output: OkSchema },
    "POST /s2s/contacts/{id}/accept": { input: S2sContactAcceptInputSchema, output: S2sContactSchema },
    "POST /s2s/contacts/{id}/block": { output: S2sContactSchema },
    "POST /s2s/contacts/{id}/trust-key": { input: S2sTrustKeySchema, output: S2sContactSchema },
    "GET /s2s/tasks": { output: S2sContactTasksSchema },
    "POST /s2s/contacts/{id}/tasks/{request}": { input: S2sContactTaskDecisionSchema, output: S2sContactTaskSchema },
    "GET /s2s/contacts/{id}/tasks/{request}/watch": { output: LinkTaskStatusSchema },
    "GET /s2s/outbox": { output: S2sOutboxSchema },
    "POST /s2s/pairings": { input: S2sPairingRequestSchema, output: S2sPairingAnswerSchema },
    // The inbox.
    "GET /s2s/threads": { output: S2sThreadsListSchema },
    "GET /s2s/threads/{id}": { output: S2sThreadSchema },
    "DELETE /s2s/threads/{id}": { output: OkSchema },
    "POST /s2s/threads/{id}/read": { output: OkSchema },
    "POST /s2s/messages": { input: S2sMessageSendSchema, output: S2sMessageSendOutcomeSchema },
    "POST /s2s/messages/{id}/take": { input: S2sTakeSchema, output: S2sTakenSchema },
    "POST /diagnostics": { input: DiagnosticsAskSchema, output: DiagnosticsAnswerSchema },
    "GET /fleet/{handle}/bundle": { output: ConversationBundleSchema },
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
    // One device's claim on a wake word it heard, so two devices hearing the same "Leon" open one session between them.
    "POST /speech/wake": { input: SpeechWakeClaimSchema, output: SpeechWakeGrantSchema },
    // A file written into the tree (`?path=`, the body its bytes, `x-intentic-base-hash` refusing a stale save), and the
    // pre-drop check of which dropped files are already there.
    "POST /workspace/upload": { bytes: true, output: OkSchema },
    // A dropped tree as one tar, extracted entry by entry.
    "POST /workspace/upload-archive": { bytes: true, output: OkSchema },
    "POST /workspace/upload-diff": { input: UploadManifestSchema, output: UploadSkipSchema },
    // One file for a page's file chooser or a drop (`?id=` the uploader's, `&name=` the file's own), in parts like a
    // workspace upload; answered by browser.answerFileChooser or browser.dropFiles naming the id.
    "POST /browser/uploads": { bytes: true, output: OkSchema },
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
