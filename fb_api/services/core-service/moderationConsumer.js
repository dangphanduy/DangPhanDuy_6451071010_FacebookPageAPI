/**
 * moderationConsumer.js
 * Một consumer độc lập lắng nghe topic `moderation_actions`
 * để hiển thị các hành động kiểm duyệt (ẩn/blacklist/queue) theo thời gian thực.
 */

require("dotenv").config();
const { Kafka } = require("kafkajs");

const BROKER = process.env.KAFKA_BROKER || "localhost:9092";
const TOPIC = process.env.MODERATION_TOPIC || "moderation_actions";

const kafka = new Kafka({
  clientId: "moderation-monitor",
  brokers: [BROKER],
});

const consumer = kafka.consumer({ groupId: "moderation-monitor-group" });

async function run() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     MODERATION MONITOR — Starting        ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`[Monitor] Broker : ${BROKER}`);
  console.log(`[Monitor] Topic  : ${TOPIC}`);

  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });

  console.log(`[Monitor] ✅ Đang lắng nghe các hành động moderation...\n`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const payload = JSON.parse(message.value.toString());
        const time = payload.receivedAt ? new Date(payload.receivedAt).toLocaleTimeString() : new Date().toLocaleTimeString();

        console.log(`\n[${time}] 🚨 MODERATION ACTION DETECTED`);
        console.log(`  └─ Action : ${payload.action}`);
        console.log(`  └─ Reason : ${payload.reason}`);
        console.log(`  └─ User   : ${payload.userId}`);
        console.log(`  └─ Status : Hidden=${payload.hidden}, Queued=${payload.addedToReviewQueue}`);
        
        if (payload.action === "hide_and_blacklist") {
          console.log(`  ⚠️  USER BLACKLISTED (Total violations: ${payload.blacklistInfo?.totalViolations || 'N/A'})`);
        }
        
        console.log("─".repeat(50));
      } catch (err) {
        console.error("[Monitor] ❌ Lỗi parse message:", err.message);
      }
    },
  });
}

run().catch((err) => {
  console.error("[Monitor] ❌ Khởi động thất bại:", err);
  process.exit(1);
});
