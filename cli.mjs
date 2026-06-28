#!/usr/bin/env node
// MailKite CLI — a wrangler-style terminal client for MailKite.
//
// It is a thin layer over the MailKite Node SDK (sdks/node): every network call
// goes through the `MailKite` class, so auth, base URL, and error handling stay
// in one place. Auth/token storage and the interactive flows are the CLI's own.
//
// Designed to be fully scriptable for AI agents: every command works from flags
// + env with no prompts (prompts only appear as a fallback on an interactive TTY),
// and every data command supports `--json` for machine-readable output.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { MailKite, MailKiteError } from "mailkite";

const VERSION = "0.1.0";
const CONFIG_DIR = path.join(homedir(), ".mailkite");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_BASE_URL = "https://api.mailkite.dev";

// ---- tiny arg parser --------------------------------------------------------
// Supports: positionals, --flag, --key value, --key=value, -h/-v shortcuts.
function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { flags.help = true; continue; }
    if (a === "-v") { flags.version = true; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

// ---- output helpers ---------------------------------------------------------
const isTTY = process.stdout.isTTY;
const c = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const cyan = (s) => c("36", s);

function out(data, flags, human) {
  if (flags.json) { console.log(JSON.stringify(data, null, 2)); return; }
  if (typeof human === "function") human(data);
  else console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function die(msg, code = 1) {
  console.error(red("✗ ") + msg);
  process.exit(code);
}

// ---- config -----------------------------------------------------------------
function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
function saveConfig(cfg) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

function resolveToken(flags) {
  return (
    flags.token ||
    process.env.MAILKITE_API_KEY ||
    process.env.MAILKITE_TOKEN ||
    loadConfig().token ||
    ""
  );
}
function resolveBaseUrl(flags) {
  return flags["base-url"] || process.env.MAILKITE_BASE_URL || loadConfig().baseUrl || DEFAULT_BASE_URL;
}

// A client for endpoints that need auth. Errors clearly if no token is present.
function client(flags, { requireToken = true } = {}) {
  const token = resolveToken(flags);
  if (requireToken && !token) {
    die("Not signed in. Run `mailkite login` (or set MAILKITE_API_KEY / pass --token).");
  }
  return new MailKite(token, resolveBaseUrl(flags));
}

// ---- interactive prompt (TTY fallback only) ---------------------------------
function prompt(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      const onData = (ch) => {
        const s = ch.toString();
        if (s === "\n" || s === "\r" || s === "") return;
        process.stdout.write("*");
      };
      process.stdin.on("data", onData);
      rl.question(question, (ans) => { process.stdin.off("data", onData); process.stdout.write("\n"); rl.close(); resolve(ans.trim()); });
    } else {
      rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); });
    }
  });
}

async function need(value, label, promptText, opts) {
  if (value) return value;
  const v = await prompt(promptText, opts);
  if (!v) die(`${label} is required (pass it as a flag for non-interactive use).`);
  return v;
}

const toList = (v) => (Array.isArray(v) ? v : String(v).split(",").map((s) => s.trim()).filter(Boolean));

// Decode a JWT payload (no verification — just to show who you are locally).
function decodeJwt(token) {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return null; }
}

// Concise per-provider DNS hint (full playbooks live in the AI skill).
const PROVIDER_HINTS = {
  cloudflare: "Cloudflare: Dashboard → DNS → Records, or `npx wrangler` / API POST /zones/:zone/dns_records. Set proxy=DNS-only (grey cloud) for MX.",
  godaddy: "GoDaddy: Domain Portfolio → DNS → Add, or API PATCH /v1/domains/:domain/records.",
  namecheap: "Namecheap: Domain List → Manage → Advanced DNS → Add New Record.",
  route53: "Route 53: Hosted zone → Create record, or `aws route53 change-resource-record-sets`.",
};

// =============================================================================
// Commands
// =============================================================================
const commands = {};

commands.login = async ({ flags }) => {
  const email = await need(flags.email, "email", "Email: ");
  const password = await need(flags.password, "password", "Password: ", { hidden: true });
  const mk = new MailKite("", resolveBaseUrl(flags));
  let res;
  try { res = await mk.request("POST", "/api/auth/login", { email, password }); }
  catch (e) { return die(e instanceof MailKiteError ? `Login failed (${e.status}): ${e.message}` : e.message); }
  const cfg = loadConfig();
  saveConfig({ ...cfg, token: res.token, baseUrl: resolveBaseUrl(flags) });
  out(res, flags, () => console.log(green("✓ ") + `Signed in as ${bold(res.user.email)}. Token saved to ${dim(CONFIG_FILE)}`));
};

commands.signup = async ({ flags }) => {
  const email = await need(flags.email, "email", "Email: ");
  const password = await need(flags.password, "password", "Password: ", { hidden: true });
  const mk = new MailKite("", resolveBaseUrl(flags));
  let res;
  try { res = await mk.request("POST", "/api/auth/signup", { email, password }); }
  catch (e) { return die(e instanceof MailKiteError ? `Signup failed (${e.status}): ${e.message}` : e.message); }
  saveConfig({ ...loadConfig(), token: res.token, baseUrl: resolveBaseUrl(flags) });
  out(res, flags, () => console.log(green("✓ ") + `Account created for ${bold(res.user.email)}. Signed in.`));
};

commands.logout = async ({ flags }) => {
  const cfg = loadConfig();
  delete cfg.token;
  saveConfig(cfg);
  out({ ok: true }, flags, () => console.log(green("✓ ") + "Signed out (token removed)."));
};

commands.whoami = async ({ flags }) => {
  const token = resolveToken(flags);
  if (!token) return die("Not signed in.");
  const claims = decodeJwt(token);
  const info = {
    userId: claims?.sub ?? null,
    baseUrl: resolveBaseUrl(flags),
    tokenExpires: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
    source: flags.token ? "flag" : process.env.MAILKITE_API_KEY ? "MAILKITE_API_KEY" : process.env.MAILKITE_TOKEN ? "MAILKITE_TOKEN" : "config",
  };
  out(info, flags, (i) => {
    console.log(`${bold("user")}    ${i.userId ?? dim("unknown")}`);
    console.log(`${bold("api")}     ${i.baseUrl}`);
    console.log(`${bold("expires")} ${i.tokenExpires ?? dim("n/a")}  ${dim("(" + i.source + ")")}`);
  });
};

commands.send = async ({ flags }) => {
  const mk = client(flags);
  const from = await need(flags.from, "from", "From (you@your-verified-domain): ");
  const to = await need(flags.to, "to", "To: ");
  const subject = await need(flags.subject, "subject", "Subject: ");
  let html = flags.html;
  let text = flags.text;
  if (flags.file) {
    const content = readFileSync(flags.file, "utf8");
    if (flags.file.endsWith(".html") || flags.file.endsWith(".htm")) html = content;
    else text = content;
  }
  if (!html && !text) text = await need("", "body", "Body (text): ");
  const message = { from, to: toList(to).length > 1 ? toList(to) : to, subject };
  if (html) message.html = html;
  if (text) message.text = text;
  if (flags.cc) message.cc = toList(flags.cc);
  if (flags.bcc) message.bcc = toList(flags.bcc);
  if (flags["reply-to"]) message.replyTo = flags["reply-to"];
  if (flags["in-reply-to"]) message.inReplyTo = flags["in-reply-to"];
  let res;
  try { res = await mk.send(message); }
  catch (e) { return die(e instanceof MailKiteError ? `Send failed (${e.status}): ${e.message}` : e.message); }
  out(res, flags, (r) => console.log(green("✓ ") + `Sent — id ${bold(r.id)}, status ${r.status}`));
};

// Send a message straight to an inbox agent and print its reply. Defaults to the account's
// default agent; --route-id / --address pick a specific one, --model overrides the model.
commands.agent = async ({ _, flags }) => {
  const mk = client(flags);
  const text = await need(_[0] || flags.text, "text", "Message to the agent: ");
  const message = { text };
  if (flags.subject) message.subject = flags.subject;
  if (flags.from) message.from = flags.from;
  if (flags["route-id"]) message.routeId = flags["route-id"];
  if (flags.address) message.address = flags.address;
  if (flags.model) message.model = flags.model;
  let res;
  try { res = await mk.agent(message); }
  catch (e) { return die(e instanceof MailKiteError ? `Agent failed (${e.status}): ${e.message}` : e.message); }
  out(res, flags, (r) => { if (r.ok) console.log(r.text || dim("(no reply)")); else die(r.error || "agent run failed"); });
};

// Route a message to one of your registered routes (by id or address), running its action.
commands.route = async ({ _, flags }) => {
  const mk = client(flags);
  const from = await need(flags.from, "from", "From: ");
  const message = { from };
  if (flags["route-id"]) message.routeId = flags["route-id"];
  if (flags.address) message.address = flags.address;
  if (!message.routeId && !message.address) {
    const target = await need(_[0] || "", "route", "Route id (rte_…) or address it matches: ");
    if (target.startsWith("rte_")) message.routeId = target; else message.address = target;
  }
  if (flags.subject) message.subject = flags.subject;
  let text = flags.text;
  if (flags.file) text = readFileSync(flags.file, "utf8");
  if (text) message.text = text;
  if (flags.html) message.html = flags.html;
  let res;
  try { res = await mk.route(message); }
  catch (e) { return die(e instanceof MailKiteError ? `Route failed (${e.status}): ${e.message}` : e.message); }
  out(res, flags, (r) => console.log(green("✓ ") + `Routed — id ${bold(r.id)}, action ${r.action}`));
};

commands.domains = async ({ _, flags }) => {
  const sub = _[0] || "list";
  const mk = client(flags);
  if (sub === "list") {
    const rows = await mk.listDomains();
    return out(rows, flags, (list) => {
      if (!Array.isArray(list) || !list.length) return console.log(dim("No domains yet. Add one: mailkite domains add <domain>"));
      for (const d of list) console.log(`${bold(d.domain)}  ${dim(d.id)}  ${d.status === "verified" ? green(d.status) : d.status}`);
    });
  }
  if (sub === "add") {
    const domain = await need(_[1] || flags.domain, "domain", "Domain to add: ");
    const res = await mk.createDomain({ domain });
    return out(res, flags, (r) => { console.log(green("✓ ") + `Added ${bold(r.domain.domain)} (${dim(r.domain.id)})`); printDns(r.dns); });
  }
  if (sub === "get") {
    const id = await need(_[1] || flags.id, "id", "Domain id: ");
    return out(await mk.getDomain(id), flags);
  }
  if (sub === "verify") {
    const id = await need(_[1] || flags.id, "id", "Domain id: ");
    const res = await mk.verifyDomain(id);
    return out(res, flags, (r) => {
      const mark = (b) => (b ? green("✓") : red("✗"));
      console.log(`status: ${r.status === "verified" ? green(r.status) : r.status}`);
      console.log(`  MX ${mark(r.checks?.mx)}   SPF ${mark(r.checks?.spf)}   DKIM ${mark(r.checks?.dkim)}   DMARC ${mark(r.checks?.dmarc)}`);
    });
  }
  if (sub === "rm" || sub === "delete") {
    const id = await need(_[1] || flags.id, "id", "Domain id: ");
    return out(await mk.deleteDomain(id), flags, () => console.log(green("✓ ") + "Domain removed."));
  }
  if (sub === "check") {
    const domain = await need(_[1] || flags.domain, "domain", "Domain to check: ");
    const res = await mk.checkDomainAvailability(domain);
    return out(res, flags, (r) => {
      if (r.configured === false) return console.log(dim("Domain registration isn't enabled for this account."));
      if (r.available) {
        const p = r.price ? "  " + dim(`${r.price.amount} ${r.price.currency} / ${r.price.period}${r.price.periodUnit}`) : "";
        console.log(green("✓ ") + `${bold(r.domain)} is available${p}${r.premium ? red("  (premium)") : ""}`);
        console.log(dim(`Register it: mailkite domains register ${r.domain}`));
      } else {
        console.log(red("✗ ") + `${bold(r.domain)} is not available${r.reason ? dim(` (${r.reason})`) : ""}`);
      }
    });
  }
  if (sub === "register" || sub === "buy") {
    const domain = await need(_[1] || flags.domain, "domain", "Domain to register: ");
    // Show the price first (no charge) so the user confirms with eyes open.
    const avail = await mk.checkDomainAvailability(domain).catch(() => null);
    if (avail?.configured === false) die("Domain registration isn't enabled for this account.");
    if (avail && !avail.available) die(`${domain} is not available${avail.reason ? ` (${avail.reason})` : ""}.`);
    if (avail?.price) console.error(`Price: ${bold(`${avail.price.amount} ${avail.price.currency}`)} / ${avail.price.period}${avail.price.periodUnit}${avail.premium ? red("  (premium)") : ""}`);
    const contact = {
      firstName: await need(flags["first-name"], "first name", "First name: "),
      lastName: await need(flags["last-name"], "last name", "Last name: "),
      email: await need(flags.email, "email", "Email: "),
      phone: await need(flags.phone, "phone", "Phone (+countrycode.number, e.g. +1.4155551234): "),
      address: await need(flags.address, "address", "Address: "),
      city: await need(flags.city, "city", "City: "),
      zip: await need(flags.zip, "postal code", "Postal code: "),
      country: await need(flags.country, "country", "Country (2-letter, e.g. US): "),
    };
    if (flags.state) contact.state = flags.state;
    const org = flags.organization || flags.org;
    if (org) { contact.organization = org; contact.type = flags.type || "company"; }
    const years = flags.years ? Number(flags.years) : undefined;
    // Final confirmation — this charges the registrar.
    const ans = flags.yes || flags.force ? "y" : (await prompt(`Register ${bold(domain)} now? This charges your registrar. [y/N] `)).toLowerCase();
    if (ans !== "y" && ans !== "yes") return console.error(dim("Cancelled."));
    const res = await mk.registerDomain({ domain, contact, years });
    return out(res, flags, (r) => {
      console.log(green("✓ ") + `Registered ${bold(r.domain?.domain || domain)}${r.registration?.status ? dim(` (${r.registration.status})`) : ""}`);
      if (r.dnsProvisioned) console.log(green("✓ ") + "Mail DNS provisioned automatically.");
      else printDns(r.dns);
    });
  }
  die(`Unknown subcommand: domains ${sub}`);
};

function printDns(records, hintProvider) {
  if (!Array.isArray(records)) return;
  console.log("\n" + bold("DNS records to add at your DNS provider:"));
  for (const r of records) {
    const pri = r.priority != null ? `  priority=${r.priority}` : "";
    console.log(`  ${cyan(r.type.padEnd(4))} ${r.name}\n       → ${r.value}${pri}`);
  }
  const hint = PROVIDER_HINTS[(hintProvider || "").toLowerCase()];
  if (hint) console.log("\n" + dim(hint));
  console.log(dim("\nThen run: mailkite domains verify <id>"));
}

commands.dns = async ({ _, flags }) => {
  const mk = client(flags);
  const idOrDomain = await need(_[0] || flags.domain, "domain", "Domain id: ");
  const res = await mk.getDomain(idOrDomain);
  out(res.dns, flags, (dns) => printDns(dns, flags.provider));
};

commands.webhook = async ({ _, flags }) => {
  const sub = _[0] || "show";
  const mk = client(flags);
  const id = await need(_[1] || flags.id || flags.domain, "domain id", "Domain id: ");
  if (sub === "set") {
    const url = await need(_[2] || flags.url, "url", "Webhook URL (https://…): ");
    const res = await mk.setWebhook(id, { url });
    return out(res, flags, (r) => console.log(green("✓ ") + `Webhook set → ${bold(r.webhookUrl)}`));
  }
  if (sub === "rm" || sub === "delete") {
    return out(await mk.deleteWebhook(id), flags, () => console.log(green("✓ ") + "Webhook removed."));
  }
  if (sub === "test") {
    const res = await mk.testWebhook(id);
    return out(res, flags, (r) => console.log((r.ok ? green("✓ ") : red("✗ ")) + `Test event delivered — HTTP ${r.status}`));
  }
  if (sub === "show") {
    const d = await mk.getDomain(id);
    return out({ webhookUrl: d.domain?.webhookUrl ?? null }, flags, (r) => console.log(r.webhookUrl || dim("No webhook set.")));
  }
  die(`Unknown subcommand: webhook ${sub}`);
};

commands.secret = async ({ _, flags }) => {
  const sub = _[0] || "get";
  const mk = client(flags);
  if (sub === "get") return out(await mk.request("GET", "/api/webhooks/secret"), flags, (r) => console.log(r.secret));
  if (sub === "rotate") return out(await mk.request("POST", "/api/webhooks/secret/rotate"), flags, (r) => console.log(green("✓ ") + r.secret));
  die(`Unknown subcommand: secret ${sub}`);
};

commands.routes = async ({ _, flags }) => {
  const sub = _[0] || "list";
  const mk = client(flags);
  if (sub === "list") {
    return out(await mk.listRoutes(), flags, (list) => {
      if (!Array.isArray(list) || !list.length) return console.log(dim("No routes."));
      for (const r of list) console.log(`${bold(r.match_pattern)} → ${r.action}${r.destination ? " " + dim(r.destination) : ""}`);
    });
  }
  if (sub === "create") {
    const match = await need(flags.match, "match", "Match (e.g. support@you.dev): ");
    const action = await need(flags.action, "action", "Action (webhook|forward|store|drop): ");
    const destination = flags.destination || "";
    const res = await mk.createRoute({ match, action, destination });
    return out(res, flags, (r) => console.log(green("✓ ") + `Route created ${dim(r.id || "")}`));
  }
  die(`Unknown subcommand: routes ${sub}`);
};

commands.messages = async ({ _, flags }) => {
  const sub = _[0] || "list";
  const mk = client(flags);
  if (sub === "list") {
    // Optional newest-first paging: --before <received_at cursor> --limit <n>.
    return out(await mk.listMessages(flags.before, flags.limit), flags, (list) => {
      if (!Array.isArray(list) || !list.length) return console.log(dim("No messages yet."));
      for (const m of list) console.log(`${dim(new Date(m.received_at).toISOString())}  ${bold(m.from_addr)} → ${m.to_addr}  ${m.subject || dim("(no subject)")}`);
    });
  }
  if (sub === "get") {
    const id = await need(_[1] || flags.id, "id", "Message id: ");
    return out(await mk.getMessage(id), flags);
  }
  if (sub === "tail") return tailMessages(mk, flags);
  die(`Unknown subcommand: messages ${sub}`);
};

// Poll /api/messages and print new arrivals — how the CLI (and the AI skill)
// confirm an inbound email was received, with no public webhook needed.
async function tailMessages(mk, flags) {
  const intervalMs = Number(flags.interval || 2000);
  const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 0;
  const matchSubject = flags.subject ? String(flags.subject) : null;
  const started = Date.now();
  const seen = new Set();
  // Seed with existing ids unless --all, so we only surface genuinely new mail.
  if (!flags.all) {
    try { for (const m of await mk.listMessages()) seen.add(m.id); } catch {}
  }
  if (!flags.json) console.error(dim(`Waiting for inbound mail… (poll ${intervalMs}ms${timeoutMs ? `, timeout ${timeoutMs / 1000}s` : ""})`));
  while (true) {
    let list = [];
    try { list = await mk.listMessages(); } catch (e) { if (!flags.json) console.error(red("poll error: ") + e.message); }
    for (const m of Array.isArray(list) ? list.slice().reverse() : []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (matchSubject && !(m.subject || "").includes(matchSubject)) continue;
      if (flags.json) console.log(JSON.stringify(m));
      else console.log(green("● ") + `${bold(m.from_addr)} → ${m.to_addr}  ${m.subject || dim("(no subject)")}  ${dim(m.id)}`);
      if (flags.once) return;
    }
    if (timeoutMs && Date.now() - started > timeoutMs) {
      if (!flags.json) console.error(dim("timeout reached."));
      process.exit(flags["fail-on-timeout"] ? 2 : 0);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

commands.deliveries = async ({ _, flags }) => {
  const sub = _[0];
  const mk = client(flags);
  if (sub === "retry") {
    const id = await need(_[1] || flags.id, "id", "Delivery id: ");
    return out(await mk.retryDelivery(id), flags, (r) => console.log((r.ok ? green("✓ ") : red("✗ ")) + `Retried — HTTP ${r.status}`));
  }
  die(`Unknown subcommand: deliveries ${sub || ""}`);
};

// Verify an x-mailkite-signature header locally (no network) via the SDK helper.
commands["verify-webhook"] = async ({ flags }) => {
  const signature = await need(flags.signature, "signature", "x-mailkite-signature value: ");
  const secret = await need(flags.secret, "secret", "Webhook secret (whsec_…): ");
  let payload = flags.payload;
  if (flags.file) payload = readFileSync(flags.file, "utf8");
  if (payload == null) payload = await need("", "payload", "Raw request body: ");
  const tolerance = flags.tolerance != null ? Number(flags.tolerance) : undefined;
  const valid = MailKite.verifyWebhook(signature, payload, secret, tolerance);
  out({ valid }, flags, () => console.log(valid ? green("✓ valid signature") : red("✗ invalid signature")));
  if (!valid) process.exit(3);
};

// Launch the MailKite MCP server (stdio), passing the stored token through.
// Long-running: we await the child so the CLI stays up for the duration.
commands.mcp = async ({ flags }) => {
  const token = resolveToken(flags);
  const env = { ...process.env };
  if (token) env.MAILKITE_API_KEY = token;
  env.MAILKITE_BASE_URL = resolveBaseUrl(flags);
  const child = spawn("npx", ["-y", "@mailkite/mcp"], { stdio: "inherit", env });
  await new Promise((resolve) => child.on("exit", (code) => { process.exitCode = code ?? 0; resolve(); }));
};

// Onboarding wizard: login → add domain → DNS → verify → webhook → test send.
// Scriptable: pass --email/--password/--domain/--webhook/--to to run unattended.
commands.init = async ({ flags }) => {
  console.error(bold("MailKite setup\n"));
  // 1. Auth
  if (!resolveToken(flags)) {
    console.error("1. Sign in");
    await (flags.signup ? commands.signup : commands.login)({ _: [], flags });
  } else {
    console.error(green("1. ✓ Already signed in"));
  }
  const mk = client(flags);
  // 2. Domain
  const domain = await need(flags.domain, "domain", "\n2. Domain to add (e.g. mail.yourapp.com): ");
  let dom;
  const existing = (await mk.listDomains().catch(() => [])).find?.((d) => d.domain === domain);
  if (existing) { dom = existing; console.error(green(`   ✓ ${domain} already added (${dom.id})`)); const full = await mk.getDomain(dom.id); printDns(full.dns, flags.provider); }
  else { const r = await mk.createDomain({ domain }); dom = r.domain; console.error(green(`   ✓ Added ${domain}`)); printDns(r.dns, flags.provider); }
  // 3. Verify (optional wait)
  if (flags.verify || flags.wait) {
    console.error("\n3. Verifying DNS…");
    const deadline = Date.now() + (flags.wait ? Number(flags.wait) * 1000 : 0);
    let v;
    do {
      v = await mk.verifyDomain(dom.id);
      if (v.status === "verified") break;
      if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 5000));
    } while (Date.now() < deadline);
    console.error(v.status === "verified" ? green("   ✓ Verified") : red(`   ✗ Not verified yet (${JSON.stringify(v.checks)}) — DNS can take time.`));
  }
  // 4. Webhook
  if (flags.webhook) {
    const res = await mk.setWebhook(dom.id, { url: flags.webhook });
    console.error(green(`\n4. ✓ Webhook → ${res.webhookUrl}`));
  }
  // 5. Test send
  if (flags.to) {
    const from = flags.from || `hello@${domain}`;
    try {
      const r = await mk.send({ from, to: flags.to, subject: flags.subject || "MailKite test ✅", text: "It works — sent from the MailKite CLI.", html: "<p>It works — sent from the <strong>MailKite CLI</strong>.</p>" });
      console.error(green(`\n5. ✓ Test email sent (id ${r.id})`));
    } catch (e) { console.error(red(`\n5. ✗ Send failed: ${e.message}`)); }
  }
  console.error(bold("\nDone.") + " Next: set DNS at your provider, then `mailkite domains verify " + dom.id + "`.");
};

commands.version = async ({ flags }) => out({ version: VERSION }, flags, () => console.log(`mailkite/${VERSION} node-${process.version}`));

// ---- help -------------------------------------------------------------------
const HELP = `${bold("mailkite")} — MailKite command-line client  ${dim("v" + VERSION)}

${bold("USAGE")}
  mailkite <command> [subcommand] [--flags]

${bold("AUTH")}
  login            Sign in with email + password; saves the token
  signup           Create an account and sign in
  logout           Remove the saved token
  whoami           Show the signed-in user, API base, and token expiry

${bold("SEND")}
  send             Send a message  (--from --to --subject [--html|--text|--file] [--cc --bcc --reply-to --in-reply-to])

${bold("AGENTS")}
  agent <text>     Message an inbox agent and print its reply  ([--route-id|--address] [--model --subject --from])
  route            Route a message to a registered route  (--route-id <id>|--address <addr> --from [--subject --text|--file --html])

${bold("DOMAINS & DNS")}
  domains list                 List your domains
  domains add <domain>         Add a domain you own; prints the DNS records to set
  domains check <domain>       Check if a domain is available to register (+ price)
  domains register <domain>    Buy a domain; provisions DNS + adds it (--first-name --last-name
                               --email --phone --address --city --zip --country [--state --org --years --yes])
  domains get <id>             Show a domain (with DNS + webhook)
  domains verify <id>          Re-check DNS (MX/SPF/DKIM/DMARC)
  domains rm <id>              Remove a domain
  dns <id> [--provider cf|godaddy|…]   Print DNS records (+ provider hint)

${bold("WEBHOOKS & RECEIVING")}
  webhook set <id> <url>       Set the domain's catch-all webhook
  webhook rm <id>              Remove the webhook
  webhook test <id>            Send a signed test event to the webhook
  secret get | rotate          The account webhook signing secret (whsec_…)
  verify-webhook --signature --secret [--file|--payload]   Verify a signature locally
  messages list | get <id>     Stored inbound messages
  messages tail [--once --timeout N --subject TXT --json]  Wait for new inbound mail
  routes list | create --match --action --destination

${bold("DELIVERIES")}
  deliveries retry <id>        Re-deliver a stored message to its webhook

${bold("WORKFLOW")}
  init [--email --password --domain --webhook --to --verify --wait N]
                               End-to-end setup wizard (scriptable for agents)
  mcp                          Run the MailKite MCP server (stdio) with your token

${bold("GLOBAL FLAGS")}
  --json            Machine-readable JSON output (great for scripts/agents)
  --token <t>       Bearer token (overrides env + config)
  --base-url <u>    API base URL (default ${DEFAULT_BASE_URL})
  -h, --help        Show help     -v, --version  Show version

${bold("ENV")}  MAILKITE_API_KEY / MAILKITE_TOKEN, MAILKITE_BASE_URL
${bold("CONFIG")}  ${CONFIG_FILE}
`;

// ---- main -------------------------------------------------------------------
async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  if (flags.version && !_.length) return commands.version({ _, flags });
  const cmd = _.shift();
  if (!cmd || flags.help && !cmd) { console.log(HELP); return; }
  const handler = commands[cmd];
  if (!handler) { console.error(red(`Unknown command: ${cmd}\n`)); console.log(HELP); process.exit(1); }
  if (flags.help) { console.log(HELP); return; }
  try {
    await handler({ _, flags });
  } catch (e) {
    if (e instanceof MailKiteError) die(`API error ${e.status}: ${e.message}`);
    die(e?.stack || e?.message || String(e));
  }
  // The SDK uses fetch (undici), whose keep-alive sockets keep the event loop
  // alive for a few seconds after the work is done. Give stdout a brief tick to
  // drain (matters when piped), then exit promptly so commands return at once and
  // stay snappy for scripts/agents — regardless of TTY vs pipe.
  await new Promise((r) => setTimeout(r, 25));
  process.exit(process.exitCode || 0);
}

main();
