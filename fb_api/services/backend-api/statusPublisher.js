/**
 * statusPublisher.js (Backend API)
 * Quản lý gửi tin nhắn trạng thái lên `event_statuses`
 * và đẩy yêu cầu lỗi lên `retry_events`.
 */

const { Kafka } = require("kafkajs");

const BROKER = process.env.KAFKA_BROKER || "localhost:9092";

const kafka = new Kafka({
  clientId: "backend-api-producer",
  brokers: [BROKER],
});

const producer = kafka.producer();
let _connected = false;

async function ensureConnected() {
  if (_connected) return;
  try {
    await producer.connect();
    _connected = true;
    console.log(`[StatusPublisher] ✅ Connected to Kafka broker: ${BROKER}`);
  } catch (err) {
    console.error("[StatusPublisher] ❌ Failed to connect producer:", err.message);
    throw err;
  }
}

/**
 * Gửi tin nhắn lên Kafka topic bất kỳ.
 */
async function publishMessage(payload, topic) {
  try {
    await ensureConnected();
    const message = { value: JSON.stringify(payload) };
    await producer.send({ topic, messages: [message] });
    console.log(`[StatusPublisher] 📣 Published event to '${topic}'`);
    return true;
  } catch (err) {
    console.error(`[StatusPublisher] ❌ Publish to '${topic}' failed:`, err.message);
    return false;
  }
}

/**
 * Gửi cập nhật trạng thái lên topic event_statuses.
 */
async function publishStatusUpdate(commentId, status, details = {}) {
  const payload = {
    commentId,
    status,
    timestamp: new Date().toISOString(),
    details,
  };
  await publishMessage(payload, "event_statuses");
}

module.exports = {
  publishMessage,
  publishStatusUpdate,
};
