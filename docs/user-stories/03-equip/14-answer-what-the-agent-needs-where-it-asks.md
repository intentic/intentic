# Answer what the agent needs, where it asks

As someone who hands an agent a task and goes back to my own work, I want everything it cannot do without me (a connection, an API key, a folder its persona leaves out, a tool missing from the image) asked once, early, on a card I can finish right there, so that setting things up is one press or one paste instead of a trip through settings pages, and the work carries on the moment I answer, whenever that is.

Today's usual failure is not a refusal, it is a stall: the agent says "please connect GitHub" in prose, I do it twenty minutes later on another page, and nothing happens until I come back and type "done, go on". So an ask is a need the sandbox keeps. It stays answerable after the turn that raised it has ended, and after a restart, and my answer continues the conversation by itself.

The card does the setup, not a link to it. A server, a CLI account or an endpoint opens its own form inside the card with everything the agent could know already filled in (the host, the user, the region), so I add only the credential. For SSH the sandbox makes the key pair and shows me the one line to run on the server. A secret nobody has stored gets one masked field, and its value goes straight to the store, never into the transcript. A folder or a shelf of tools the persona withholds is allowed for this conversation or on the persona, in one press. A setting on something already connected (a device's mouse-and-keyboard switch, the Docker engine's GPU access) shows the change and what it costs before I apply it. Proposed image steps show exactly what will run, and approving them approves only those.

I should not have to answer at all where nobody needs to decide. A secret the task can invent (a session key, a signing secret) the agent makes itself, and I only ever see its name. And I should be able to take back what I allowed: every standing yes is listed with who gave it, one press from gone.

## Acceptance criteria

- [ ] The agent asks with one command per kind (`capabilities request`, `secrets ask`, `grants request`, `environment propose`), and each answers in under the shell's timeout: met (use it now), refused or declined (carry on without it), or still waiting (carry on, the answer arrives by itself)
- [ ] An ask is kept after its turn ends and across a restart; answering it later continues the conversation without anyone typing "go on", unless I turned that off
- [ ] Asking for something the turn can already use answers "use it"; something connected but withheld by the persona, meant for another host, or whose credential is refused is answered as exactly that, never as "already connected"
- [ ] The card for a server, a CLI account, an endpoint or the sandbox fleet holds the connection's own form, pre-filled with what the agent passed, with the credential left for me; an SSH card generates the key and shows only the public half and the line that authorizes it
- [ ] A secret's card has one masked field, needs no DevOps set up first, and its value never appears in the transcript, a log or the agent's context
- [ ] A persona grant, a folder, a shelf, a device switch and a Docker engine option are each allowed on the card with one press, saying before the press whether it needs a rebuild or a restart
- [ ] Proposed image steps are shown on the card and approved one tool at a time; steps that would re-download everything on every image update are refused before they reach me
- [ ] A site the agent asks for in my own browser shows as a card in the chat too, and the conversation continues as soon as I allow it in the browser
- [ ] Everything waiting on me is listed under Needs you, with a badge on the rail and a notification when I am away; a conversation that came from Slack, Telegram or Discord hears the ask in its channel, with a warning not to paste a secret there
- [ ] A plan the agent presents lists what it still needs from me, so I answer everything in one sitting
- [ ] A secret the task can make for itself is generated and stored by the sandbox with nobody asked, and never shown
- [ ] Every standing grant and credential release is listed with who allowed it, and taking one back applies from the conversation's next turn
