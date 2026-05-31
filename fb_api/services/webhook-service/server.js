require("dotenv").config();

const express = require("express");
const { connectProducer, sendToKafka } = require("./kafka");

const app = express();
app.use(express.json());

const PORT         = process.env.PORT         || 3001;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "123456";
const KAFKA_TOPIC  = process.env.KAFKA_TOPIC  || "raw_events";
const USE_NGROK    = process.env.USE_NGROK    !== "false"; // mặc định bật

// ── Facebook verify webhook ───────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified bởi Facebook");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Verify token không hợp lệ");
});

// ── Nhận event từ Facebook ────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log("\n[Webhook] 📩 Nhận Facebook event:");
    console.log(JSON.stringify(body, null, 2));

    const normalizedEvent = {
      source   : "facebook",
      eventType: "raw_event",
      receivedAt: new Date().toISOString(),
      payload  : body,
    };

    await sendToKafka(KAFKA_TOPIC, normalizedEvent);
    console.log(`[Webhook] ✅ Đã đẩy vào Kafka topic: ${KAFKA_TOPIC}`);

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("[Webhook] ❌ Lỗi:", error.message);
    return res.status(500).json({ message: "Webhook lỗi", error: error.message });
  }
});

app.get("/", (req, res) => res.send("Webhook service is running on port " + PORT));

// ── Khởi động ─────────────────────────────────────────────────────────────────
async function start() {
  await connectProducer();

  app.listen(PORT, async () => {
    console.log("╔══════════════════════════════════════════╗");
    console.log("║        WEBHOOK SERVICE — Started         ║");
    console.log("╚══════════════════════════════════════════╝");
    console.log(`[Webhook] Local URL   : http://localhost:${PORT}`);
    console.log(`[Webhook] Verify token: ${VERIFY_TOKEN}`);
    console.log(`[Webhook] Kafka topic : ${KAFKA_TOPIC}`);

    // Tự động mở ngrok tunnel để Facebook có thể gọi vào
    if (USE_NGROK) {
      try {
        const ngrok = require("ngrok");
        const options = { addr: PORT };
        if (process.env.NGROK_AUTHTOKEN) {
          options.authtoken = process.env.NGROK_AUTHTOKEN;
        }
        const url = await ngrok.connect(options);
        console.log("\n" + "═".repeat(55));
        console.log("🌐 NGROK PUBLIC URL (dùng để cấu hình Facebook Webhook):");
        console.log(`   Callback URL  : ${url}/webhook`);
        console.log(`   Verify Token  : ${VERIFY_TOKEN}`);
        console.log("═".repeat(55));
        console.log("👉 Dán URL trên vào Facebook Developer Console:");
        console.log("   App → Webhooks → Edit → Callback URL");
      } catch (err) {
        console.warn("\n[Webhook] ⚠️  Không thể khởi động ngrok:", err.message);
        console.warn("[Webhook]    Dùng thủ công: npx ngrok http " + PORT);
      }
    }
  });
}

start();