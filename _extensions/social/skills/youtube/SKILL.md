---
name: youtube
description: Watch/read, comment, reply, like, and subscribe (join channels) on YouTube as the logged-in user, through a real browser. Use whenever the user asks to do something on YouTube.
---

# YouTube (connected browser)

Home: https://www.youtube.com  ·  a video: https://www.youtube.com/watch?v=<id>  ·  a channel:
https://www.youtube.com/@<handle>  ·  your subscriptions: https://www.youtube.com/feed/subscriptions

- Read comments / video info: open the video, `browser_snapshot` (scroll to load comments with `browser_wait_for`).
- Comment: open the video, click "Add a comment", `browser_type`, then Comment.
- Reply: expand the target comment, click Reply, type, submit.
- Like a video: click the like control under the player.
- Subscribe (join a channel): open the channel or video and click Subscribe; for paid memberships click Join.
- Note: creating **Community posts** isn't reliably reachable — do it only if the channel exposes the composer.
${tools}
