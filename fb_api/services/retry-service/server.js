/**
 * server.js (Retry Service Entry Point)
 * Lắng nghe các sự kiện lỗi từ topic `retry_events`.
 * Thực hiện gọi lại Facebook API với cơ chế Trễ lũy thừa (Exponential Backoff: 1s, 2s, 4s).
 * Nếu quá số lần giới hạn (3 lần), chuyển tiếp sang Dead Letter Queue (dlq_events).
 */


require("dotenv").config();
const { Kafka } = require("kafkajs");
const { hideComment, deleteComment, replyComment } = require("./facebookClient");
const { publishStatusUpdate, publishMessage } = require("./statusPublisher");

const BROKER = process.env.KAFKA_BROKER || "localhost:9092";
const TOPIC = "retry_events";
const DLQ_TOPIC = "dlq_events";
const MAX_RETRIES = 3;

const kafka = new Kafka({
  clientId: "retry-service-consumer",
  brokers: [BROKER],
  retry: { retries: 3 }
});

const consumer = kafka.consumer({ groupId: "retry-service-group" });

async function start() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     RETRY MICROSERVICE — Starting up     ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`[RetryService] Kafka broker : ${BROKER}`);
  console.log(`[RetryService] Topic        : ${TOPIC}`);
  console.log(`[RetryService] DLQ Topic    : ${DLQ_TOPIC}`);

  try {
    // 🛠️ Tự động tạo các topic nếu chưa tồn tại
    try {
      const admin = kafka.admin();
      await admin.connect();
      await admin.createTopics({
        validateOnly: false,
        waitForLeaders: true,
        topics: [
          { topic: TOPIC, numPartitions: 1, replicationFactor: 1 },
          { topic: DLQ_TOPIC, numPartitions: 1, replicationFactor: 1 }
        ],
      });
      await admin.disconnect();
    } catch (err) {
      console.warn("[RetryService] ⚠️ Không thể tạo Kafka topics qua Admin:", err.message);
    }

    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
    
    console.log(`[RetryService] ✅ Đang lắng nghe topic sửa lỗi '${TOPIC}'...\n`);

    await consumer.run({
      eachMessage: async ({ message }) => {
        const rawValue = message.value?.toString();
        if (!rawValue) return;

        let payload;
        try {
          payload = JSON.parse(rawValue);
        } catch {
          console.warn("[RetryService] ⚠️ Tin nhắn không phải JSON hợp lệ, bỏ qua.");
          return;
        }

        const { commentId, action, commentInfo, error, retryCount = 0, timestamp } = payload;
        
        console.log(`\n[RetryService] 📥 Nhận yêu cầu retry: commentId=${commentId} | Action=${action} | Lần thử=${retryCount + 1}`);

        // 1. Tính toán thời gian trễ lũy thừa (1s, 2s, 4s)
        const delayMs = Math.pow(2, retryCount) * 1000;
        const timeElapsed = Date.now() - new Date(timestamp).getTime();
        const waitTime = Math.max(0, delayMs - timeElapsed);

        if (waitTime > 0) {
          console.log(`[RetryService] ⏳ Đang chờ ${waitTime}ms (Exponential Backoff)...`);
          await new Promise(r => setTimeout(r, waitTime));
        }

        // 2. Cập nhật trạng thái sang "processing"
        await publishStatusUpdate(commentId, "processing", {
          action,
          message: `Đang thực hiện lại hành động (lần ${retryCount + 1})`,
          retryCount,
        });

        // 3. Thực thi hành động
        let success = false;
        let execError = "";

        try {
          if (action === "hideComment") {
            success = await hideComment(commentId);
          } else if (action === "deleteComment") {
            success = await deleteComment(commentId);
          } else if (action === "replyComment") {
            success = await replyComment(commentId, payload.replyMessage);
          } else {
            execError = `Hành động không hợp lệ: ${action}`;
          }
        } catch (err) {
          execError = err.message;
        }

        // 4. Kiểm tra kết quả
        if (success) {
          console.log(`[RetryService] 🎉 Retry THÀNH CÔNG cho commentId=${commentId}`);
          
          // Cập nhật trạng thái hoàn tất
          await publishStatusUpdate(commentId, "completed", {
            action,
            message: `Retry thành công ở lần thứ ${retryCount + 1}`,
            attempts: retryCount + 1
          });
        } else {
          console.error(`[RetryService] ❌ Retry THẤT BẠI lần ${retryCount + 1}. Lỗi: ${execError}`);
          const nextRetry = retryCount + 1;

          if (nextRetry >= MAX_RETRIES) {
            // Đã đạt giới hạn tối đa
            console.error(`[RetryService] 🚨 Đạt giới hạn retry tối đa (${MAX_RETRIES}). Chuyển vào DLQ.`);
            
            // Cập nhật trạng thái vĩnh viễn thất bại
            await publishStatusUpdate(commentId, "failed_permanently", {
              action,
              reason: `Vượt quá giới hạn retry (${MAX_RETRIES} lần). Lỗi cuối cùng: ${execError}`,
            });

            // Gửi vào Dead Letter Queue (DLQ)
            const dlqPayload = {
              ...payload,
              finalError: execError,
              failedAt: new Date().toISOString(),
            };
            await publishMessage(dlqPayload, DLQ_TOPIC);
          } else {
            // Còn lượt thử, cập nhật và đẩy lại vào retry topic
            await publishStatusUpdate(commentId, "failed", {
              action,
              error: execError,
              message: `Thử lại thất bại shop ơi, chuẩn bị cho lần thử tiếp theo (${nextRetry + 1})`,
              attempt: nextRetry
            });

            const newRetryPayload = {
              ...payload,
              retryCount: nextRetry,
              error: execError,
              timestamp: new Date().toISOString(),
            };

            await publishMessage(newRetryPayload, TOPIC);
          }
        }
      }
    });

  } catch (err) {
    console.error("[RetryService] ❌ Khởi động dịch vụ thất bại:", err.message);
    process.exit(1);
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  console.log("\n[RetryService] 🛑 Đang tắt Retry Service...");
  await consumer.disconnect();
  console.log("[RetryService] ✅ Kafka consumer đã ngắt kết nối.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
