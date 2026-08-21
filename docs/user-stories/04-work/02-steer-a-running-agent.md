# Steer an agent while it is still working

As someone watching an agent take a wrong turn, I want to correct it mid-flight instead of waiting for it to finish being wrong, so that a misunderstanding costs one sentence rather than one turn.

The composer stays live while a turn streams. I type, I send, and the message reaches the running turn: or waits visibly until the turn can take it, so I always know whether I have been heard. It lands in the transcript as an ordinary message of mine, in order, next to what the agent was doing when I sent it. If the correction is bigger than a steer, Stop ends the turn and leaves everything written so far in place.

## Acceptance criteria

- [ ] The composer accepts typing and sending while a turn is streaming: it is not disabled mid-turn
- [ ] A message sent mid-turn is either taken by the running turn or shown as queued; it is never silently dropped
- [ ] A queued message is visible until it is taken, and the transcript shows it in the order I sent it
- [ ] Stop ends the running turn, and the transcript shows the turn as ended rather than still streaming
- [ ] After a stop, what the agent had already written is still there: its changed files remain listed on its review panel
- [ ] The transcript keeps its position when new output arrives while I am reading further up
