# Put the agent where my team already talks

As someone who wants the agent to read and answer in the places work actually happens, I want to connect chat, mail and the accounts I post from, so that it is a colleague rather than a tab.

Two different things live in this section and they connect in two different ways. A chat or mail connector takes a credential and then relies on a gateway process that has to keep running: so the card shows me that process, whether it is running, and lets me restart it and read its log. "My bot went quiet" sends people to the connector, and the answer is on the connector.

The accounts I post from are not a token at all. They are a real browser session I sign into myself, in a window the product opens, because that is the only honest way to hold a session for a service that never issued me an API key. A session that has expired says so and offers me the way to log in again, in place, rather than reading as a broken connection.

## Acceptance criteria

- [ ] The Communication section lists the chat, mail and posting-account cards, each saying what the agent will be able to do
- [ ] A card requiring a credential links to where it is created and names the permissions or intents it needs
- [ ] Connecting a relay-based connector shows the background process that serves it, whether it is running, and actions to start, restart and read its log
- [ ] The process shown belongs to the connection being looked at, rather than every process in the sandbox
- [ ] A posting-account card offers a sign-in that opens a real login window instead of asking for a token
- [ ] A posting account whose session is not yet established says so and offers the log-in action in place
- [ ] An already-connected posting account offers a way to sign in again, for when the session expires
- [ ] Removing any of these connections asks for confirmation and reports what will be torn down
- [ ] With a connection active, the agent can read a recent message from that service in a conversation
