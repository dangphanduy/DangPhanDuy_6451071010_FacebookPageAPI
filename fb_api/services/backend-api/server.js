/**
 * server.js (Backend API Service Entry Point)
 *
 * Kafka Consumer: đọc từ topic `reply_commands`, mỗi message là một lệnh phản hồi.
 *
 * Luồng xử lý cho mỗi command:
 *   1. Lọc trùng lặp bằng SQLite Database (Idempotent Consumer).
 *   2. Đánh dấu trạng thái 'processing'.
 *   3. Kiểm tra và thực thi qua Circuit Breaker.
 *   4. Gọi Facebook Graph API để gửi phản hồi bình luận (comment reply).
 *   5. Nếu thành công -> chuyển trạng thái 'completed'.
 *   6. Nếu thất bại (hoặc mạch đang OPEN) -> chuyển trạng thái 'failed' và đẩy sang `retry_events` để retry lũy thừa.
 *
 * HTTP Server (port 3004):
 *   GET /health  → kiểm tra trạng thái hoạt động
 *   GET /status  → thống kê xử lý và trạng thái Circuit Breaker
 *   GET /metrics → chỉ số Prometheus format
 */

require("dotenv").config();
process.env.KAFKAJS_NO_PARTITIONER_WARNING = "1";

const http = require("http");
const { Kafka } = require("kafkajs");
const { initDb, checkAndRegisterCommand, updateCommandStatus, getAllCommands } = require("./idempotencyDb");
const { executeWithBreaker, getBreakerState, getNumericState } = require("./circuitBreaker");
const { replyComment } = require("./facebookClient");
const { publishMessage, publishStatusUpdate } = require("./statusPublisher");

// ─── Cấu hình ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3004;
const TOPIC = process.env.KAFKA_TOPIC_REPLY || "reply_commands";

// ─── Thống kê ─────────────────────────────────────────────────────────────────
const stats = {
  startedAt: new Date().toISOString(),
  received: 0,
  success: 0,
  failed: 0,
  ignored: 0,
};

// ─── Cấu hình Kafka ───────────────────────────────────────────────────────────
const kafka = new Kafka({
  clientId: "backend-api",
  brokers: [process.env.KAFKA_BROKER || "localhost:9092"],
  retry: {
    initialRetryTime: 3000,
    retries: 10,
  },
});

const consumer = kafka.consumer({
  groupId: "backend-api-group",
  allowAutoTopicCreation: false,
});

// ─── HTTP Server (port 3004) ──────────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // GET /metrics
  if (req.method === "GET" && req.url === "/metrics") {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.writeHead(200);

    const cbState = getNumericState(); // 0: CLOSED, 1: OPEN, 2: HALF_OPEN
    let metricsStr = "";
    
    metricsStr += `# HELP backend_api_received_total Total number of reply commands received\n`;
    metricsStr += `# TYPE backend_api_received_total counter\n`;
    metricsStr += `backend_api_received_total ${stats.received}\n\n`;

    metricsStr += `# HELP backend_api_success_total Total number of replies successfully sent to Facebook\n`;
    metricsStr += `# TYPE backend_api_success_total counter\n`;
    metricsStr += `backend_api_success_total ${stats.success}\n\n`;

    metricsStr += `# HELP backend_api_failed_total Total number of replies that failed (sent to retry queue)\n`;
    metricsStr += `# TYPE backend_api_failed_total counter\n`;
    metricsStr += `backend_api_failed_total ${stats.failed}\n\n`;

    metricsStr += `# HELP backend_api_ignored_total Total number of duplicate reply commands ignored\n`;
    metricsStr += `# TYPE backend_api_ignored_total counter\n`;
    metricsStr += `backend_api_ignored_total ${stats.ignored}\n\n`;

    metricsStr += `# HELP backend_api_circuit_breaker_state Current state of Facebook Reply Circuit Breaker (0=CLOSED, 1=OPEN, 2=HALF_OPEN)\n`;
    metricsStr += `# TYPE backend_api_circuit_breaker_state gauge\n`;
    metricsStr += `backend_api_circuit_breaker_state ${cbState}\n`;

    return res.end(metricsStr);
  }

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: "ok",
      service: "backend-api",
      port: PORT,
      topic: TOPIC,
      uptime: process.uptime().toFixed(1) + "s",
    }, null, 2));
  }

  // GET /status
  if (req.method === "GET" && req.url === "/status") {
    let dbItemsCount = 0;
    try {
      const items = await getAllCommands(1000);
      dbItemsCount = items.length;
    } catch (err) {
      console.error("[Server] Lỗi đọc DB:", err.message);
    }

    res.writeHead(200);
    return res.end(JSON.stringify({
      ...stats,
      breakerState: getBreakerState(),
      breakerNumericState: getNumericState(),
      idempotencyDbRecords: dbItemsCount,
    }, null, 2));
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found. Available: /health /status /metrics" }));
});

// ─── Pipeline xử lý một message ──────────────────────────────────────────────
async function processCommand(rawValue) {
  stats.received++;
  let command;

  try {
    command = JSON.parse(rawValue);
  } catch {
    console.warn("[Server] ⚠️ Message không phải JSON hợp lệ, bỏ qua.");
    stats.ignored++;
    return;
  }

  const { commandId, commentId, postId, userId, userName, originalMessage, replyMessage, timestamp } = command;

  if (!commandId || !commentId || !replyMessage) {
    console.warn("[Server] ⚠️  Message thiếu thông tin bắt buộc, bỏ qua.");
    stats.ignored++;
    return;
  }

  console.log("\n" + "═".repeat(60));
  console.log(`[Server] 📩 Nhận được lệnh phản hồi lúc ${new Date().toISOString()}`);
  console.log(`  └─ Command ID : ${commandId}`);
  console.log(`  └─ Comment ID : ${commentId}`);
  console.log(`  └─ Gửi tới    : ${userName} (${userId})`);
  console.log(`  └─ Nội dung   : "${replyMessage}"`);

  // ── [A. KIỂM TRA TÍNH IDEMPOTENT] ───────────────────────────────────────────
  const isUnique = await checkAndRegisterCommand(commandId, commentId, replyMessage);
  
  if (!isUnique) {
    console.warn(`[Server] [Idempotency] ⚠️  Bỏ qua lệnh phản hồi TRÙNG LẶP: commandId=${commandId}`);
    stats.ignored++;
    return;
  }

  console.log(`[Server] [Idempotency] ✅ Lệnh phản hồi là duy nhất. Đang tiến hành xử lý...`);

  // Cập nhật trạng thái sự kiện sang "processing"
  await publishStatusUpdate(commentId, "processing", {
    commandId,
    replyMessage,
    message: "Đang gọi Facebook API để phản hồi bình luận...",
  });

  // ── [B. THỰC THI QUA CIRCUIT BREAKER] ────────────────────────────────────────
  let success = false;
  let errorMsg = "";

  try {
    success = await executeWithBreaker(async () => {
      return await replyComment(commentId, replyMessage);
    });
  } catch (err) {
    errorMsg = err.message;
    console.error(`[Server] [CircuitBreaker] ❌ Lỗi khi thực thi phản hồi:`, errorMsg);
  }

  if (success) {
    // ── [C1. PHẢN HỒI THÀNH CÔNG] ─────────────────────────────────────────────
    console.log(`[Server] 🎉 Phản hồi thành công cho comment: ${commentId}`);
    stats.success++;

    // Cập nhật SQLite sang "completed"
    await updateCommandStatus(commandId, "completed");

    // Phát trạng thái hoàn thành "completed"
    await publishStatusUpdate(commentId, "completed", {
      action: "reply_comment_completed",
      message: `Đã tự động trả lời bình luận thành công: "${replyMessage}"`,
      replyMessage,
      commandId,
    });
  } else {
    // ── [C2. PHẢN HỒI THẤT BẠI - BẮN RETRY] ────────────────────────────────────
    const finalError = errorMsg || "Facebook API Call Failed";
    console.error(`[Server] ❌ Phản hồi thất bại: ${finalError}. Chuẩn bị đẩy sang Retry Service.`);
    stats.failed++;

    // Cập nhật SQLite sang "failed"
    await updateCommandStatus(commandId, "failed", finalError);

    // Cập nhật trạng thái lỗi tạm thời "failed"
    await publishStatusUpdate(commentId, "failed", {
      action: "reply_comment_failed",
      error: `${finalError}. Đang gửi yêu cầu sang Retry Microservice...`,
    });

    // Gửi event lỗi tới topic "retry_events" qua Kafka Producer để Retry lũy thừa
    const retryPayload = {
      commentId,
      action: "replyComment", // Action tương ứng trong retry-service
      replyMessage,
      commentInfo: {
        commentId,
        postId: postId || "",
        userId: userId || "unknown",
        userName: userName || "unknown",
        message: originalMessage || "",
      },
      error: finalError,
      retryCount: 0,
      maxRetries: 3,
      timestamp: new Date().toISOString(),
    };

    await publishMessage(retryPayload, "retry_events");
  }
  
  console.log("═".repeat(60));
}

// ─── Start up ─────────────────────────────────────────────────────────────────
async function start() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║       BACKEND-API SERVICE — Startup      ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`[Server] HTTP port    : ${PORT}`);
  console.log(`[Server] Kafka broker : ${process.env.KAFKA_BROKER || "localhost:9092"}`);
  console.log(`[Server] Topic        : ${TOPIC}`);

  // 1. Khởi tạo SQLite DB
  try {
    await initDb();
  } catch (err) {
    console.error("[Server] ❌ Khởi tạo Database SQLite thất bại:", err.message);
    process.exit(1);
  }

  // 2. Đăng ký Admin tạo topic tự động
  try {
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      validateOnly: false,
      waitForLeaders: true,
      topics: [{ topic: TOPIC, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();
    console.log(`[Server] ✅ Đã đảm bảo Kafka topic '${TOPIC}' tồn tại.`);
  } catch (err) {
    console.warn(`[Server] ⚠️ Cảnh báo tự tạo topic qua Admin:`, err.message);
  }

  // 3. Khởi động HTTP Server
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n[Server] ❌ Port ${PORT} đang bị chiếm bởi tiến trình khác.`);
      console.error(`[Server]    Taskkill hoặc giải phóng port để khởi chạy.`);
      process.exit(1);
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`[Server] ✅ HTTP server đang chạy tại http://localhost:${PORT}`);
    console.log(`[Server]    → http://localhost:${PORT}/health`);
    console.log(`[Server]    → http://localhost:${PORT}/status`);
    console.log(`[Server]    → http://localhost:${PORT}/metrics`);
  });

  // 4. Khởi động Kafka Consumer
  try {
    await consumer.connect();
    console.log("[Server] ✅ Kafka consumer đã kết nối thành công.");

    await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
    console.log(`[Server] ✅ Đang lắng nghe topic: ${TOPIC}`);

    await consumer.run({
      eachMessage: async ({ message }) => {
        const rawValue = message.value?.toString();
        if (rawValue) {
          try {
            await processCommand(rawValue);
          } catch (err) {
            console.error("[Server] ❌ Lỗi ngoài mong muốn trong pipeline xử lý lệnh:", err.message);
          }
        }
      },
    });
  } catch (err) {
    console.error("[Server] ❌ Khởi động Kafka Consumer thất bại:", err.message);
    process.exit(1);
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  console.log("\n[Server] 🛑 Đang tắt Backend-API Service...");
  try {
    await consumer.disconnect();
    console.log("[Server] ✅ Kafka consumer đã ngắt kết nối.");
  } catch (err) {
    console.error("[Server] Lỗi khi ngắt kết nối Kafka consumer:", err.message);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Khởi chạy ────────────────────────────────────────────────────────────────
start().catch((err) => {
  console.error("[Server] ❌ Khởi động thất bại vĩnh viễn:", err);
  process.exit(1);
});
