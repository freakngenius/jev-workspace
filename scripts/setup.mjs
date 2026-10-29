// `npm run setup`: writes .env.local for a fresh clone. Asks for a Jev key and an optional
// Anthropic key, keeps every other line already in the file, and can check the Jev key with one
// tiny call. Keys are never printed back, only their last four characters.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// JEV_SETUP_ROOT lets the tests point the script at a scratch folder.
const root = process.env.JEV_SETUP_ROOT || fileURLToPath(new URL("..", import.meta.url));
const envFile = path.join(root, ".env.local");
const exampleFile = path.join(root, ".env.example");
const ENDPOINTS = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
};

const tty = Boolean(process.stdin.isTTY);
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
let muted = false;
// readline echoes every keystroke; hold the echo back while a key is being pasted.
rl._writeToOutput = (s) => {
  if (!muted) process.stdout.write(s);
};
rl.on("SIGINT", () => {
  process.stdout.write("\nSetup cancelled. Nothing was saved.\n");
  process.exit(130);
});
// The iterator buffers lines, so answers piped in all at once are not lost between questions.
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt, hidden = false) {
  rl.setPrompt(prompt);
  rl.prompt();
  muted = hidden && tty;
  const { value, done } = await lines.next();
  if (muted || !tty) process.stdout.write("\n");
  muted = false;
  return done ? "" : String(value).trim();
}

const tail = (key) => `…${key.slice(-4)}`;
const looksLikeKey = (key) => key.length >= 8 && !/\s/.test(key);
const declined = (answer) => /^n/i.test(answer);

function readValue(text, name) {
  const m = text.match(new RegExp(`^${name}=(.*)$`, "m"));
  return m ? m[1].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2") : "";
}

// Replaces the live line, else fills in the commented template line, else appends, so the file
// never holds two values for one key.
function setValue(text, name, value) {
  const line = `${name}=${value}`;
  for (const re of [new RegExp(`^${name}=.*$`, "m"), new RegExp(`^#[ \\t]*${name}=.*$`, "m")]) {
    if (re.test(text)) return text.replace(re, () => line);
  }
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${line}\n`;
}

function unsetValue(text, name) {
  return text.replace(new RegExp(`^${name}=.*$`, "m"), () => `# ${name}=`);
}

async function checkJev(key, text) {
  const url =
    process.env.JEV_BASE_URL?.trim() ||
    readValue(text, "JEV_BASE_URL") ||
    (key.startsWith("sk-or-") ? ENDPOINTS.openrouter : ENDPOINTS.typesafe);
  const host = new URL(url).host;
  const model = process.env.JEV_MODEL?.trim() || readValue(text, "JEV_MODEL") || "jev-latest";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        state: { text: "Setup check from Jev Workspace." },
        model,
        questions: { check: { type: "noul", instructions: "Is this text a setup check?" } },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true, message: `The key works: ${host} answered.` };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `${host} rejected the key (HTTP ${res.status}). Check it, then run npm run setup again.` };
    }
    if (res.status === 429) {
      return { ok: true, message: `${host} is busy (HTTP 429), so the key could not be checked. Try a run in a minute.` };
    }
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
    return { ok: false, message: `The check failed with HTTP ${res.status} from ${host}: ${detail}` };
  } catch (err) {
    return { ok: false, message: `Could not reach ${host}: ${err instanceof Error ? err.message : err}` };
  }
}

function hasClaudeCli() {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function plannerNote(anthropicKey) {
  if (anthropicKey) return "Claude drafts plans and reviews uncertain items through the Anthropic API.";
  if (hasClaudeCli()) return "Found the claude CLI: Claude drafts plans and reviews uncertain items on your Claude login.";
  return "No Anthropic key or claude CLI, so plans start from a template you can edit. Add a key any time with npm run setup.";
}

function fail(message) {
  console.log(message);
  rl.close();
  process.exitCode = 1;
}

async function main() {
  console.log("Jev Workspace setup");
  console.log("Keys are saved in .env.local on this computer and sent only to the service each one belongs to.\n");

  const existed = existsSync(envFile);
  const before = existed ? readFileSync(envFile, "utf8") : existsSync(exampleFile) ? readFileSync(exampleFile, "utf8") : "";
  let text = before;

  const jevNow = readValue(text, "TYPESAFE_API_KEY") || readValue(text, "OPENROUTER_API_KEY");
  let jevKey = jevNow;
  if (!jevNow || declined(await ask(`A Jev key is already saved (${tail(jevNow)}). Keep it? [Y/n] `))) {
    const entered = await ask("Jev API key from TypeSafe, or an OpenRouter key that starts with sk-or- (hidden as you paste): ", true);
    if (entered && !looksLikeKey(entered)) return fail("That does not look like a key: keys are one word of at least 8 characters. Nothing was saved.");
    if (entered) {
      jevKey = entered;
      text = setValue(text, "TYPESAFE_API_KEY", entered);
    } else if (jevNow) {
      console.log("No new key entered, so the saved one stays.");
    }
  }

  const anthropicNow = readValue(text, "ANTHROPIC_API_KEY");
  let anthropicKey = anthropicNow;
  if (!anthropicNow || declined(await ask(`An Anthropic key is already saved (${tail(anthropicNow)}). Keep it? [Y/n] `))) {
    const entered = await ask(
      "Anthropic API key, optional, so Claude drafts plans and reviews uncertain items. Press Enter to skip (hidden as you paste): ",
      true,
    );
    if (entered && !looksLikeKey(entered)) return fail("That does not look like a key: keys are one word of at least 8 characters. Nothing was saved.");
    if (entered) {
      anthropicKey = entered;
      text = setValue(text, "ANTHROPIC_API_KEY", entered);
    } else if (anthropicNow) {
      anthropicKey = "";
      text = unsetValue(text, "ANTHROPIC_API_KEY");
      console.log("Removed the saved Anthropic key.");
    }
  }

  if (text !== before || !existed) {
    writeFileSync(envFile, text, { mode: 0o600 });
    // writeFileSync only applies the mode to a new file.
    chmodSync(envFile, 0o600);
    console.log(
      process.platform === "win32"
        ? "Saved .env.local. Git ignores it."
        : "Saved .env.local. Git ignores it, and only your user account can read it.",
    );
  } else {
    console.log("Kept .env.local as it was.");
  }

  let ok = true;
  if (!jevKey) {
    console.log("\nNo Jev key yet. The app opens, but runs will not start until you add one with npm run setup.");
  } else if (!declined(await ask("Check the Jev key now with one tiny call (a small fraction of a cent)? [Y/n] "))) {
    const result = await checkJev(jevKey, text);
    ok = result.ok;
    console.log(result.message);
  }

  console.log(`\n${plannerNote(anthropicKey)}`);
  const install = existsSync(path.join(root, "node_modules", "next")) ? "" : "npm install, then ";
  console.log(`\nNext: ${install}npm run app, then open http://127.0.0.1:3131`);
  if (process.platform === "darwin") console.log("On a Mac, npm run desktop also builds a Jev Workspace app with its own icon.");
  rl.close();
  process.exitCode = ok ? 0 : 1;
}

await main();
