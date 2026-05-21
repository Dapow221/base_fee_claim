# Dynamic Base Fee Claim Alert Bot

TypeScript bot that watches Base for fee-claim releases and sends alerts to Telegram and/or Discord.

The first version was token/wallet-specific. This version is dynamic:

- It scans Base for `Release(bytes32 poolId, address beneficiary, uint256 fees0, uint256 fees1)` events.
- It reads each matching transaction receipt.
- It discovers the beneficiary/dev wallet from the event.
- It discovers the claimed token contracts from matching ERC-20 `Transfer` logs in the same transaction.
- It parses matching `Collect(bytes32 poolId, uint256 fees0, uint256 fees1)` events for the total collected from the pool.
- It fetches token symbols/decimals with `eth_call`.
- It can enrich market cap and liquidity from DexScreener.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill either Telegram, Discord, or both:
   - Telegram: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
   - Discord: `DISCORD_WEBHOOK_URL`
3. Run:

```bash
npm start
```

No package install is needed on Node `23+`; the project uses Node's built-in TypeScript stripping.

## Telegram Test

1. In Telegram, open `@BotFather`.
2. Send `/newbot`, create your bot, and copy the bot token.
3. Put the token in `.env` as `TELEGRAM_BOT_TOKEN`.
4. Send any message to your new bot.
5. Get your chat id by opening this URL in a browser:

```text
https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
```

6. Put the chat id in `.env` as `TELEGRAM_CHAT_ID`.
7. Send a sample alert:

```bash
npm run telegram:test
```

## How Detection Works

The bot polls Base RPC for fee `Release` events. Your sample transaction includes this event, with the beneficiary/dev wallet encoded in topic 2. The bot then checks the same transaction receipt for ERC-20 transfers from the fee contract to that beneficiary.

Each alert includes:

- Token name, symbol, contract, market cap, and liquidity
- Released token and ETH amounts
- Beneficiary/dev wallet
- Total collected token and ETH amounts
- Transaction hash
- BaseScan link

This is much more scalable than trying to read every token transfer on Base.

Alert format:

```text
🎉 NEW BANKR FEE CLAIMED!

Token Information:
• Name: Token Name
• Symbol: TOKEN
• Contract: 0x...
• Market Cap: $31.71K
• Liquidity: $31.71K

Released to Beneficiary:
• Token Amount: 8,017,743.21 TOKEN
• ETH Amount: 0.001354 ETH
• Beneficiary: 0x91a2...d522
• Full Address: 0x91a20622c55e55239dc62b85781e5f627821d522

Total Collected from Pool:
• Token Amount: 14,066,216.16 TOKEN
• ETH Amount: 0.002376 ETH

https://basescan.org/tx/0x...
```

## Notes

- Public RPC is okay for testing. For always-on monitoring, use an Alchemy, QuickNode, Ankr, or other private Base RPC URL.
- The bot stores the last scanned block in `.bot-state.json`.
- Leave `FEE_DISTRIBUTOR_ADDRESSES` empty to watch the release event from all contracts.
- Add one or more comma-separated distributor contracts if you want fewer false positives.

## Historical Test

Your sample transaction is in block `46181876`. To test detection without sending alerts:

```bash
SCAN_ONCE_FROM_BLOCK=46181876 \
SCAN_ONCE_TO_BLOCK=46181876 \
STATE_FILE=.test-state.json \
npm start
```
