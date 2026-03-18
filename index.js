require("dotenv").config();

const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();

// ── CORS für Shopify Storefront ───────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = [
    "https://durst-merch.myshopify.com",
    "https://www.durst-merch.com",
  ];
  const origin = req.headers.origin;
  if (origin && allowed.some((o) => origin.startsWith(o))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Raw body für Webhook-Signaturprüfung aufbewahren
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ── Multer: Feld heißt "pdf" (so schickt das Theme es) ───────────────────────
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Nur PDF-Dateien erlaubt"));
    }
  },
});

// ── POST /api/business-card/upload ───────────────────────────────────────────
app.post("/api/business-card/upload", upload.single("pdf"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Keine Datei empfangen. Feld muss 'pdf' heißen." });
    }

    const jobId = uuidv4();
    const folder = path.join(__dirname, "storage", jobId);
    fs.mkdirSync(folder, { recursive: true });

    const filePath = path.join(folder, "card.pdf");
    fs.renameSync(req.file.path, filePath);

    const host = process.env.PUBLIC_URL || `https://${req.get("host")}`;
    const pdfUrl = `${host}/files/${jobId}`;

    console.log(`[upload] job_id=${jobId} pdf_url=${pdfUrl}`);

    res.json({ ok: true, job_id: jobId, pdf_url: pdfUrl });
  } catch (error) {
    console.error("[upload] Fehler:", error);
    res.status(500).json({ error: "Upload fehlgeschlagen" });
  }
});

// ── GET /files/:id ────────────────────────────────────────────────────────────
app.get("/files/:id", (req, res) => {
  const filePath = path.join(__dirname, "storage", req.params.id, "card.pdf");
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Not found");
  }
  res.sendFile(filePath);
});

// ── POST /webhooks/orders-create ─────────────────────────────────────────────
app.post("/webhooks/orders-create", async (req, res) => {
  // Shopify erwartet HTTP 200 innerhalb von 5 Sekunden
  res.sendStatus(200);

  try {
    const order = req.body;
    if (!order || !order.id) return;

    console.log(`[webhook] Order ${order.id} empfangen`);

    // Properties aus Line Items extrahieren
    let jobId = null;
    let pdfUrl = null;

    for (const item of order.line_items || []) {
      for (const prop of item.properties || []) {
        if (prop.name === "_business_card_job_id") jobId = prop.value;
        if (prop.name === "_business_card_pdf_url") pdfUrl = prop.value;
      }
    }

    if (!jobId || !pdfUrl) {
      console.log(`[webhook] Order ${order.id}: keine Business-Card-Properties gefunden`);
      return;
    }

    console.log(`[webhook] Order ${order.id}: job_id=${jobId}, pdf_url=${pdfUrl}`);

    // Metafields auf der Order setzen
    await setOrderMetafields(order.id, jobId, pdfUrl);
  } catch (err) {
    console.error("[webhook] Fehler:", err);
  }
});

// ── Shopify Admin GraphQL: Metafields setzen ──────────────────────────────────
async function setOrderMetafields(orderId, jobId, pdfUrl) {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || "2026-01";

  if (!shop || !token) {
    console.error("[metafields] SHOPIFY_SHOP oder SHOPIFY_ADMIN_ACCESS_TOKEN fehlt in .env");
    return;
  }

  const ownerId = `gid://shopify/Order/${orderId}`;

  const mutation = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { namespace key value }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId,
        namespace: "custom",
        key: "business_card_job_id",
        type: "single_line_text_field",
        value: jobId,
      },
      {
        ownerId,
        namespace: "custom",
        key: "business_card_pdf_url",
        type: "url",
        value: pdfUrl,
      },
    ],
  };

  const fetch = require("node-fetch");

  const response = await fetch(
    `https://${shop}/admin/api/${version}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query: mutation, variables }),
    }
  );

  const data = await response.json();

  if (data.errors) {
    console.error("[metafields] GraphQL-Fehler:", JSON.stringify(data.errors));
    return;
  }

  const userErrors = data?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length > 0) {
    console.error("[metafields] userErrors:", JSON.stringify(userErrors));
    return;
  }

  console.log(`[metafields] Order ${orderId}: Metafields gesetzt ✓`);
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Backend läuft ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
