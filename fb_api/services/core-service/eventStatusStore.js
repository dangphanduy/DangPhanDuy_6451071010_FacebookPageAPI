/**
 * eventStatusStore.js
 * Quản lý trạng thái sự kiện (Event Status) bằng Event Sourcing qua Kafka.
 * 
 * Toàn bộ thay đổi trạng thái sẽ được ghi vào topic `event_statuses`.
 * Hệ thống sẽ tái dựng (replay) toàn bộ topic này vào Map in-memory khi khởi động
 * để phục vụ API HTTP truy vấn cực kỳ nhanh.
 */

const { publishModeration } = require("./kafkaProducer");

const TOPIC = "event_statuses";
const eventsMap = new Map();
let _initialized = false;

/**
 * Gửi một cập nhật trạng thái mới lên Kafka.
 * @param {string} commentId 
 * @param {"received" | "processing" | "processed" | "completed" | "failed" | "failed_permanently"} status 
 * @param {object} [details] 
 */
async function publishStatusUpdate(commentId, status, details = {}) {
  const payload = {
    commentId,
    status,
    timestamp: new Date().toISOString(),
    details,
  };

  console.log(`[EventStatusStore] 📣 Cập nhật trạng thái: commentId=${commentId} ➔ [${status}]`);
  
  // Publish lên Kafka
  await publishModeration(payload, TOPIC);
}

/**
 * Áp dụng một sự kiện trạng thái vào Map cục bộ (Materialized View).
 */
function applyStatusEvent(event) {
  const { commentId, status, timestamp, details } = event;
  if (!commentId) return;

  if (!eventsMap.has(commentId)) {
    eventsMap.set(commentId, {
      commentId,
      status: "received",
      history: [],
      metadata: {},
    });
  }

  const record = eventsMap.get(commentId);
  record.status = status;
  
  // Tránh lặp lịch sử nếu có tin nhắn lặp từ Kafka
  const isDuplicate = record.history.some(h => h.status === status && h.timestamp === timestamp);
  if (!isDuplicate) {
    record.history.push({ status, timestamp, details });
  }

  if (details && Object.keys(details).length > 0) {
    record.metadata = { ...record.metadata, ...details };
  }
}

/**
 * Khởi tạo bộ đồng bộ trạng thái: đọc từ đầu topic `event_statuses`.
 */
async function initStatusStore(kafkaBroker) {
  if (_initialized) return;

  const { Kafka } = require("kafkajs");
  const broker = kafkaBroker || process.env.KAFKA_BROKER || "localhost:9092";

  const kafka = new Kafka({
    clientId: "status-aggregator",
    brokers: [broker],
    retry: { retries: 3 }
  });

  // Sử dụng group ID duy nhất để đảm bảo mỗi lần restart đều replay từ offset 0
  const groupId = `status-aggregator-group-${Date.now()}`;
  const consumer = kafka.consumer({ groupId });

  try {
    await consumer.connect();
    // Đăng ký nhận tin nhắn từ đầu topic
    await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    
    console.log(`[EventStatusStore] 🔄 Khởi động bộ tái dựng trạng thái từ topic '${TOPIC}'...`);

    // Chạy consumer nền để cập nhật Map bất đồng bộ
    consumer.run({
      eachMessage: async ({ message }) => {
        try {
          const rawValue = message.value?.toString();
          if (!rawValue) return;
          const event = JSON.parse(rawValue);
          applyStatusEvent(event);
        } catch (err) {
          console.error("[EventStatusStore] ❌ Lỗi xử lý status event:", err.message);
        }
      },
    }).catch(err => {
      console.error("[EventStatusStore] ❌ Lỗi consumer chạy nền:", err.message);
    });

    _initialized = true;
    console.log("[EventStatusStore] ✅ Bộ tái dựng trạng thái đã chạy nền.");
  } catch (err) {
    console.error("[EventStatusStore] ❌ Khởi tạo thất bại:", err.message);
  }
}

/**
 * Lấy chi tiết một sự kiện theo commentId.
 */
function getEvent(commentId) {
  return eventsMap.get(commentId) || null;
}

/**
 * Lấy danh sách các sự kiện gần nhất (mới nhất lên đầu).
 */
function getRecentEvents(limit = 100) {
  const list = Array.from(eventsMap.values());
  list.sort((a, b) => {
    const aTime = a.history[a.history.length - 1]?.timestamp || "";
    const bTime = b.history[b.history.length - 1]?.timestamp || "";
    return bTime.localeCompare(aTime);
  });
  return list.slice(0, limit);
}

module.exports = {
  publishStatusUpdate,
  initStatusStore,
  getEvent,
  getRecentEvents,
};
