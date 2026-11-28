# 3 · Chatting

Chatting with a Bot is how you give it work. The Bot says how it plans to do the job, then reads files, runs commands and looks at web pages, stops to ask you when needed, and finally hands over the result with a work receipt.

On this page:

- [Topics](#topics)
- [Execute and Plan only](#execute-and-plan-only)
- [Sending, attachments and stopping](#sending-attachments-and-stopping)
- [Reading a run](#reading-a-run)
- [Work receipts](#work-receipts)
- [Background commands](#background-commands)
- [The Bot's browser](#the-bots-browser)

## Topics

Each Bot's chats are split into **topics**. A topic has its own context and working folder.

- **New topic**: click **+ New topic** at the top right. A new topic opens on a greeting page with suggestions in the interface language; click one to put it in the message box.
- **Switch topics**: click the topic name under the Bot's name to open the topic list. You can search it and see Archived topics. Imported topics have a source label.

  ![Topic list](../images/en/topic-list.png)

- **Archive**: "…" at the top right › **Archive** hides the topic and keeps its chats and attachments.

  ![The "…" menu](../images/en/topic-more.png)

### Continuing an imported conversation

Open your avatar menu (bottom left) › **Import from another AI**. Choose a ChatGPT, Claude or Gemini export ZIP, or bring in chats from Claude Code, Codex, Cursor, OpenCode or Antigravity. For local tools, list and pick conversations or choose a supported local file. A Gemini My Activity export creates a separate topic for each imported turn. The import reads the source on your computer. If you choose to distill memories with a cloud model, conversation text is sent to that model.

After importing, **Open imported topic** opens a single topic directly. For several topics, **View imported topics** opens the latest one and shows that batch under **Imported** in the Bot's **Topics** tab.

- **Continue in place**: open the imported topic and use the message box as usual, on desktop or from a phone connected to your paired computer. The topic keeps its **Imported from …** label, the timestamps of the imported messages and the working folder chosen at import. Restore the topic first if it is archived.
- **Context sent to the Bot**: on your first reply to a Pi Bot chat Bot, it gets both sides' text as background. It also gets short notes about tool calls, results and attachment names when available. Pi Bot leaves out tool arguments and output bodies. A long message shows its beginning. Its full text is attached if it fits the attachment limit. Pi Bot labels the history as untrusted background and summarizes it if it is too long. Old tool calls and approvals do not carry over.
- **Model used**: a chat Bot uses its configured model. On desktop, choose **Topic model** at the top of the chat to switch models for just this topic. If you imported into an external agent Bot, that agent uses its own model and does not get the imported history automatically.
- **Imported messages** stay read-only. You cannot edit or delete them individually. Importing the conversation leaves its source transcript untouched. Your new messages work like any normal chat.
- **Undoing an import**: open **Import from another AI** › **Past imports** › **Undo**. This removes imported messages and their attachments. Topics with new messages keep those messages and their working folder. Topics without new messages are removed. Wait for any active runs in the batch to finish first.

## Execute and Plan only

Above the message box are two modes:

- **Execute**: the Bot may change files and run commands, within your permissions.
- **Plan only**: the Bot only reads and analyses; it won't change files or run commands. Good for getting a plan first; when you like it, click **Switch to execution**.

Execute / Plan only shares a row with the working folder: in a new topic you can change the folder at "Working in …" until you send the first message (see [4 · Working folders and changes](04-folders-and-changes.md)).

![Execute and Plan only](../images/en/composer-modes.png)

## Sending, attachments and stopping

- **Send**: Enter sends, Shift+Enter adds a line. ↑ / ↓ on the first or last line brings back earlier input.
- **Attachments**: click "+" at the left of the message box › **Add attachment**.
- **While the Bot is busy**: click the arrow next to the send button and choose **Add to the current task** or **Handle after the current task**.

  ![Send options](../images/en/send-options.png)

- **Stop**: while a Bot runs, the send button becomes a stop button; in group chats each member also has "Stop this run by …". Text generated before stopping is kept.
- **Suggested reply**: after a run, a grey suggested reply appears in the message box. Tab accepts it, Esc dismisses it; you still send it yourself.

### Video generation and playback

Ask a Bot to generate a clip using a [configured video model](09-models-and-keys.md#video-generation-models). You can give it a prompt and optionally specify duration, aspect ratio, size or an image to use as the first frame. The approval card shows the provider, output settings and estimated price when available.

The job card shows progress and lets you cancel. Pi Bot resumes a job with a provider ID after a restart. The default timeout is 15 minutes, and generated files share the 20 MiB attachment limit. The finished MP4 is attached to the conversation and saved in the topic folder when write permissions and the folder still permit it.

On desktop, load the inline player from a video or audio attachment. The player starts muted and waits for you to press play. Supported extensions are MP4, WebM, MOV and M4V for video, and M4A, MP3, WAV and OGG for audio. On the phone, tap the file card and choose **Open with** to use a system player.

## Reading a run

![A finished run](../images/en/chat-result.png)

- **Plan**: multi-step tasks start with a plan that gets ticked off as work progresses.
- **Step rows**: for example "6 steps · Edit file, Run command, Use browser ×4"; expand to see each step.
- **Approval cards**: actions that need your consent show up as cards in the chat (see [5 · Approvals and permissions](05-approvals-and-permissions.md)).
- **Changed files**: "Changed 3 files this turn"; **View** opens the changes panel (see [4 · Working folders and changes](04-folders-and-changes.md)).
- **Output attachments**: documents, images, spreadsheets, slides, web pages, recordings and archives created during the run can be attached automatically below the reply. On desktop, SVGs that can be previewed appear as pictures. If the preview fails, you get a file card. On a phone, open the SVG from its file card.
- **More than 10 files**: a reply can attach up to 10 files. If automatic delivery has more files than that, a note below the reply tells you how many remain. Find them in the working folders, or use **Open folder** when available. Files already written can still be attached after a run fails or is stopped. See the Changes panel for edited source code.
- **Long replies in direct chats**: attachments from one continuous reply are collected at the end. When you reopen a topic, Pi Bot automatically loads earlier parts of the reply. For a very long reply, use **Load earlier messages** if early attachments are still missing.
- **Web results**: when a development task produces a web page, a local HTML file or a web service, the Bot opens it in its own browser to check it; visual results get a screenshot self-check, and obvious layout errors are fixed before hand-off.

## Work receipts

Every run ends with a **Work receipt** row showing commands, approvals, time and cost. Click **Details** to expand it:

![Work receipt](../images/en/work-receipt.png)

- **Outcome**: done, stopped or failed, and how long it took.
- **Not verified or missing**: delivery evidence (commands, screenshots, reviews); anything unverified is flagged.
- **What it read**: files read per folder, browser steps, memories used.
- **Outputs and changes**: files and lines changed.
- **Approvals**: how many allowed and denied.
- **Actions with side effects**: commands run, blocked steps.
- **Cost and effort**: model, requests, cost ("Unknown" when the provider gives no pricing) and active time.

The receipt is built from this computer's records (audit, changes, approvals, budget, plan). It contains no message text or file contents.

## Background commands

Bots can run commands in the background, such as a local preview server. The chat shows a **Running in background** card with the output line count and run time; you can **Open … in Bot browser**, **View output** or **Stop** it.

### Start, inspect, and stop a local preview

1. Verify the working folder at the top of the chat and switch to Execute. In a test project, ask: “Run a local preview in the background. Listen only on 127.0.0.1 and tell me the port.”
2. On the approval card, verify the command, directory, and port. Choose Allow this time if they match the task.
3. The green Running in background card appears. Use Open … in Bot browser to preview the detected port, or View output to inspect the logs.

![Running in background card with the preview port, output and stop controls](../images/en/background-command.png)

4. When finished, choose Stop and check that the card shows the stopped state. The stopped process no longer serves the page.

If the card shows a process without a port, check the output for a port conflict or missing runtime. Request a different port and review the new approval. The browser shortcut appears for detected loopback listeners started by the Bot.

Background commands run for up to 2 hours by default (Settings › General › Background commands › Total time limit), and also end when you stop them, delete the chat, archive the Bot or quit the app. They may only listen on this computer (127.0.0.1). Starting one always needs your approval.

## Choose a browser

Pi Bot prefers your browser by default. If you use Chrome or Firefox, install the Pi Bot Browser extension from its store. In Firefox, also allow website access from the extension button.

- [Chrome Web Store](https://chromewebstore.google.com/detail/pi-bot-browser/pnjdgninncjgoedhbaiollbhkhfmlngl)
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/pibot-browser/)

Once the extension connects, Bots can use your existing sign-ins in dedicated tabs. Site access and form submissions still follow Pi Bot's permissions and approvals. When the extension is disconnected, tasks continue in the Bot browser. The extension is not yet listed in Microsoft Edge Add-ons. To always use the isolated browser, choose **Use only Pi Bot's built-in Bot browser** in Settings › Browser.

### The Bot's browser

Click **Browser** at the top of the chat to open the Bot browser panel and watch the page the Bot is looking at.

![The local preview running in the Bot browser panel](../images/en/bot-browser.png)

- It's completely separate from your own browser, with none of your sign-ins.
- **Take over** lets you use the page yourself; **Full screen** enlarges it; **Diagnostics** and **Select element** help inspect the page.
- The sidebar view updates at up to 2 frames per second, 5 when enlarged or taken over, and none while hidden. Pages close after 10 minutes unused.
- By default the Bot browser can't open this computer's or private network addresses; a local preview the Bot started itself opens from **Open … in Bot browser** on the background command card.

#### View a page, take over, and give control back in the Bot browser

1. Send a public URL in chat and ask the Bot to open it. Review the domain if prompted. For a local preview, use the background command card.
2. Select Browser at the top of the chat. Check the address, tab and page in the side panel. Use Full screen for a larger view.
3. Choose Take over when you need to click or type yourself. Give control back when finished, then tell the Bot what to check next. Handle sensitive accounts and forms in your own browser.
4. Select an element or open Diagnostics to inspect the page. If a local preview stops responding, check whether the background service is still running.
