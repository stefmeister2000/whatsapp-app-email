// Fetches a web page and extracts readable text for the AI knowledge base.
import * as cheerio from "cheerio";

const MAX_CONTENT_LENGTH = 20000; // keep prompt size sane per page

export async function scanPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OrvionKnowledgeBot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  $("script, style, noscript, nav, footer, header, svg, iframe").remove();

  const title = $("title").first().text().trim() || url;
  const main = $("main").length ? $("main") : $("body");
  let text = main
    .text()
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.slice(0, MAX_CONTENT_LENGTH) + "\n…(truncated)";
  }

  return { title, content: text };
}
