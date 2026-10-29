#!/usr/bin/env node
// Test harness only. A stand-in for POST /v1/systemone that returns the same
// response shape as Jev, with deterministic fake answers and realistic latency,
// so the UI and engine can be exercised without spending API credit.
// Its answers mean nothing. Point the app at it with
//   JEV_BASE_URL=http://127.0.0.1:8787/v1/systemone
import http from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.MOCK_JEV_PORT || 8787);
const FAIL_RATE = Number(process.env.MOCK_JEV_FAIL_RATE || 0);

function unit(seed) {
  const h = createHash("sha256").update(seed).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

// Crude signal so answers are not pure noise: overlap between question words and state words.
function overlap(question, state) {
  const words = (s) => new Set(s.toLowerCase().match(/[a-z]{5,}/g) ?? []);
  const q = words(question);
  const s = words(state);
  let hit = 0;
  for (const w of q) if (s.has(w)) hit++;
  return q.size ? hit / q.size : 0;
}

function answer(name, q, state) {
  const r = unit(`${name}|${q.instructions}|${state.slice(0, 2000)}`);
  if (q.type === "noul") {
    const signal = overlap(q.instructions, state);
    const p = Math.min(0.995, Math.max(0.005, 0.15 + signal * 1.6 + (r - 0.5) * 0.7));
    const skewed = p > 0.5 ? 1 - (1 - p) ** 1.6 : p ** 1.6;
    return { type: "noul", noul: Number(skewed.toFixed(4)), confidence: Number(Math.abs(skewed - 0.5) * 2).toFixed(4) * 1 };
  }
  if (q.type === "choice") {
    const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
    const idx = Math.floor(r * keys.length) % Math.max(1, keys.length);
    const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === idx ? 0.6 : 0.4 / Math.max(1, keys.length - 1)]));
    return { type: "choice", choice: keys[idx], confidence: 0.6, probabilities };
  }
  const levels = Array.isArray(q.criteria) ? q.criteria.length : 3;
  return { type: "score", score: Number((r * (levels - 1)).toFixed(3)), confidence: 0.5 };
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/v1/systemone")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad json" }));
      return;
    }
    const state = typeof parsed.state === "string" ? parsed.state : JSON.stringify(parsed.state);
    const delay = 70 + Math.floor(unit(state.slice(0, 200)) * 330);
    setTimeout(() => {
      if (FAIL_RATE && Math.random() < FAIL_RATE) {
        res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "mock overload" }));
        return;
      }
      const answers = Object.fromEntries(
        Object.entries(parsed.questions ?? {}).map(([name, q]) => [name, answer(name, q, state)]),
      );
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          model: "jev-mock-0.0.0",
          answers,
          usage: { input_tokens: Math.ceil(body.length / 4), output_tokens: Object.keys(answers).length },
        }),
      );
    }, delay);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock Jev listening on http://127.0.0.1:${PORT}/v1/systemone (test harness, fake answers)`);
});
