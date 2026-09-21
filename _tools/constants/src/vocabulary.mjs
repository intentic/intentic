// The words this repository has retired, and what each became. Read by `_tools/checks/vocabulary.mjs`, which refuses a
// tree that spells one of them again, and by anything else that needs the list as data rather than as prose.
// A word is here because it named more than one idea or had to be taught; the reasoning is in docs/design/vocabulary.md.
//
// A pattern is the SPELLINGS of the retired word, not the English word itself: `slice` stays legal because
// `Array.prototype.slice` owns it, so what is refused is `SliceSchema`, never `text.slice(0, 5)`.

/** @type {readonly {id: string, pattern: RegExp, became: string, since: string}[]} */
export const RETIRED = [
    {
        id: "slice",
        pattern: /\b(SliceSchema|SlicesListSchema|SliceFolderSchema|SliceIdParamSchema|SandboxSlices|useSlices|SlicePicker|slice-scope)\b/,
        became: "area",
        since: "2026-09-20",
    },
    {
        id: "desk-role",
        pattern: /\b(isDesk|deskFence|useDeskFence|deskPaths|deskAllowedPath|deskless|DeskPicker|DESK_HOME|DESK_ROOTS|deskReach)\b/,
        became: "guest",
        since: "2026-09-21",
    },
    {
        id: "desk-home",
        pattern: /\b(DeskView|DeskTile|DeskPeek|useDesk|useDeskActions|DESK_DIR_ACTIONS|resetDesk|deskGrid|deskLayout|deskOrder|deskResults|showDesk)\b/,
        became: "home",
        since: "2026-09-21",
    },
    {
        id: "desk-profile",
        pattern: /\b(DESK_VARIANT|DeskLanding|DeskShot|deskLanding|deskEdition|buildDeskAppSchema|DESK_SHOTS)\b/,
        became: "maker",
        since: "2026-09-21",
    },
    {
        id: "front-desk",
        pattern: /\b(FRONT_DESK|FrontDesk|frontDesk|front-desk|Front Desk|front desk)\b/,
        became: "visitor chat",
        since: "2026-09-21",
    },
    {
        id: "card-persona",
        pattern: /\b(personaCard|reachableCards)\b|wearing this card/,
        became: "persona",
        since: "2026-09-21",
    },
    {
        id: "card-request",
        pattern:
            /\b(CARD_FIELDS|CardField|TranscriptCards|holdsCard|settledCards|cancelledCards|raiseCard|liveCardRun|offer-card|card-status|PermissionCardSchema|PlanCardSchema|QuestionCardSchema|ParkedCardSchema|CardDocumentSchema|planCard|questionCard|permissionCard|browserHelpCard|terminalHelpCard|capabilityOfferCard|paymentOfferCard|credentialOfferCard)\b/,
        became: "request",
        since: "2026-09-21",
    },
    {
        id: "card-catalog",
        pattern: /\b(CatalogCard|contributionCard|connectableCards|cardDiscriminator|contributedCardOf|hostCard|hostCardOf|CapabilityCardParamSchema)\b/,
        became: "catalog entry",
        since: "2026-09-21",
    },
    {
        id: "host-device",
        // `HostConfig` is absent on purpose: it is DOCKER's own inspect key, which the carve-out below already
        // exempts, and matching the bare word renamed five `docker inspect` readers to a key that never exists.
        pattern: /\b(hostContract|HostFacts|HostFactsSchema|HostScopes|HostScopesSchema|HostConfigSchema|hostHandler)\b|host\.contract|host\.handler|kind: "host"|kind === "host"|kind !== "host"|z\.literal\("host"\)|"kind": "host"/,
        became: "device (extension-host, docker host and the `host` ADDRESS field are untouched)",
        since: "2026-09-21",
    },
    {
        id: "anchor-checkpoint",
        pattern: /\b(TurnAnchor|TurnAnchors|turnAnchors|takeSteerAnchors|anchorSteeredMessage|forgetAnchors|anchorWorktree|AnchorDeps|unanchored)\b|agent\/anchors|turn-anchors|steer-anchors|anchor-worktree/,
        became: "checkpoint (the UI-positioning and regex senses of `anchor` are untouched)",
        since: "2026-09-21",
    },
    {
        id: "gate-guard",
        pattern: /\b(CommandGate|CommandGateOptions|createCommandGate|GateSubject|GateOutcome|outboundGate|outboundGateHooks|SigninGate|signinGate)\b|command-gate|outbound-gate/,
        became: "guard, or wall for the sign-in one (the release gate keeps the word)",
        since: "2026-09-21",
    },
    {
        id: "loop-agent",
        pattern: /\b(agentLoopNote|loopKeepsBuildStarted|loop-behind)\b|the background loop|the resident loop|the foreground loop|Loop (stopped|stalled) —/,
        became: "agent or process (the workflows Loop feature keeps the word)",
        since: "2026-09-21",
    },
    {
        id: "seat-rail",
        pattern: /\b(RailSeat|GhostSeat|seatPolicy|SeatPolicy|seatedTiles|railSeats|railSeated|stableSeats|seatedOnlyByVisit|unseated)\b/,
        became: "tile (the account-seat sense of `seat` is untouched)",
        since: "2026-09-21",
    },
    {
        id: "area-shell",
        pattern: /\b(AreaTile|AreaRow|areaReachable|areaIcon|areaBands|areaCommands|shellAreas|extensionAreas|lastAreaPath|FloatingArea|ChatArea)\b|Every area is on the rail|Rail Area/,
        became: "section",
        since: "2026-09-21",
    },
];

/** Every retired spelling this text still carries, as `{id, became, line}` findings. */
export const retiredIn = (text) => {
    const findings = [];
    const lines = text.split("\n");
    for (const entry of RETIRED) {
        const probe = new RegExp(entry.pattern.source, "g");
        for (const [index, line] of lines.entries()) {
            probe.lastIndex = 0;
            if (probe.test(line)) {
                findings.push({ id: entry.id, became: entry.became, line: index + 1, text: line.trim().slice(0, 120) });
            }
        }
    }
    return findings;
};
