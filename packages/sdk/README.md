# @dzbot/sdk

Build your own DayZ Discord bot or website on [dzbot](https://dzbot.de) instead of from scratch. dzbot already
reads your Nitrado server's logs and runs players, linked accounts and alt detection, wallets, the shop and
delivery, tickets, factions, bounties, the kill feed and more — this SDK gives your code all of it.

```bash
npm install @dzbot/sdk
```

```ts
import { Dzbot } from '@dzbot/sdk'

// A server API key from your server's admin area → Developers. Server side only.
const dzbot = new Dzbot({ server: 'your-server', apiKey: process.env.DZBOT_API_KEY })

const player = await dzbot.players.findByDiscordId('637704195486515222')
await dzbot.wallet.credit(player!.id, 500, 'Event win')

for await (const order of dzbot.search('order', { status: 'pending', created: '7d' })) {
  console.log(order.code, order.label)
}
```

## What's inside

- **Client** — API key (servers) or Sign in with dzbot (servers and browsers), retries for reads, typed errors
  (`DzbotError`, `RateLimitError`, `PermissionError`).
- **Sign in with dzbot** — `OAuthClient` with PKCE: players sign in on your server's dzbot page, link their game
  account there and come back to your app. You get who they are (`dzbot.me()`), their main account across alts,
  and act with their rights.
- **Search** — every dzbot list through one async iterator.
- **Webhooks** — `verifyWebhook`, `parseEvent`, `webhookHandler` (Fetch) and `expressWebhook`.
- **Live events** — `dzbot.events.subscribe(['log.player_kill'], handler)` in the browser or Node 22+.
- **Event types** — every event of the catalog, typed (`isEvent(event, 'order.created')`).
- **`@dzbot/sdk/api`** — every endpoint of the API as a generated, typed client: `new AdminApi(dzbot.configuration())`.

```ts
import express from 'express'
import { expressWebhook, isEvent } from '@dzbot/sdk'

const app = express()
app.post('/webhooks/dzbot', express.raw({ type: 'application/json' }), expressWebhook(process.env.DZBOT_WEBHOOK_SECRET!, (event) => {
  if (isEvent(event, 'log.player_kill')) console.log(`${event.payload.data.killer.username} → ${event.payload.data.victim.username}`)
}))
```

Documentation: **https://developers.dzbot.de/sdk/** · For coding agents: https://developers.dzbot.de/llms.txt ·
A ready bot to start from: https://github.com/siemendev/dzbot-starter

The API is part of dzbot Pro. Node 20+ or any modern browser (WebCrypto). The code is MIT licensed; using the
API is subject to the [dzbot terms of service](https://dzbot.de/terms-of-service). DayZ is a trademark of Bohemia
Interactive a.s.; dzbot is not affiliated with Bohemia Interactive.
