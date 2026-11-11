# Connections

Connections give a Dot tools from remote [MCP](https://modelcontextprotocol.io) servers: email, calendars, issue trackers, notes, or your own services. Each connection belongs to one Dot.

## Add a connection

1. Open a Dot's settings (**Edit specialist**).
2. Under **Connections**, enter a name, the server's Streamable HTTP endpoint (for example `https://example.com/mcp`), and an optional bearer token.
3. Select **Connect**. OpenDots lists the server's tools and saves them.

Use **Refresh** after the server adds or changes tools. Your choices for existing tools are kept.

## Approvals

Every tool starts enabled. A tool the server marks as read-only (`readOnlyHint`) runs on its own. Every other tool starts with **Ask first** on.

When a Dot calls an **Ask first** tool, the tool does not run. The server stores the exact connection, tool and arguments, and the Dot shows an approval card in chat with a summary and those stored arguments. The action runs only when you select **Approve & run**, through an owner-only server route. That route runs the stored request, never arguments sent with the approval, and only if the conversation's Dot still has that exact tool enabled. Requests expire after an hour. Each approval runs at most once. Reopening the conversation shows the saved result, or keeps checking while the action is still running. A saved result is only ever shown for the approval that produced it.

The read-only hint comes from the server, so it is only a hint. Turn on **Ask first** for any tool you do not fully trust, and turn off tools a Dot does not need.

Approval cards appear only in the web app. Through Slack or in scheduled runs, an **Ask first** tool tells the Dot to ask you to continue in the web app.

Changing a Dot's connections or tool settings stops that Dot's active turn.

## Watching a connection from the Inbox

A read-only list tool, such as "tasks assigned to me" on your ticket system's MCP server, can feed the **Inbox**. Open **Inbox**, choose **Add source**, then **Connection tool**, and pick the Dot, the tool and its arguments. OpenDots calls the tool on a timer (every 5 minutes by default) and adds any record it has not seen before. Put `"{{since}}"` in an argument to pass the time of the last check. Only tools that run without **Ask first** can be used, because nobody is there to approve a timed call. Every call appears in **Insights > Audit**.

Services that can send webhooks can post to a **Webhook** source instead. Its address and secret are shown once when you create it, and you can make a new secret at any time. Webhook deliveries do not use the owner token, so the server must be reachable from the sending service.

## Security notes

- Tokens are stored in the server's SQLite database and are never sent to the browser. Protect `DATABASE_PATH` the way you protect `.env`.
- Tool results are passed to the model as untrusted data.
- Endpoints must use `http` or `https` and cannot contain credentials in the URL. Local addresses are allowed, so you can run MCP servers on the same machine. Only add servers you trust.
- OAuth-only servers are not supported yet. Use a server that accepts a bearer token, or put a token-authenticated proxy in front of it.
