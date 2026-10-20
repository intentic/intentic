import { t } from "@intentic/ui/i18n";
import type { SettingEntry } from "../../workbench/hub/hubSearch";

// The sandbox hub's cards, as the hub's search and the palette find them (workbench/hub/hubSearch.ts): beside
// sandboxNav.ts, which names the pages, for the same reason that table exists. Each `id` is the `data-setting` mark on
// the card it names, prefixed by its page, and hubSearch.test.ts holds the two to each other, so a card renamed, moved
// or removed here is refused there rather than found by a search that lands on nothing.
//
// A card is listed when it is a setting someone comes looking for. A list (every secret, member, persona, area) is its
// page's, found by the page's name and words; a card drawn only in a passing state (a backup to make, an update to take)
// is the page's news, not a place. The page gates what a reader may open (sandboxSections); `shown` repeats a card's own
// `v-if` where it turns on something the search can know (hubSearch.ts HubReader).

/** The words people use for a page that its name does not hold, by slug. */
export const sandboxPageTerms = () =>
    ({
        overview: t(`sandbox.search.pages.overview`),
        usage: t(`sandbox.search.pages.usage`),
        models: t(`sandbox.search.pages.models`),
        agent: t(`sandbox.search.pages.agent`),
        environment: t(`sandbox.search.pages.environment`),
        secrets: t(`sandbox.search.pages.secrets`),
        extensions: t(`sandbox.search.pages.extensions`),
        access: t(`sandbox.search.pages.access`),
        areas: t(`sandbox.search.pages.areas`),
        personas: t(`sandbox.search.pages.personas`),
        map: t(`sandbox.search.pages.map`),
        "data-protection": t(`sandbox.search.pages.dataProtection`),
        "privacy-shield": t(`sandbox.search.pages.privacyShield`),
        guardrails: t(`sandbox.search.pages.guardrails`),
        retention: t(`sandbox.search.pages.retention`),
        activity: t(`sandbox.search.pages.activity`),
        audit: t(`sandbox.search.pages.audit`),
    }) satisfies Readonly<Record<string, string>>;

// The words are read by the entries' own functions, when a search asks, since at import time no catalog is registered
// to read them from. In the index's own order: the box, its configuration, who it reaches, then how it handles what
// passes through it.
export const SANDBOX_CARDS: readonly SettingEntry[] = [
    // Overview: what the sandbox is called and looks like, its share of the machine, and its disk. The rest of the page
    // is the sandbox's own report on itself, read rather than set.
    {
        id: `overview-name`,
        slug: `overview`,
        title: () => t(`sandbox.sandboxOverview.sandboxName`),
        terms: () => [t(`sandbox.sandboxOverview.renameSandbox`), t(`sandbox.sandboxOverview.logoChange`), t(`sandbox.search.overviewName`)],
    },
    {
        id: `overview-resources`,
        slug: `overview`,
        title: () => t(`sandbox.sandboxOverview.resources`),
        terms: () => [t(`sandbox.search.overviewResources`)],
    },
    // Drawn only for a sandbox on somebody's own machine (SandboxSleepRow.vue); the reader does not know where it runs,
    // so a hosted sandbox's search finds the page without the row.
    {
        id: `overview-sleep`,
        slug: `overview`,
        title: () => t(`sandbox.sandboxOverview.sleep`),
        terms: () => [t(`sandbox.search.overviewSleep`)],
    },
    // Maintainer-only like the routes behind it; the card hides itself below that.
    {
        id: `overview-disk`,
        slug: `overview`,
        title: () => t(`sandbox.sandboxStorageCard.heading`),
        terms: () => [t(`sandbox.search.overviewDisk`)],
        shown: (reader) => reader.canShip,
    },

    // Agent: one card per setting, under the page's four categories (its `?section=`). Jobs is the page's default
    // category, which writes no param (SandboxAgent.vue), so its card names the category for the trail and no `part`.
    {
        id: `agent-model-setups`,
        slug: `agent`,
        partLabel: () => t(`sandbox.sandboxAgent.jobs`),
        title: () => t(`sandbox.agentModels.setups`),
        terms: () => [t(`sandbox.agentModels.howAutoChooses`), t(`sandbox.search.agentModelSetups`)],
    },
    // Instructions: told every turn, told per matching job, remembered, then brought over from elsewhere. The first card is
    // called Instructions like its category, so the result is named for the one setting it holds.
    {
        id: `agent-system-prompt`,
        slug: `agent`,
        part: `instructions`,
        partLabel: () => t(`sandbox.words.instructions`),
        title: () => t(`sandbox.words.systemPrompt`),
        terms: () => [t(`sandbox.words.instructions`), t(`sandbox.search.agentSystemPrompt`)],
    },
    {
        id: `agent-skills`,
        slug: `agent`,
        part: `instructions`,
        partLabel: () => t(`sandbox.words.instructions`),
        title: () => t(`sandbox.agentSkills.skills`),
        terms: () => [t(`sandbox.words.writeSkill`), t(`sandbox.search.agentSkills`)],
    },
    {
        id: `agent-memory`,
        slug: `agent`,
        part: `instructions`,
        partLabel: () => t(`sandbox.words.instructions`),
        title: () => t(`sandbox.agentMemory.memory`),
        terms: () => [t(`sandbox.search.agentMemory`)],
    },
    {
        id: `agent-memory-import`,
        slug: `agent`,
        part: `instructions`,
        partLabel: () => t(`sandbox.words.instructions`),
        title: () => t(`sandbox.agentMemory.bringMemoryOverAnother`),
        terms: () => [t(`sandbox.agentMemory.addToMemory`), t(`sandbox.search.agentMemoryImport`)],
    },
    // Tools: finding code and documents, feedback after edits, command output, what it may answer with besides words,
    // then how much it may delegate and where the heaviest of it runs.
    {
        id: `agent-code-search`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`sandbox.agentCodeSearch.codeSearch`),
        terms: () => [
            t(`sandbox.agentCodeSearch.iqCodeSearch`),
            t(`sandbox.agentCodeSearch.projectMap`),
            t(`sandbox.agentCodeSearch.fieldNotes`),
            t(`sandbox.search.agentCodeSearch`),
        ],
    },
    {
        id: `agent-document-search`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`sandbox.agentDocumentSearch.group`),
        terms: () => [t(`sandbox.agentDocumentSearch.title`), t(`sandbox.search.agentDocumentSearch`)],
    },
    {
        id: `agent-repo-checks`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`sandbox.agentRepoChecks.checksAfterEdits`),
        terms: () => [t(`sandbox.search.agentRepoChecks`)],
    },
    {
        id: `agent-command-output`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`sandbox.agentCommandOutput.commandOutput`),
        terms: () => [t(`sandbox.agentCommandOutput.cleanCommandOutput`), t(`sandbox.search.agentCommandOutput`)],
    },
    {
        id: `agent-tool-loading`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`sandbox.agentToolLoading.group`),
        terms: () => [t(`sandbox.agentToolLoading.onDemand`), t(`sandbox.search.agentToolLoading`)],
    },
    {
        id: `agent-chat-pages`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`sandbox.agentChatPages.group`),
        terms: () => [t(`sandbox.agentChatPages.title`), t(`sandbox.search.agentChatPages`)],
    },
    // The spoken half of hands-free; the listening half, this device's own wake word, is Settings ▸ Voice.
    {
        id: `agent-voice`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`sandbox.agentVoice.group`),
        terms: () => [
            t(`sandbox.agentVoice.replies`),
            t(`sandbox.agentVoice.interrupt`),
            t(`sandbox.agentVoice.speed`),
            t(`sandbox.agentVoice.wakeWord`),
            t(`sandbox.agentVoice.voiceFor`),
            t(`sandbox.search.agentVoice`),
        ],
    },
    {
        id: `agent-speech-provider`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`sandbox.agentVoice.providerGroup`),
        terms: () => [
            t(`sandbox.agentVoice.secret`),
            t(`sandbox.agentVoice.model`),
            t(`sandbox.agentVoice.cloudVoice`),
            t(`sandbox.search.agentSpeechProvider`),
        ],
    },
    {
        id: `agent-subagents`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`shared.subagents`),
        terms: () => [
            t(`sandbox.agentSubagents.subagentsAtOnce`),
            t(`sandbox.agentSubagents.subagentsPerConversation`),
            t(`sandbox.agentSubagents.nestingDepth`),
            t(`sandbox.agentSubagents.planByAllowance`),
            t(`sandbox.agentSubagents.keepRoomForYou`),
            t(`sandbox.search.agentSubagents`),
        ],
    },
    {
        id: `agent-offload`,
        slug: `agent`,
        part: `tools`,
        partLabel: () => t(`sandbox.sandboxAgent.tools`),
        title: () => t(`sandbox.agentOffload.title`),
        terms: () => [t(`sandbox.agentOffload.sessionsTitle`), t(`sandbox.search.agentOffload`)],
    },
    // Finishing: what happens once a job is done (main's CI, delivery, the changelog), then what happens when one breaks,
    // then the two settings about time: idle chats and the clock schedules run by.
    {
        id: `agent-main-ci`,
        slug: `agent`,
        part: `finishing`,
        partLabel: () => t(`sandbox.sandboxAgent.finishing`),
        title: () => t(`sandbox.agentChecks.mainCi`),
        terms: () => [t(`sandbox.agentChecks.repairMainCi`), t(`sandbox.search.agentMainCi`)],
    },
    {
        id: `agent-finished-work`,
        slug: `agent`,
        part: `finishing`,
        partLabel: () => t(`sandbox.sandboxAgent.finishing`),
        title: () => t(`sandbox.agentFinishedWork.finishedWork`),
        terms: () => [
            t(`sandbox.words.landFinishedWorkAutomatically`),
            t(`sandbox.words.saveVersionAcceptedWork`),
            t(`sandbox.agentFinishedWork.followOrigin`),
            t(`sandbox.agentFinishedWork.archiveFinishedAgents`),
            t(`sandbox.search.agentFinishedWork`),
        ],
    },
    {
        id: `agent-changelog`,
        slug: `agent`,
        part: `finishing`,
        partLabel: () => t(`sandbox.sandboxAgent.finishing`),
        title: () => t(`sandbox.agentChangelog.changelog`),
        terms: () => [t(`sandbox.search.agentChangelog`)],
    },
    {
        id: `agent-turn-breaks`,
        slug: `agent`,
        part: `finishing`,
        partLabel: () => t(`sandbox.sandboxAgent.finishing`),
        title: () => t(`sandbox.agentRecovery.turnBreaks`),
        terms: () => [
            t(`sandbox.agentRecovery.handoff`),
            t(`sandbox.agentRecovery.resumeTurnsAfterRestart`),
            t(`sandbox.agentRecovery.stopFailingAutomation`),
            t(`sandbox.agentRecovery.threadsAtOnce`),
            t(`sandbox.search.agentTurnBreaks`),
        ],
    },
    {
        id: `agent-idle-chats`,
        slug: `agent`,
        part: `finishing`,
        partLabel: () => t(`sandbox.sandboxAgent.finishing`),
        title: () => t(`sandbox.agentRecovery.keepWarmGroup`),
        terms: () => [t(`sandbox.agentRecovery.keepWarm`), t(`sandbox.agentRecovery.keepWarmReserve`), t(`sandbox.search.agentIdleChats`)],
    },
    {
        id: `agent-clock`,
        slug: `agent`,
        part: `finishing`,
        partLabel: () => t(`sandbox.sandboxAgent.finishing`),
        title: () => t(`sandbox.agentClock.clock`),
        terms: () => [t(`sandbox.agentClock.scheduleTimesAreIn`), t(`sandbox.search.agentClock`)],
    },

    // Models has no card here: the page is one grid of providers, and the panel under it opens by `?open=`, which an
    // entry cannot name. The page's own words (sandbox.search.pages.models) find it.

    // Environment: the overlay card is the page itself (it shares the page's name and is drawn only once there is an
    // overlay), so its cards here are the engines, then taking the sandbox out and bringing another's in.
    {
        id: `environment-engines`,
        slug: `environment`,
        title: () => t(`sandbox.enginesCard.agentEngines`),
        terms: () => [t(`sandbox.search.environmentEngines`)],
    },
    // Drawn from access/ (ExportCard.vue, ImportCard.vue), for everyone: an owner-only note stands in for the panel below
    // that.
    { id: `environment-export`, slug: `environment`, title: () => t(`sandbox.words.export`), terms: () => [t(`sandbox.search.environmentExport`)] },
    {
        id: `environment-import`,
        slug: `environment`,
        title: () => t(`sandbox.importCard.import`),
        terms: () => [t(`sandbox.search.environmentImport`)],
    },

    // Secrets: the page's own actions (adding one, the capabilities that hold the rest), then the keyrings on the
    // owner's computers it reaches. Every secret itself is a row of the page's list, found by the page's own filter.
    {
        id: `secrets-add`,
        slug: `secrets`,
        title: () => t(`sandbox.sandboxSecrets.addSecret`),
        terms: () => [t(`sandbox.sandboxSecrets.manageCapabilities`), t(`sandbox.sandboxSecrets.pushToCi`), t(`sandbox.search.secretsAdd`)],
    },
    {
        id: `secrets-keyrings`,
        slug: `secrets`,
        title: () => t(`sandbox.keyrings.title`),
        terms: () => [t(`sandbox.keyrings.pair`), t(`sandbox.search.secretsKeyrings`)],
    },

    // Access: who may come in and what they are told (People, the page's default part, which writes no param), how they
    // prove it (Sign-in), and what programs and other sandboxes hold (Programs). A member sees People and Passkeys; the
    // rest is a maintainer's. Allowed has no card: it is a list, found by the page's own words.
    {
        id: `access-people`,
        slug: `access`,
        partLabel: () => t(`sandbox.sandboxAccess.partPeople`),
        title: () => t(`sandbox.sandboxAccess.people`),
        terms: () => [t(`sandbox.sandboxAccess.addPerson`), t(`sandbox.search.accessPeople`)],
    },
    {
        id: `access-ai-notice`,
        slug: `access`,
        partLabel: () => t(`sandbox.sandboxAccess.partPeople`),
        title: () => t(`sandbox.sandboxAccess.aiNotice`),
        terms: () => [t(`sandbox.search.accessAiNotice`)],
        shown: (reader) => reader.canShip,
    },
    {
        id: `access-passkeys`,
        slug: `access`,
        part: `sign-in`,
        partLabel: () => t(`sandbox.sandboxAccess.partSignIn`),
        title: () => t(`sandbox.passkeysSection.passkeys`),
        terms: () => [t(`sandbox.words.addPasskey`), t(`sandbox.passkeysSection.requirePasskeyToOpen`), t(`sandbox.search.accessPasskeys`)],
    },
    {
        id: `access-signed-in-browsers`,
        slug: `access`,
        part: `sign-in`,
        partLabel: () => t(`sandbox.sandboxAccess.partSignIn`),
        title: () => t(`sandbox.sandboxAccess.signedInBrowsers`),
        terms: () => [t(`sandbox.sandboxAccess.signOutEverywhere`), t(`sandbox.search.accessSignedInBrowsers`)],
        shown: (reader) => reader.canShip,
    },
    {
        id: `access-api-tokens`,
        slug: `access`,
        part: `programs`,
        partLabel: () => t(`sandbox.sandboxAccess.partPrograms`),
        title: () => t(`shared.apiTokens`),
        terms: () => [t(`sandbox.controlTokensSection.mintToken`), t(`sandbox.search.accessApiTokens`)],
        shown: (reader) => reader.canShip,
    },
    {
        id: `access-linked-sandboxes`,
        slug: `access`,
        part: `programs`,
        partLabel: () => t(`sandbox.sandboxAccess.partPrograms`),
        title: () => t(`sandbox.linkedSandboxes.title`),
        terms: () => [t(`sandbox.linkedSandboxes.newLink`), t(`sandbox.search.accessLinkedSandboxes`)],
        shown: (reader) => reader.canShip,
    },

    // Personas: whether a new chat is matched to one. The personas themselves are the page's list.
    {
        id: `personas-new-chats`,
        slug: `personas`,
        title: () => t(`sandbox.sandboxPersonas.newChats`),
        terms: () => [t(`sandbox.sandboxPersonas.matchNewChatsTo`), t(`sandbox.search.personasNewChats`)],
    },

    // Privacy & safety ▸ Data protection: a stepped page whose first two steps are lists the daemon's report decides, so
    // neither is a card someone comes back to change. The documents are, behind the page's own `?step=`.
    {
        id: `data-protection-documents`,
        slug: `data-protection`,
        part: `documents`,
        partKey: `step`,
        title: () => t(`sandbox.dataProtection.step.documents`),
        terms: () => [
            t(`sandbox.dataProtection.document.ropa`),
            t(`sandbox.dataProtection.document.dpia`),
            t(`sandbox.dataProtection.document.toms`),
            t(`sandbox.search.dataProtectionDocuments`),
        ],
    },

    // Privacy & safety ▸ Privacy shield: the shield and everything it is told, then what the editor itself sends.
    // Trusted providers and learned datasets are cards of their own only while the shield is on, so they are found
    // through the card that turns it on rather than as answers that would land on nothing while it is off.
    {
        id: `privacy-shield-personal-data`,
        slug: `privacy-shield`,
        title: () => t(`sandbox.agentPrivacyShield.shieldPersonalData`),
        terms: () => [
            t(`sandbox.agentPrivacyShield.lookFor`),
            t(`sandbox.agentPrivacyShield.images`),
            t(`sandbox.agentPrivacyShield.names`),
            t(`sandbox.agentPrivacyShield.dictionaryTitle`),
            t(`sandbox.agentPrivacyShield.rules`),
            t(`sandbox.agentPrivacyShield.neverMasked`),
            t(`sandbox.agentPrivacyShield.try.title`),
            t(`sandbox.agentPrivacyShield.trustedProviders`),
            t(`sandbox.agentPrivacyShield.datasets`),
            t(`sandbox.search.privacyShieldPersonalData`),
        ],
    },
    {
        id: `privacy-shield-analytics`,
        slug: `privacy-shield`,
        title: () => t(`sandbox.privacyShieldPage.sentToIntentic`),
        terms: () => [t(`sandbox.analytics.title`), t(`sandbox.search.privacyShieldAnalytics`)],
    },

    // Privacy & safety ▸ Guardrails: whether a person is asked before a command runs (the judge, installs), what the
    // judge reads, then what may reach outside and what may start work from outside.
    {
        id: `guardrails-judge`,
        slug: `guardrails`,
        title: () => t(`sandbox.agentSafetyJudge.safetyJudge`),
        terms: () => [
            t(`sandbox.agentSafetyJudge.toJudge`),
            t(`sandbox.agentSafetyJudge.judgeModel`),
            t(`sandbox.agentSafetyRules.whatGetsStopped`),
            t(`sandbox.search.guardrailsJudge`),
        ],
    },
    {
        id: `guardrails-project-installs`,
        slug: `guardrails`,
        title: () => t(`sandbox.agentProjectInstalls.title`),
        terms: () => [t(`sandbox.agentProjectInstalls.whenInstalls`), t(`sandbox.search.guardrailsProjectInstalls`)],
    },
    {
        id: `guardrails-policy`,
        slug: `guardrails`,
        title: () => t(`sandbox.agentSafetyPolicy.safetyPolicy`),
        terms: () => [t(`sandbox.search.guardrailsPolicy`)],
    },
    {
        id: `guardrails-outside-actions`,
        slug: `guardrails`,
        title: () => t(`sandbox.guardrails.actions.title`),
        terms: () => [t(`sandbox.agentSubagents.spawnSubagents`), t(`sandbox.search.guardrailsOutsideActions`)],
    },
    {
        id: `guardrails-admission`,
        slug: `guardrails`,
        title: () => t(`sandbox.guardrails.admission.title`),
        terms: () => [
            t(`sandbox.guardrails.admission.webchat`),
            t(`sandbox.guardrails.admission.issues`),
            t(`sandbox.guardrails.admission.listener`),
            t(`sandbox.guardrails.admission.event`),
            t(`sandbox.guardrails.admission.schedule`),
            t(`sandbox.guardrails.admission.workspace`),
            t(`sandbox.guardrails.admission.workflow`),
            t(`sandbox.search.guardrailsAdmission`),
        ],
    },

    // Privacy & safety ▸ Retention: how long each record is kept, then how the audit trail is kept (AuditKeeping.vue,
    // drawn on this page).
    {
        id: `retention-periods`,
        slug: `retention`,
        title: () => t(`sandbox.retention.title`),
        terms: () => [
            t(`sandbox.retention.transcripts`),
            t(`sandbox.retention.restorePoints`),
            t(`sandbox.retention.privacyVault`),
            t(`sandbox.retention.caches`),
            t(`sandbox.retention.rawOutput`),
            t(`sandbox.retention.audit`),
            t(`sandbox.search.retentionPeriods`),
        ],
    },
    {
        id: `retention-audit`,
        slug: `retention`,
        title: () => t(`sandbox.retention.auditKeeping`),
        terms: () => [t(`sandbox.sandboxAudit.readsTitle`), t(`sandbox.sandboxAudit.forwardTitle`), t(`sandbox.search.retentionAudit`)],
    },

    // Activity and its Audit log are records, read and never set: found by their pages' names alone.
];
