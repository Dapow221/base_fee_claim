import fs from "node:fs";
import path from "node:path";

loadDotEnv();

const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
const chatId = process.env.TELEGRAM_CHAT_ID ?? "";

if (!botToken || !chatId) {
  throw new Error("Fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first.");
}

const text = [
  "🎉 NEW BANKR FEE CLAIMED!",
  "",
  "Token Information:",
  "• Name: Test Token",
  "• Symbol: TEST",
  "• Contract: 0x0000000000000000000000000000000000000000",
  "• Market Cap: $31.71K",
  "• Liquidity: $31.71K",
  "",
  "Released to Beneficiary:",
  "• Token Amount: 8,017,743.21 TEST",
  "• ETH Amount: 0.001354 ETH",
  "• Beneficiary: 0x91a2...d522",
  "• Full Address: 0x91a20622c55e55239dc62b85781e5f627821d522",
  "",
  "Total Collected from Pool:",
  "• Token Amount: 14,066,216.16 TEST",
  "• ETH Amount: 0.002376 ETH",
  "",
  "https://basescan.org/tx/0xc238c6fe61753e5ce42a4c8120dec0667a28e477b7aa093d4c9b2414dea59bf7"
].join("\n");

const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  })
});

if (!response.ok) {
  throw new Error(`Telegram failed: ${response.status} ${await response.text()}`);
}

console.log("Telegram test alert sent.");

function loadDotEnv(): void {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
