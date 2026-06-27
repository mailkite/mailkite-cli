// CLI test: drive the built commands against a local mock API and assert they
// hit the right endpoints / produce the right JSON. Also checks the local
// verify-webhook path (no network) end to end.
//
// NOTE: we use async `spawn` (not spawnSync) on purpose — the mock server runs
// in this same process, and spawnSync would block the event loop so the server
// could never answer the child's request (deadlock).
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.mjs");
const TOKEN = "test_token";
let last = null;

const routes = {
  "POST /v1/send": { id: "msg_1", status: "sent" },
  "GET /api/domains": [{ id: "dom_1", domain: "mail.acme.dev", status: "verified" }],
  "POST /api/domains": { domain: { id: "dom_1", domain: "mail.acme.dev", status: "pending" }, dns: [{ type: "MX", name: "mail.acme.dev", value: "mx.mailkite.dev", priority: 10 }] },
  "POST /api/domains/dom_1/verify": { status: "verified", checks: { mx: true, spf: true, dkim: true, dmarc: true }, checkedAt: 1 },
  "PUT /api/domains/dom_1/webhook": { domain: { id: "dom_1" }, webhookUrl: "https://h.dev/hook" },
  "POST /api/domains/dom_1/webhook/test": { ok: true, status: 200 },
  "GET /api/domains/register/check": { configured: true, domain: "acme.com", available: true, premium: false, price: { amount: 12.99, currency: "USD", period: 1, periodUnit: "y" } },
  "POST /api/domains/register": { domain: { id: "dom_2", domain: "acme.com", status: "verified" }, dns: [], registration: { status: "registered", reference: "ref_1" }, dnsProvisioned: true },
  "GET /api/messages": [{ id: "m1", from_addr: "a@x.dev", to_addr: "b@mail.acme.dev", subject: "Hi", received_at: 1 }],
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const pathname = req.url.split("?")[0];
    last = { method: req.method, path: pathname, auth: req.headers["authorization"], body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null };
    const payload = routes[`${req.method} ${pathname}`] ?? { error: "no route" };
    res.writeHead(payload.error ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : "  — " + (detail ?? "")}`);
  if (!cond) fails++;
}

// Run a CLI command asynchronously (keeps the event loop free for the mock).
function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args, "--json", "--base-url", base, "--token", TOKEN], {
      env: { ...process.env, ...env, MAILKITE_API_KEY: "", MAILKITE_TOKEN: "" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("close", (code) => {
      clearTimeout(timer);
      // Commands print one pretty-printed JSON object; `tail` prints one compact
      // object per line. Parse the whole blob first, else fall back to last line.
      const t = stdout.trim();
      let json = null;
      try { json = JSON.parse(t); } catch { try { json = JSON.parse(t.split("\n").pop()); } catch {} }
      resolve({ code, stdout, stderr, json });
    });
  });
}

// send
let r = await run(["send", "--from", "hi@mail.acme.dev", "--to", "ada@example.com", "--subject", "Yo", "--text", "hello"]);
check("send → POST /v1/send", last.method === "POST" && last.path === "/v1/send", last.path);
check("send → Bearer token", last.auth === `Bearer ${TOKEN}`, last.auth);
check("send → body shape", JSON.stringify(last.body) === JSON.stringify({ from: "hi@mail.acme.dev", to: "ada@example.com", subject: "Yo", text: "hello" }), JSON.stringify(last.body));
check("send → prints {id,status}", r.json?.id === "msg_1" && r.json?.status === "sent", r.stdout);

// domains add
r = await run(["domains", "add", "mail.acme.dev"]);
check("domains add → POST /api/domains", last.method === "POST" && last.path === "/api/domains", last.path);
check("domains add → body {domain}", JSON.stringify(last.body) === JSON.stringify({ domain: "mail.acme.dev" }), JSON.stringify(last.body));

// domains verify
r = await run(["domains", "verify", "dom_1"]);
check("domains verify → POST /api/domains/dom_1/verify", last.path === "/api/domains/dom_1/verify", last.path);
check("domains verify → json status", r.json?.status === "verified", r.stdout);

// domains check
r = await run(["domains", "check", "acme.com"]);
check("domains check → GET /api/domains/register/check", last.method === "GET" && last.path === "/api/domains/register/check", last.path);
check("domains check → json available", r.json?.available === true, r.stdout);

// domains register (--yes skips the confirm prompt; contact via flags for non-interactive)
r = await run(["domains", "register", "acme.com", "--yes", "--first-name", "Jane", "--last-name", "Doe", "--email", "jane@example.com", "--phone", "+1.4155551234", "--address", "123 Main St", "--city", "SF", "--zip", "94016", "--country", "US"]);
check("domains register → POST /api/domains/register", last.method === "POST" && last.path === "/api/domains/register", last.path);
check("domains register → body has domain+contact", last.body?.domain === "acme.com" && last.body?.contact?.firstName === "Jane" && last.body?.contact?.country === "US", JSON.stringify(last.body));
check("domains register → json result", r.json?.registration?.status === "registered" && r.json?.dnsProvisioned === true, r.stdout);

// webhook set
r = await run(["webhook", "set", "dom_1", "https://h.dev/hook"]);
check("webhook set → PUT", last.method === "PUT" && last.path === "/api/domains/dom_1/webhook", last.path);
check("webhook set → body {url}", JSON.stringify(last.body) === JSON.stringify({ url: "https://h.dev/hook" }), JSON.stringify(last.body));

// webhook test
r = await run(["webhook", "test", "dom_1"]);
check("webhook test → POST .../webhook/test", last.path === "/api/domains/dom_1/webhook/test", last.path);

// messages tail --once (emits the seeded-as-new message under --all, then exits)
r = await run(["messages", "tail", "--once", "--all", "--timeout", "5"]);
check("messages tail → polled /api/messages", last.path === "/api/messages", last.path);
check("messages tail → emitted a message", r.stdout.includes("m1"), r.stdout);

// verify-webhook (local, no network)
const body = '{"type":"email.received","id":"m1"}';
const ts = Date.now();
const sig = crypto.createHmac("sha256", "whsec_x").update(`${ts}.`).update(body).digest("hex");
const before = last;
r = await run(["verify-webhook", "--signature", `t=${ts},v1=${sig}`, "--secret", "whsec_x", "--payload", body, "--tolerance", "0"]);
check("verify-webhook → no network call", last === before, "made a request");
check("verify-webhook → valid:true", r.json?.valid === true, r.stdout);
r = await run(["verify-webhook", "--signature", `t=${ts},v1=${sig}`, "--secret", "whsec_wrong", "--payload", body, "--tolerance", "0"]);
check("verify-webhook → wrong secret ⇒ valid:false", r.json?.valid === false, r.stdout);

server.close();
console.log("\n" + (fails === 0 ? "ALL CLI CHECKS PASS" : `${fails} FAILED`));
process.exitCode = fails === 0 ? 0 : 1;
