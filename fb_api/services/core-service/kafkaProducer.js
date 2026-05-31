const { Kafka } = require("kafkajs");

const DEFAULT_TOPIC = process.env.MODERATION_TOPIC || "moderation_actions";
const BROKER = process.env.KAFKA_BROKER || "localhost:9092";

const kafka = new Kafka({
  clientId: "core-service-producer",
  brokers: [BROKER],
});

const producer = kafka.producer();
let _connected = false;

async function ensureConnected() {
  if (_connected) return;
  try {
    await producer.connect();
    _connected = true;
    console.log(`[KafkaProducer] ✅ Connected to ${BROKER}`);
  } catch (err) {
    console.error("[KafkaProducer] ❌ Failed to connect producer:", err.message);
    throw err;
  }
}

/**
 * Publish a moderation summary payload to Kafka.
 * @param {object} payload - plain object (will be JSON.stringified)
 * @param {string} [topic] - optional topic override
 */
async function publishModeration(payload, topic = DEFAULT_TOPIC) {
  try {
    await ensureConnected();
    const message = { value: JSON.stringify(payload) };
    await producer.send({ topic, messages: [message] });
    console.log(`[KafkaProducer] 📣 Published moderation event to '${topic}'`);
    return true;
  } catch (err) {
    console.error("[KafkaProducer] ❌ Publish failed:", err.message);
    return false;
  }
}

module.exports = { publishModeration };
