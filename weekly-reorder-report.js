// Weekly Reorder Digest — Oak Joinery
// ============================================================================
// Runs on a schedule (see .github/workflows/weekly-reorder.yml, every Monday
// morning) via GitHub Actions — NOT inside any of the four apps' browsers.
// This is what replaces the old "send an email the instant something crosses
// its reorder level" behaviour: instead, this script reads the exact same
// Firebase data those apps already write to, works out what's currently low,
// and sends ONE EMAIL PER SUPPLIER (grouped by the supplier's email address,
// not by which app the item lives in — so a supplier who supplies both boards
// AND screws still only gets one email covering both).
//
// Per user request ("send it to me and i then can forward it to suppliers"),
// every email's TO address is the digest recipient (DIGEST_RECIPIENT_EMAIL),
// not the supplier directly — each email's subject and a line at the top
// name which supplier it's for and their real email address, so it can be
// forwarded on with no further editing needed.
//
// Required GitHub Actions repository secrets (Settings -> Secrets and
// variables -> Actions -> "New repository secret"):
//   FIREBASE_DB_URL          e.g. https://oak-joinery-stock-dispatch-default-rtdb.europe-west1.firebasedatabase.app
//   EMAILJS_SERVICE_ID
//   EMAILJS_TEMPLATE_ID
//   EMAILJS_PUBLIC_KEY
//   EMAILJS_PRIVATE_KEY      EmailJS Dashboard -> Account -> General -> "Private Key" —
//                            NOT the same as the Public Key already used inside the
//                            four apps. Needed because EmailJS's REST API requires it
//                            to authenticate requests that aren't coming from a browser.
//   DIGEST_RECIPIENT_EMAIL   Where every digest email actually lands (e.g. Sean's inbox)
// ============================================================================

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const DIGEST_RECIPIENT_EMAIL = process.env.DIGEST_RECIPIENT_EMAIL;

function requireEnv() {
  const missing = ["FIREBASE_DB_URL", "EMAILJS_SERVICE_ID", "EMAILJS_TEMPLATE_ID", "EMAILJS_PUBLIC_KEY", "EMAILJS_PRIVATE_KEY", "DIGEST_RECIPIENT_EMAIL"]
    .filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error("Missing required secrets: " + missing.join(", "));
  }
}

async function fetchJson(path) {
  const res = await fetch(`${FIREBASE_DB_URL}/${path}.json`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
  return (await res.json()) || {};
}

function mlToLabel(ml) {
  return ml >= 1000 ? (ml / 1000).toFixed(ml % 1000 === 0 ? 0 : 1) + " L" : ml + " ml";
}

// ---- Board Stock Take -------------------------------------------------
function collectLowBoards(boardStock) {
  const boards = boardStock.boards || [];
  const suppliers = boardStock.suppliers || {};
  const out = [];
  boards.forEach((b) => {
    const total = typeof b.qty === "number" ? b.qty : Object.values(b.qty || {}).reduce((a, v) => a + (Number(v) || 0), 0);
    if (total <= (b.reorderLevel || 0)) {
      const supplier = b.supplierId ? suppliers[b.supplierId] : null;
      out.push({
        line: `${b.description} (${b.code}): ${total} ${b.unit} on hand (reorder at ${b.reorderLevel} ${b.unit})`,
        supplierEmail: supplier && supplier.email ? supplier.email.trim() : null,
        supplierName: supplier ? supplier.name : null,
        supplierContact: supplier ? supplier.contactPerson : null,
        supplierCc: supplier ? supplier.ccEmail : null,
        sendDirect: !!(supplier && supplier.sendDirect),
        app: "Board Stock Take",
      });
    }
  });
  return out;
}

// ---- Consumables Stock Take --------------------------------------------
function collectLowConsumables(consumablesStock) {
  const suppliers = consumablesStock.suppliers || {};
  const out = [];

  Object.values(consumablesStock.screwItems || {}).forEach((item) => {
    const total = typeof item.qtyByLocation === "object"
      ? Object.values(item.qtyByLocation || {}).reduce((a, v) => a + (Number(v) || 0), 0)
      : (item.qtyBundles || 0);
    if (total <= (item.reorderQty || 0)) {
      const supplier = item.supplierId ? suppliers[item.supplierId] : null;
      out.push({
        line: `${item.size}: ${total} bundle(s) on hand (reorder at ${item.reorderQty})`,
        supplierEmail: supplier && supplier.email ? supplier.email.trim() : null,
        supplierName: supplier ? supplier.name : null,
        supplierContact: supplier ? supplier.contactPerson : null,
        supplierCc: supplier ? supplier.ccEmail : null,
        sendDirect: !!(supplier && supplier.sendDirect),
        app: "Consumables",
      });
    }
  });

  const units = consumablesStock.consumableUnits || {};
  Object.entries(consumablesStock.consumableTypes || {}).forEach(([tid, type]) => {
    const supplier = type.supplierId ? suppliers[type.supplierId] : null;
    let low, line;
    if (type.category === "liquid") {
      const totalMl = Object.values(type.volumeByLocation || {}).reduce((a, v) => a + (Number(v) || 0), 0);
      low = totalMl <= (type.reorderLevelMl || 0);
      line = `${type.name}: ${mlToLabel(totalMl)} on hand (reorder at ${mlToLabel(type.reorderLevelMl || 0)})`;
    } else {
      const active = Object.values(units).filter((u) => u.typeId === tid && u.fillLevel !== "Finished").length;
      low = active <= (type.reorderQty || 0);
      line = `${type.name}: ${active} active container(s) (reorder at ${type.reorderQty || 0})`;
    }
    if (low) {
      out.push({
        line,
        supplierEmail: supplier && supplier.email ? supplier.email.trim() : null,
        supplierName: supplier ? supplier.name : null,
        supplierContact: supplier ? supplier.contactPerson : null,
        supplierCc: supplier ? supplier.ccEmail : null,
        sendDirect: !!(supplier && supplier.sendDirect),
        app: "Consumables",
      });
    }
  });

  return out;
}

// Groups by supplier EMAIL (not by internal ID) so the same real-world
// supplier entered separately in both apps still gets ONE combined email.
// sendDirect is OR'd across every matching record — if a supplier is
// marked direct-send in EITHER app, the merged group is treated as
// direct-send, since it's the same real recipient either way.
function groupBySupplierEmail(items) {
  const groups = {};
  items.forEach((item) => {
    const key = item.supplierEmail || "__unassigned";
    if (!groups[key]) {
      groups[key] = {
        supplierEmail: item.supplierEmail,
        supplierName: item.supplierName || "Unassigned supplier",
        supplierContact: item.supplierContact,
        supplierCc: item.supplierCc,
        sendDirect: false,
        lines: [],
      };
    }
    if (item.sendDirect) groups[key].sendDirect = true;
    groups[key].lines.push(`[${item.app}] ${item.line}`);
  });
  return Object.values(groups);
}

async function sendDigestEmail(group) {
  const greeting = "Good day" + (group.supplierContact ? " " + group.supplierContact : "") + ",";
  // Direct-send suppliers get the email addressed straight to them (still
  // cc'd to the digest recipient, so nothing sent automatically happens
  // without a record landing in your own inbox too) — everyone else gets
  // it addressed to the digest recipient, with a forwarding note, exactly
  // as before.
  const goingDirect = group.sendDirect && group.supplierEmail;
  const toEmail = goingDirect ? group.supplierEmail : DIGEST_RECIPIENT_EMAIL;
  const ccEmail = goingDirect
    ? [DIGEST_RECIPIENT_EMAIL, group.supplierCc].filter(Boolean).join(",")
    : "";
  const forwardNote = goingDirect
    ? ""
    : group.supplierEmail
      ? `Forward this to: ${group.supplierName} <${group.supplierEmail}>${group.supplierCc ? " (cc: " + group.supplierCc + ")" : ""}\n\n`
      : `No supplier assigned to these items yet — add one in the app so this gets grouped properly next week.\n\n`;
  const numberedLines = group.lines.map((l, idx) => `${idx + 1}. ${l}`).join("\n");
  const message = `${forwardNote}${greeting}\n\nI hope this email finds you well.\n\nPlease quote me on the following:\n\n${numberedLines}\n\nKind regards,`;

  const payload = {
    service_id: EMAILJS_SERVICE_ID,
    template_id: EMAILJS_TEMPLATE_ID,
    user_id: EMAILJS_PUBLIC_KEY,
    accessToken: EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email: toEmail,
      cc_email: ccEmail,
      from_name: "Weekly Reorder Digest",
      item_name: `Weekly reorder digest — ${group.supplierName} (${group.lines.length} item(s))`,
      current_qty: "",
      reorder_qty: "",
      message,
    },
  };

  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`EmailJS send failed for ${group.supplierName}: ${res.status} ${text}`);
  }
}

async function main() {
  requireEnv();

  const [boardStock, consumablesStock] = await Promise.all([
    fetchJson("boardStock"),
    fetchJson("consumablesStock"),
  ]);

  const lowItems = [
    ...collectLowBoards(boardStock),
    ...collectLowConsumables(consumablesStock),
  ];

  if (lowItems.length === 0) {
    console.log("Nothing is below its reorder level this week — no emails sent.");
    return;
  }

  const groups = groupBySupplierEmail(lowItems);
  console.log(`Sending ${groups.length} digest email(s) covering ${lowItems.length} low item(s)...`);

  for (const group of groups) {
    try {
      await sendDigestEmail(group);
      console.log(`Sent: ${group.supplierName} (${group.lines.length} item(s))`);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1; // fail the Actions run so it shows up as a failure, but keep sending the rest
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
