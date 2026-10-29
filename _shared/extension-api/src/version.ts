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
export const extensionApiVersion = "2.39.0";
