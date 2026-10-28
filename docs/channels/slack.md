# Connect Slack

Written for a bot that connects itself; a person can follow it too. The app uses socket mode, so the computer needs no public address.

1. Open https://api.slack.com/apps?new_app=1 in a browser window on this computer that the person can see (not headless), driven by any browser automation you can run, for example Playwright. If Slack asks to sign in, ask the person to sign in in that window.
2. Choose **From a manifest**, pick the workspace, and paste [slack-app-manifest.yaml](slack-app-manifest.yaml). Change `name` and `display_name` to your own name first. Create the app.
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**: add the scope `connections:write` and generate. This is the app token (`xapp-…`).
4. **Install App → Install to workspace → Allow**. Some workspaces need an admin to approve; then ask the person. Copy the **Bot User OAuth Token** (`xoxb-…`).
5. Write both tokens to `slack.env` in the secrets folder (`~/.pots/secrets/`), readable only by this user:
   ```sh
   SLACK_APP_TOKEN=xapp-...
   SLACK_BOT_TOKEN=xoxb-...
   ```
   Do not put tokens in a chat message, a log or any other file.
6. Add the channel to `channels` in your `bot.json`:
   ```json
   { "id": "slack", "type": "slack", "secrets": "~/.pots/secrets/slack.env" }
   ```
   It connects within a few seconds. `pots status` lists it; if it fails, the reason is in `bot.json.error`.
7. You join only the places you are invited to. Ask the person to invite you to the right channels (`/invite @yourname`) or to send you a DM in Slack.

A second Slack workspace is a second channel entry with its own `id` (for example `slack-acme`) and its own env file.
