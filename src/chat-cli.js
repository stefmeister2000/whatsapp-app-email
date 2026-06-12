// Local test harness — chat with the agent in your terminal, no WhatsApp setup needed.
// Usage: npm run chat   (requires ANTHROPIC_API_KEY)
import "dotenv/config";
import readline from "node:readline/promises";
import { generateReply } from "./agent.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Orvion agent test chat — type a message, Ctrl+C to quit.\n");

const userId = "cli-test-user";
while (true) {
  const text = await rl.question("you > ");
  if (!text.trim()) continue;
  const reply = await generateReply(userId, text);
  console.log(`\norvi > ${reply}\n`);
}
