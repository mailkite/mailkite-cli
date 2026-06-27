# @mailkite/cli

The MailKite command-line client — a wrangler/vercel-style terminal tool for
[MailKite](https://mailkite.dev). Sign in, add domains, set DNS + webhooks, send
mail, and tail inbound messages, all from your shell.

> **Read-only mirror.** This repo is a generated, release-time mirror of the MailKite
> monorepo (the private source of truth); the source isn't developed here. Install
> `@mailkite/cli` from npm rather than cloning, and see the docs at
> <https://mailkite.dev/docs/cli>.

It's a **thin layer over the [MailKite Node SDK](https://github.com/mailkite/mailkite-node)**: every network call
goes through the `MailKite` client, so auth, base URL, and error handling live in
one place. The CLI adds token storage, interactive flows, and a one-shot setup
wizard on top.

```bash
npx @mailkite/cli --help        # no install needed
npm i -g @mailkite/cli          # or install the `mailkite` binary globally
```

## Quick start

```bash
mailkite signup --email you@example.com --password ••••••   # or: login
mailkite domains check myapp.ai                          # available? + price
mailkite domains register myapp.ai --first-name … --email … --country US  # buy + auto-DNS
mailkite domains add mail.myapp.ai                       # or add a domain you already own
# …add those records at your DNS provider…
mailkite domains verify <domainId>                          # MX/SPF/DKIM/DMARC
mailkite webhook set <domainId> https://myapp.ai/hooks/mailkite
mailkite send --from hello@mail.myapp.ai --to you@example.com \
  --subject "It works" --html "<p>Hi from MailKite</p>"
mailkite messages tail                                       # watch inbound arrive
```

Or do the whole flow in one command:

```bash
mailkite init --email you@example.com --password •••• \
  --domain mail.myapp.ai --provider cloudflare \
  --webhook https://myapp.ai/hooks/mailkite --to you@example.com --verify
```

## Built for scripts and agents

- **Fully non-interactive.** Every command works from flags + env; prompts only
  appear as a fallback on an interactive TTY. Missing a required flag in a
  non-TTY context fails loudly instead of hanging.
- **`--json` everywhere** for machine-readable output.
- **Snappy.** Commands exit immediately when done.

```bash
ID=$(mailkite domains add mail.app.com --json | jq -r .domain.id)
mailkite domains verify "$ID" --json | jq -e '.status=="verified"'
```

## Commands

| Group | Commands |
| --- | --- |
| Auth | `login`, `signup`, `logout`, `whoami` |
| Send | `send`, `agent`, `route` |
| Domains | `domains list\|add\|get\|verify\|rm`, `dns <id> [--provider]` |
| Webhooks | `webhook set\|rm\|test\|show`, `secret get\|rotate`, `verify-webhook` |
| Receiving | `messages list\|get\|tail`, `routes list\|create`, `deliveries retry` |
| Workflow | `init` (setup wizard), `mcp` (run the MCP server) |

Run `mailkite <command> --help` or just `mailkite` for the full reference.

## Auth & config

The CLI uses **one bearer token** for everything (sending and management) — the
account token from `login`/`signup`. Resolution order:

1. `--token <t>` flag
2. `MAILKITE_API_KEY` / `MAILKITE_TOKEN` env
3. `~/.mailkite/config.json` (written by `login`/`signup`, mode `600`)

Base URL: `--base-url` › `MAILKITE_BASE_URL` › config › `https://api.mailkite.dev`.

## Receiving without a public URL

`messages tail` polls the stored-messages API and prints new arrivals — so you can
confirm an inbound round-trip (send → receive) with no tunnel:

```bash
mailkite messages tail --once --subject "test" --timeout 120 --json
```

To verify webhook signatures locally (no network), use `verify-webhook` or the
SDK's `verifyWebhook` helper.

## Develop

```bash
npm install
npm test        # drives the commands against a mock API + checks local signature verify
```

## License

MIT
