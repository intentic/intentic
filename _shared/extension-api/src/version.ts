// Protocol version matched by engines.intentic at load and reported as IntenticApi.apiVersion.
// Bump with the published package: additive surface changes require a minor, breaking changes a major.
// Keep published names compatible within a major; surface.json and the surface checks record API and UI-kit changes.
// 2.35.0 lets a command declare its shortcut as a Mac spells it: `mac` beside `keybinding` in `contributes.commands`,
// approved at install as a power of its own (a second chord the extension claims). Without one a Mac uses `keybinding`,
// as before; with one, a Mac binds `mac` instead. Whichever is declared, a Mac's text field keeps the chords it answers
// itself (⌃A, ⌃K, ⌥←, ⌘⌫). Additive: a manifest without `mac` is unchanged. The recorded surface grows the manifest
// schema.
// 2.36.0 records settings choice labels and explanations alongside the Mac shortcut schema.
// 2.37.0 adds the kit's own day and time fields, `DatePicker` and `TimeField`, in place of the browser's date popup and
// hour spinner. Additive.
// 2.38.0 tells a run button whether the model it would spend has allowance: `api.models.allowance(selection, now)` answers
// when a spent allowance reopens, by the rule the composer's Send books by, and `pick({ schedules })` has the panel's verbs
// say when a run on such a model starts. The kit's `useAgentRunPick` reads it as `spent` and `booking`, and
// `<AgentRunButton>` draws the press as the time it starts. Additive. The recorded surface grows `modelsApi`.
// 2.39.0 lets a view start an agent the board shows from the press: `api.chat.launchAgent(card, start)` opens the agents
// board at once with a dashed card standing in for the agent while `start` runs, hands over to the agent's own card when
// `start` answers with its id, and says a refusal on the card. Additive. The recorded surface grows `chatApi`.
// 2.40.0 lets a view start an agent from a branch while the shared workspace stays on its main line:
// `api.chat.composeFrom({ repo, branch })` opens a new chat whose private copy is cut from that branch. Additive. The
// recorded surface grows `chatApi`.
// 2.41.0 gives a view the app's pages to link to: `api.links` holds a constructor for each (the editor's own table,
// @intentic/sandbox-contract/app-routes), and `api.navigate` and `api.href` take the link one makes, drawn in the frame
// and the sandbox the reader is in. A path is still taken, deprecated: read as an address from before the editor's
// frames, it opens where a link to its page would. Additive. The recorded surface grows `api`.
// 2.42.0 grows a capability card's fields and test: `signIn` (`google`, `microsoft`) fills a refresh token from a sign-in
// button, `refreshToken.deviceCode` declares the device-code sign-in a `microsoft` one runs, `connection` answers a field
// by picking an existing connection, `keyValue` draws one as name and value rows, `keyRequest` has the sandbox keep a
// private key and show its certificate request, `probe.oauth` takes the `client_credentials` grant too, and `probe.ok`
// names where a 200 answer says it worked. Additive. The recorded surface grows the manifest schema.
export const extensionApiVersion = "2.42.0";
