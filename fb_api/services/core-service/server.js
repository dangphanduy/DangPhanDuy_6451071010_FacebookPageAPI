/**
 * server.js — Core Service Entry Point
 *
 * Kafka Consumer: đọc từ topic `raw_events`, mỗi message là một sự kiện
 * Facebook (comment, like, mention...) được chuẩn hóa bởi Webhook Service.
 *
 * Pipeline xử lý cho mỗi comment:
 *   1. Parse event → trích xuất thông tin comment
 *   2. Lọc trùng lặp sự kiện (Idempotency)
 *   3. Lọc tần suất bình luận (Rate Limiting)
 *   4. spamDetector  → phát hiện spam (mild / repeat / severe)
 *   5. aiAnalyzer    → phân tích intent + sentiment (Gemini)
 *   6. decisionEngine → ra quyết định và thực thi hành động qua Circuit Breaker
 *
 * HTTP Server (port 3002):
 *   GET /health  → kiểm tra service còn sống
 *   GET /status  → thống kê xử lý theo phiên
 *   GET /queue   → danh sách hàng chờ review thủ công
 *   GET /events  → danh sách vết trạng thái sự kiện
 *   GET /metrics → chỉ số đo lường định dạng Prometheus
 */

require("dotenv").config();
process.env.KAFKAJS_NO_PARTITIONER_WARNING = "1";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Kafka } = require("kafkajs");
const { detectSpam } = require("./spamDetector");
const { analyzeComment } = require("./aiAnalyzer");
const { processDecision, addToReviewQueue } = require("./decisionEngine");
const { getAllBlacklisted, unblacklistUser } = require("./blacklistStore");
const { initStatusStore, publishStatusUpdate, getEvent, getRecentEvents } = require("./eventStatusStore");
const { checkRateLimit } = require("./rateLimiter");
const { getNumericState } = require("./circuitBreaker");
const { isDuplicate, markProcessed } = require("./idempotencyStore");
const alertService = require("./alertService");

// ─── Cấu hình ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT) || 3002;
const TOPIC = process.env.KAFKA_TOPIC || "raw_events";
const REVIEW_PATH = path.join(__dirname, "data", "review_queue.json");

// ─── Thống kê phiên (in-memory, reset mỗi lần restart) ───────────────────────

const stats = {
  startedAt: new Date().toISOString(),
  received: 0,   // tổng event Kafka nhận được
  processed: 0,   // xử lý pipeline thành công
  failed: 0,   // lỗi khi xử lý
  hidden: 0,   // số comment đã ẩn
  queued: 0,   // số comment đưa vào hàng chờ
  blacklisted: 0,  // số lần trigger blacklist
};

// ─── Cấu hình Kafka ───────────────────────────────────────────────────────────

const kafka = new Kafka({
  clientId: "core-service",
  brokers: [process.env.KAFKA_BROKER || "localhost:9092"],
  retry: {
    initialRetryTime: 3000,
    retries: 10,
  },
});

const consumer = kafka.consumer({
  groupId: process.env.KAFKA_GROUP_ID || "core-service-group",
  sessionTimeout: 45000,   // 45s — đủ thời gian cho Gemini AI xử lý
  heartbeatInterval: 3000,    // ping Kafka mỗi 3s
  maxWaitTimeInMs: 5000,    // đợi message tối đa 5s mỗi poll
  allowAutoTopicCreation: false,
});

// ─── HTTP Server (port 3002) ──────────────────────────────────────────────────

function readQueue() {
  try { return JSON.parse(fs.readFileSync(REVIEW_PATH, "utf-8")); }
  catch { return []; }
}

const httpServer = http.createServer((req, res) => {
  // GET /metrics (Prometheus standard formatting)
  if (req.method === "GET" && req.url === "/metrics") {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.writeHead(200);

    const cbState = getNumericState(); // 0: CLOSED, 1: OPEN, 2: HALF_OPEN
    const dlqCount = readQueue().filter(e => e.status === "failed_permanently").length;

    let metricsStr = "";
    metricsStr += `# HELP core_service_received_total Total number of events received by Kafka consumer\n`;
    metricsStr += `# TYPE core_service_received_total counter\n`;
    metricsStr += `core_service_received_total ${stats.received}\n\n`;

    metricsStr += `# HELP core_service_processed_total Total number of events processed successfully\n`;
    metricsStr += `# TYPE core_service_processed_total counter\n`;
    metricsStr += `core_service_processed_total ${stats.processed}\n\n`;

    metricsStr += `# HELP core_service_failed_total Total number of events that failed in pipeline\n`;
    metricsStr += `# TYPE core_service_failed_total counter\n`;
    metricsStr += `core_service_failed_total ${stats.failed}\n\n`;

    metricsStr += `# HELP core_service_circuit_breaker_state Current state of Facebook API Circuit Breaker (0=CLOSED, 1=OPEN, 2=HALF_OPEN)\n`;
    metricsStr += `# TYPE core_service_circuit_breaker_state gauge\n`;
    metricsStr += `core_service_circuit_breaker_state ${cbState}\n`;

    return res.end(metricsStr);
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: "ok",
      service: "core-service",
      port: PORT,
      topic: TOPIC,
      uptime: process.uptime().toFixed(1) + "s",
    }, null, 2));
  }

  // GET /status
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200);
    return res.end(JSON.stringify({
      ...stats,
      blacklistedUsers: getAllBlacklisted().length,
      pendingReview: readQueue().filter(e => e.status === "pending").length,
    }, null, 2));
  }

  // GET /queue
  if (req.method === "GET" && req.url === "/queue") {
    const queue = readQueue();
    res.writeHead(200);
    return res.end(JSON.stringify({ total: queue.length, items: queue }, null, 2));
  }

  // GET /events hoặc GET /events/:commentId
  if (req.method === "GET" && req.url.startsWith("/events")) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const parts = parsedUrl.pathname.split("/").filter(Boolean); // ["events", "comment_id"]
    
    if (parts.length === 2) {
      const commentId = parts[1];
      const event = getEvent(commentId);
      if (!event) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: `Không tìm thấy sự kiện với id: ${commentId}` }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify(event, null, 2));
    } else {
      const limit = parseInt(parsedUrl.searchParams.get("limit")) || 100;
      const events = getRecentEvents(limit);
      res.writeHead(200);
      return res.end(JSON.stringify({ total: events.length, items: events }, null, 2));
    }
  }

  // POST /blacklist/unblock?userId=<userId>
  if (req.method === "POST" && req.url.startsWith("/blacklist/unblock")) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const userId = parsedUrl.searchParams.get("userId");
    
    if (!userId) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Thiếu tham số userId trong query. Ví dụ: /blacklist/unblock?userId=12345" }));
    }

    const success = unblacklistUser(userId);
    if (success) {
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, message: `Đã gỡ bỏ blacklist cho userId: ${userId} thành công.` }));
    } else {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: `Không tìm thấy người dùng với userId: ${userId} trong dữ liệu.` }));
    }
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found. Available: /health /status /queue /events /events/:id /metrics /blacklist/unblock?userId=..." }));
});

// ─── Pipeline xử lý một message ──────────────────────────────────────────────

function extractCommentInfo(payload) {
  try {
    const fbBody = payload.payload || payload;
    const entry = fbBody?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (change?.field !== "feed" || !value?.comment_id) return null;

    // Lọc bỏ bình luận do chính Trang (Page) đăng để tránh vòng lặp vô hạn!
    if (value.from?.id && entry?.id && value.from.id === entry.id) {
      console.log(`[Server] ℹ️ Bỏ qua bình luận của chính Trang (Page ID: ${entry.id}) để tránh lặp vô hạn.`);
      return null;
    }

    return {
      commentId: value.comment_id,
      postId: value.post_id || "",
      userId: value.from?.id || "unknown",
      userName: value.from?.name || "unknown",
      message: value.message || "",
      receivedAt: payload.receivedAt || new Date().toISOString(),
    };
  } catch (err) {
    console.error("[Server] Lỗi khi parse event:", err.message);
    return null;
  }
}

async function processMessage(rawValue) {
  stats.received++;
  let event;

  try {
    event = JSON.parse(rawValue);
  } catch {
    console.warn("[Server] ⚠️  Message không phải JSON hợp lệ, bỏ qua.");
    stats.failed++;
    return;
  }

  console.log("\n" + "═".repeat(60));
  console.log(`[Server] 📩 Nhận event lúc ${new Date().toISOString()}`);

  // Bước 1: Trích xuất comment
  const commentInfo = extractCommentInfo(event);
  if (!commentInfo) {
    console.log("[Server] ℹ️  Không phải comment event, bỏ qua.");
    return;
  }

  // ── [A. KIỂM TRA IDEMPOTENCY] ──────────────────────────────────────────────
  if (isDuplicate(commentInfo.commentId)) {
    console.warn(`[Server] [Idempotency] ⚠️  Bỏ qua comment trùng lặp: commentId=${commentInfo.commentId}`);
    return;
  }

  console.log(`[Server] 💬 Comment từ ${commentInfo.userName} (${commentInfo.userId}): "${commentInfo.message}"`);

  // Đánh dấu trạng thái [received]
  await publishStatusUpdate(commentInfo.commentId, "received", {
    userId: commentInfo.userId,
    userName: commentInfo.userName,
    message: commentInfo.message,
    postId: commentInfo.postId,
  });

  // ── [B. KIỂM TRA RATE LIMITING] ─────────────────────────────────────────────
  const eventTimeMs = new Date(commentInfo.receivedAt).getTime();
  if (checkRateLimit(commentInfo.userId, eventTimeMs)) {
    stats.processed++;
    stats.queued++;
    console.warn(`[Server] [RateLimiter] 🚨 Chặn gọi AI/Facebook API cho user=${commentInfo.userId} (Vượt quá 20 comment/phút).`);
    
    // Cập nhật trạng thái thành pending_review
    await publishStatusUpdate(commentInfo.commentId, "pending_review", {
      reason: "rate_limited",
      message: "Bị khóa do gửi bình luận quá nhanh (> 20 comment/phút). Đang chờ xem xét.",
    });

    // Đẩy thẳng vào hàng chờ review
    addToReviewQueue({
      commentId: commentInfo.commentId,
      userId: commentInfo.userId,
      message: commentInfo.message,
      postId: commentInfo.postId,
      reason: "rate_limit_exceeded",
      spamDetails: { count: "20+ in 1 min" },
      aiAnalysis: { intent: "other", sentiment: "neutral" },
      receivedAt: commentInfo.receivedAt,
    });

    // Đánh dấu idempotency là đã xử lý
    markProcessed(commentInfo.commentId);
    return;
  }

  try {
    // Đánh dấu trạng thái [processing]
    await publishStatusUpdate(commentInfo.commentId, "processing", {
      step: "Phân tích Spam & Phân tích AI",
    });

    // Bước 2: Phát hiện spam
    const spamResult = detectSpam(commentInfo.userId, commentInfo.message);
    console.log(`[Server] 🔎 Spam: isSpam=${spamResult.isSpam}, level=${spamResult.level}`);

    // Bước 3: Phân tích AI
    const aiResult = await analyzeComment(commentInfo.message);

    // Bước 4: Ra quyết định
    const decision = await processDecision(commentInfo, spamResult, aiResult);

    // Cập nhật thống kê
    stats.processed++;
    if (decision.hidden) stats.hidden++;
    if (decision.addedToReviewQueue) stats.queued++;
    if (decision.blacklistInfo?.isBlacklisted) stats.blacklisted++;

    // Đánh dấu trạng thái [processed]
    await publishStatusUpdate(commentInfo.commentId, "processed", {
      action: decision.action,
      intent: aiResult.intent,
      sentiment: aiResult.sentiment,
      isSpam: spamResult.isSpam,
      spamLevel: spamResult.level,
      addedToReviewQueue: decision.addedToReviewQueue,
    });

    // Nếu không ẩn bình luận, đánh dấu [completed] luôn vì attemptHideComment trong decisionEngine không chạy
    if (decision.action === "none") {
      await publishStatusUpdate(commentInfo.commentId, "completed", {
        action: "none",
        message: "Bình luận bình thường, không cần ẩn",
      });
    }

    // Đánh dấu idempotency thành công
    markProcessed(commentInfo.commentId);

    console.log(`\n[Server] 📊 Kết quả:`);
    console.log(`  commentId    : ${commentInfo.commentId}`);
    console.log(`  intent       : ${aiResult.intent}`);
    console.log(`  sentiment    : ${aiResult.sentiment}`);
    console.log(`  spamLevel    : ${spamResult.level}`);
    console.log(`  action       : ${decision.action}`);
    console.log(`  hidden       : ${decision.hidden}`);
    console.log(`  reviewQueue  : ${decision.addedToReviewQueue}`);
    console.log(`  adminWarning : ${decision.adminWarning}`);
    console.log("═".repeat(60));

  } catch (err) {
    stats.failed++;
    console.error("[Server] ❌ Lỗi pipeline:", err.message);

    // Đánh dấu trạng thái [failed]
    await publishStatusUpdate(commentInfo.commentId, "failed", {
      error: err.message,
    });
  }
}

// ─── Kafka Consumer Loop ──────────────────────────────────────────────────────

async function start() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║       CORE SERVICE — Starting up         ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`[Server] HTTP port    : ${PORT}`);
  console.log(`[Server] Kafka broker : ${process.env.KAFKA_BROKER || "localhost:9092"}`);
  console.log(`[Server] Topic        : ${TOPIC}`);
  console.log(`[Server] Group ID     : ${process.env.KAFKA_GROUP_ID || "core-service-group"}`);

  // Tạo thư mục data/ nếu chưa có
  const dataDir = path.join(__dirname, "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log("[Server] 📁 Đã tạo thư mục data/");
  }

  // Tạo các topic cần thiết bằng Admin Client để tránh lỗi 'This server does not host this topic-partition'
  try {
    const admin = kafka.admin();
    await admin.connect();
    console.log("[Server] 🛠️  Đang tự động khởi tạo các Kafka topics...");
    await admin.createTopics({
      validateOnly: false,
      waitForLeaders: true,
      topics: [
        { topic: TOPIC, numPartitions: 1, replicationFactor: 1 }, // raw_events
        { topic: "reply_commands", numPartitions: 1, replicationFactor: 1 },
        { topic: "event_statuses", numPartitions: 1, replicationFactor: 1 },
        { topic: "retry_events", numPartitions: 1, replicationFactor: 1 },
        { topic: "dlq_events", numPartitions: 1, replicationFactor: 1 },
      ],
    });
    await admin.disconnect();
    console.log("[Server] ✅ Khởi tạo Kafka topics hoàn tất.");
  } catch (err) {
    console.warn("[Server] ⚠️  Không thể tự động tạo Kafka topics qua Admin:", err.message);
  }

  // Khởi động bộ đồng bộ trạng thái
  await initStatusStore(process.env.KAFKA_BROKER || "localhost:9092");

  // Khởi động dịch vụ Alert cảnh báo DLQ chạy nền
  await alertService.start();

  // Xử lý lỗi port đã bị chiếm
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n[Server] ❌ Port ${PORT} đang bị chiếm bởi tiến trình khác.`);
      console.error(`[Server]    Chạy lệnh sau để giải phóng rồi thử lại:`);
      console.error(`[Server]    Windows: netstat -ano | findstr :${PORT}  →  taskkill /PID <pid> /F`);
      process.exit(1);
    } else {
      console.error("[Server] ❌ HTTP server lỗi:", err.message);
    }
  });

  // Khởi động HTTP server
  httpServer.listen(PORT, () => {
    console.log(`[Server] ✅ HTTP server đang chạy tại http://localhost:${PORT}`);
    console.log(`[Server]    → http://localhost:${PORT}/health`);
    console.log(`[Server]    → http://localhost:${PORT}/status`);
    console.log(`[Server]    → http://localhost:${PORT}/queue`);
    console.log(`[Server]    → http://localhost:${PORT}/events`);
    console.log(`[Server]    → http://localhost:${PORT}/metrics`);
  });

  // Khởi động Kafka consumer
  await consumer.connect();
  console.log("[Server] ✅ Kafka consumer đã kết nối.");

  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  console.log(`[Server] ✅ Đang lắng nghe topic: ${TOPIC}`);

  await consumer.run({
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      console.log(`\n[Server] 📥 Nhận batch Kafka: size=${batch.messages.length} messages`);
      
      const concurrencyLimit = 5;
      const messages = batch.messages;

      // Xử lý song song từng cụm tối đa 5 tin
      for (let i = 0; i < messages.length; i += concurrencyLimit) {
        if (!isRunning() || isStale()) break;

        const slice = messages.slice(i, i + concurrencyLimit);
        
        await Promise.all(slice.map(async (message) => {
          const rawValue = message.value?.toString();
          if (!rawValue) return;

          try {
            await processMessage(rawValue);
            // Checkpoint offset sau khi xử lý thành công tin nhắn này
            resolveOffset(message.offset);
          } catch (err) {
            console.error("[Server] ❌ Lỗi xử lý message trong batch:", err.message);
          }
        }));

        // Gửi heartbeat định kỳ sau mỗi cụm xử lý
        await heartbeat();
      }
    }
  });
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  console.log("\n[Server] 🛑 Đang tắt Core Service...");
  await consumer.disconnect();
  console.log("[Server] ✅ Kafka consumer đã ngắt kết nối.");
  await alertService.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Start ────────────────────────────────────────────────────────────────────
start().catch((err) => {
  console.error("[Server] ❌ Khởi động thất bại:", err);
  process.exit(1);
});
