// Orders check — Oak Joinery
// ============================================================================
// Runs every Monday and Wednesday morning (see .github/workflows/orders-check.yml)
// via GitHub Actions. Reads the Orders app's data from Firebase and emails ONE
// summary of every order that was placed a week or more ago and still has
// items outstanding, grouped by supplier — so you know who to chase.
//
// Uses the same GitHub secrets as the weekly reorder email (nothing new to set
// up): FIREBASE_DB_URL, EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID,
// EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, DIGEST_RECIPIENT_EMAIL.
// ============================================================================

const env = process.env;
const LATE_DAYS = 7;
const APP_URL = "https://seanoakjoinery.github.io/oak-core/orders/";

function requireEnv() {
  const missing = ["FIREBASE_DB_URL", "EMAILJS_SERVICE_ID", "EMAILJS_TEMPLATE_ID", "EMAILJS_PUBLIC_KEY", "EMAILJS_PRIVATE_KEY", "DIGEST_RECIPIENT_EMAIL"]
    .filter((k) => !env[k]);
  if (missing.length) throw new Error("Missing required secrets: " + missing.join(", "));
}

async function fetchJson(path) {
  const res = await fetch(`${env.FIREBASE_DB_URL}/${path}.json`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
  return (await res.json()) || {};
}

const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
function daysSince(ymd) {
  if (!ymd) return 0;
  return Math.floor((Date.now() - new Date(ymd + "T00:00:00+02:00").getTime()) / 86400000);
}
function fmtDate(ymd) {
  return new Date(ymd + "T00:00:00+02:00").toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Johannesburg" });
}

// Pure: returns [{ supplier, email, orders:[{ ref, orderedDate, days, lines:[text] }] }]
function lateOrders(orders) {
  const groups = {};
  Object.entries(orders || {}).forEach(([id, o]) => {
    if (!o || (o.status !== "ordered" && o.status !== "part")) return;
    const days = daysSince(o.orderedDate);
    if (days < LATE_DAYS) return;
    const lines = Object.values(o.lines || {})
      .sort((a, b) => num(a.n) - num(b.n))
      .map((l) => ({ l, out: Math.round((num(l.qty) - num(l.received)) * 100) / 100 }))
      .filter((x) => x.out > 0)
      .map(({ l, out }) => `${out} ${l.unit || ""} of ${(l.desc || l.text || l.stockLabel || "item").trim()}${num(l.received) ? ` (${num(l.received)} of ${num(l.qty)} received)` : ""}`.replace(/\s+/g, " "));
    if (!lines.length) return;
    const location = String(o.location || "No location set").trim();
    const key = location.toLowerCase() + "|" + String(o.supplier || "Unknown supplier").trim().toLowerCase();
    groups[key] = groups[key] || { location, supplier: String(o.supplier || "Unknown supplier").trim(), email: o.supplierEmail || "", orders: [] };
    if (!groups[key].email && o.supplierEmail) groups[key].email = o.supplierEmail;
    groups[key].orders.push({ id, ref: o.ref || "", orderedDate: o.orderedDate, days, lines });
  });
  return Object.values(groups)
    .map((g) => ({ ...g, orders: g.orders.sort((a, b) => String(a.orderedDate).localeCompare(String(b.orderedDate))) }))
    .sort((a, b) => a.location.localeCompare(b.location) || b.orders[0].days - a.orders[0].days);
}

function buildMessage(groups) {
  const day = new Date().toLocaleDateString("en-ZA", { weekday: "long", timeZone: "Africa/Johannesburg" });
  const locations = [...new Set(groups.map((g) => g.location))];
  const section = (gs) => gs.map((g) => {
    const head = `${g.supplier}${g.email ? " <" + g.email + ">" : ""}`;
    const body = g.orders.map((o) =>
      `  ${o.ref ? o.ref + " — " : ""}ordered ${fmtDate(o.orderedDate)} (${o.days} days ago)\n` +
      o.lines.map((t) => `    • ${t}`).join("\n")).join("\n");
    return `${head}\n${body}`;
  }).join("\n\n");
  const parts = locations.map((loc) => {
    const gs = groups.filter((g) => g.location === loc);
    const n = gs.reduce((a, g) => a + g.orders.length, 0);
    return `=== ${loc.toUpperCase()} — ${n} order(s) ===\n\n${section(gs)}`;
  });
  const count = groups.reduce((a, g) => a + g.orders.length, 0);
  return `${day} orders check: ${count} order(s) placed ${LATE_DAYS}+ days ago still have items outstanding.\n\n` +
    parts.join("\n\n") +
    `\n\nOpen the Orders app to receive deliveries or close orders that aren't coming:\n${APP_URL}`;
}

async function sendEmail(groups, extra) {
  const count = groups.reduce((a, g) => a + g.orders.length, 0);
  const payload = {
    service_id: env.EMAILJS_SERVICE_ID,
    template_id: env.EMAILJS_TEMPLATE_ID,
    user_id: env.EMAILJS_PUBLIC_KEY,
    accessToken: env.EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email: [env.DIGEST_RECIPIENT_EMAIL].concat(extra || []).join(","),
      cc_email: "",
      from_name: "Orders check",
      item_name: `Orders check — ${count} order(s) outstanding after a week (${groups.map((g) => g.supplier).join(", ")})`.slice(0, 250),
      current_qty: "",
      reorder_qty: "",
      message: buildMessage(groups),
    },
  };
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`EmailJS send failed: ${res.status} ${await res.text().catch(() => "")}`);
}

async function main() {
  requireEnv();
  const orders = await fetchJson("orders/list");
  const groups = lateOrders(orders);
  if (!groups.length) {
    console.log("No orders outstanding after a week — no email sent.");
    return;
  }
  console.log(buildMessage(groups));
  const meta = await fetchJson("boardStock/meta");
  const extra = String(meta.digestExtra || "").split(/[,;\s]+/).filter((x) => /@/.test(x));
  if (extra.length) console.log("Also sending to: " + extra.join(", "));
  await sendEmail(groups, extra);
  console.log("Email sent.");
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
module.exports = { lateOrders, buildMessage };
