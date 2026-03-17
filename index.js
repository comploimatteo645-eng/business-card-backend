const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());

// Upload Endpoint
app.post("/api/business-card/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Keine Datei empfangen" });
    }

    const jobId = uuidv4();
    const folder = path.join(__dirname, "storage", jobId);

    fs.mkdirSync(folder, { recursive: true });

    const filePath = path.join(folder, "card.pdf");
    fs.renameSync(req.file.path, filePath);

    res.json({
      ok: true,
      job_id: jobId,
      pdf_url: `${req.protocol}://${req.get("host")}/files/${jobId}`
    });
  } catch (error) {
    console.error("Upload-Fehler:", error);
    res.status(500).json({ error: "Upload fehlgeschlagen" });
  }
});

// PDF ausliefern
app.get("/files/:id", (req, res) => {
  const filePath = path.join(__dirname, "storage", req.params.id, "card.pdf");

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Not found");
  }

  res.sendFile(filePath);
});

app.get("/", (req, res) => {
  res.send("Backend läuft");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});