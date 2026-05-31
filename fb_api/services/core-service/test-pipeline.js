/**
 * test-pipeline.js
 * Script test thủ công: Giả lập một Facebook webhook event và đẩy vào Kafka
 * để kiểm tra toàn bộ pipeline Core Service mà KHÔNG cần Facebook thật.
 *
 * Cách chạy:
 *   cd fb_api/services/core-service
 *   node test-pipeline.js [scenario]
 *
 * Các scenario:
 *   node test-pipeline.js normal      → bình luận bình thường
 *   node test-pipeline.js link        → bình luận chứa link (spam mild)
 *   node test-pipeline.js harmful     → bình luận scam (spam severe)
 *   node test-pipeline.js repeat      → gửi 3 lần cùng nội dung (spam repeat)
 *   node test-pipeline.js complaint   → khiếu nại (AI: intent=complaint)
 *   node test-pipeline.js askprice    → hỏi giá (AI: intent=ask_price)
 */

require("dotenv").config();
process.env.KAFKAJS_NO_PARTITIONER_WARNING = "1"; // Tắt warning partitioner

const { Kafka, Partitioners } = require("kafkajs");

const kafka = new Kafka({
  clientId: "test-producer",
  brokers: [process.env.KAFKA_BROKER || "localhost:9092"],
  connectionTimeout: 5000,
  requestTimeout: 10000,
  retry: { retries: 3 },
});

const producer = kafka.producer({
  createPartitioner: Partitioners.LegacyPartitioner,
});
const TOPIC = process.env.KAFKA_TOPIC || "raw_events";

// ─── Tạo fake Facebook webhook event ─────────────────────────────────────────

function makeFakeEvent(userId, commentId, message) {
  return {
    source: "facebook",
    eventType: "raw_event",
    receivedAt: new Date().toISOString(),
    payload: {
      object: "page",
      entry: [
        {
          id: "PAGE_ID_123",
          time: Date.now(),
          changes: [
            {
              field: "feed",
              value: {
                comment_id: commentId,
                post_id: "PAGE_ID_123_POST_456",
                message: message,
                from: {
                  id: userId,
                  name: `TestUser_${userId}`,
                },
                created_time: Math.floor(Date.now() / 1000),
              },
            },
          ],
        },
      ],
    },
  };
}

// ─── Các scenario test ────────────────────────────────────────────────────────

const scenarios = {
  normal: {
    desc: "✅ Bình luận bình thường",
    events: [
      {
        userId: "user_001",
        commentId: "comment_001",
        message: "Sản phẩm của shop rất tốt, mình rất hài lòng!",
      },
    ],
  },
  link: {
    desc: "⚠️  Bình luận chứa link (SPAM MILD → sẽ bị ẩn)",
    events: [
      {
        userId: "user_002",
        commentId: "comment_002",
        message: "Mua hàng giá rẻ tại đây nhé: http://cheapshop.vn/sale",
      },
    ],
  },
  harmful: {
    desc: "🚨 Bình luận scam (SPAM SEVERE → ẩn + vào hàng chờ review)",
    events: [
      {
        userId: "user_003",
        commentId: "comment_003",
        message: "Kiếm tiền nhanh 5 triệu/ngày tại nhà, inbox mình ngay!",
      },
    ],
  },
  repeat: {
    desc: "🔁 Lặp nội dung 3 lần (SPAM REPEAT → ẩn + blacklist)",
    events: [
      {
        userId: "user_004",
        commentId: "comment_004a",
        message: "Shop có bán áo size XL không?",
      },
      {
        userId: "user_004",
        commentId: "comment_004b",
        message: "Shop có bán áo size XL không?",
      },
      {
        userId: "user_004",
        commentId: "comment_004c",
        message: "Shop có bán áo size XL không?",
      },
    ],
    delay: 500, // ms giữa các message
  },
  complaint: {
    desc: "😠 Khiếu nại (AI: intent=complaint, sentiment=negative)",
    events: [
      {
        userId: "user_005",
        commentId: "comment_005",
        message:
          "Mình chưa nhận được hàng mà đặt đã 2 tuần rồi, shop phản hồi đi!",
      },
    ],
  },
  askprice: {
    desc: "💬 Hỏi giá (AI: intent=ask_price, sentiment=neutral)",
    events: [
      {
        userId: "user_006",
        commentId: "comment_006",
        message: "Shop ơi áo này giá bao nhiêu vậy?",
      },
    ],
  },
  compliment: {
    desc: "😊 Khen ngợi (AI: intent=compliment, sentiment=positive)",
    events: [
      {
        userId: "user_007",
        commentId: "comment_007",
        message: "Bài viết hay quá, cảm ơn shop đã chia sẻ!",
      },
    ],
  },
  spike: {
    desc: "⚡ Tải đột biến (15 comment gửi đồng loạt để kiểm tra Concurrency = 5 & Heartbeat)",
    events: Array.from({ length: 15 }, (_, i) => ({
      userId: `user_spike_${i + 1}`,
      commentId: `comment_spike_${i + 1}_${Date.now()}`,
      message: `Bình luận đột biến số ${i + 1} của bài viết viral!`,
    })),
  },
  failretry: {
    desc: "🚨 Giả lập lỗi Facebook API để kiểm tra Retry (Exponential Backoff) & DLQ",
    events: [
      {
        userId: "user_failretry",
        commentId: `comment_failretry_${Date.now()}`,
        message: "Chào bạn, hãy click vào link này để mua hàng giảm giá nhé: http://scam-site.com/gift",
      },
    ],
  },
  ratelimit: {
    desc: "🚨 Test Rate Limiting (Gửi 25 bình luận liên tiếp từ 1 user trong vài giây)",
    events: Array.from({ length: 25 }, (_, i) => ({
      userId: "user_spammer_ratelimit",
      commentId: `comment_ratelimit_${i + 1}_${Date.now()}`,
      message: `Bình luận nhanh số ${i + 1} của kẻ spam!`,
    })),
  },
  idempotent: {
    desc: "🔒 Test Idempotency (Gửi 2 bình luận có cùng một commentId)",
    events: [
      {
        userId: "user_idempotent_test",
        commentId: "comment_idempotent_fixed_key_123",
        message: "Tin nhắn gửi lần thứ nhất.",
      },
      {
        userId: "user_idempotent_test",
        commentId: "comment_idempotent_fixed_key_123",
        message: "Tin nhắn gửi lần thứ hai trùng lặp ID.",
      },
    ],
  },
  circuitbreaker: {
    desc: "🔌 Test Circuit Breaker (Gửi 12 bình luận spam, do token lỗi nên 10 tin đầu bẻ mạch sang OPEN, tin 11 & 12 bị fail-fast lập tức)",
    events: Array.from({ length: 12 }, (_, i) => ({
      userId: `user_circuit_${i + 1}`,
      commentId: `comment_circuit_${i + 1}_${Date.now()}`,
      message: `Quảng cáo siêu giảm giá! Click ngay http://spam-link-${i + 1}.com`,
    })),
  },
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const scenarioName = process.argv[2] || "normal";
  const scenario = scenarios[scenarioName];

  if (!scenario) {
    console.error(`❌ Không tìm thấy scenario "${scenarioName}"`);
    console.log("Các scenario hợp lệ:", Object.keys(scenarios).join(", "));
    process.exit(1);
  }

  console.log("╔══════════════════════════════════════════╗");
  console.log("║         CORE SERVICE TEST PRODUCER       ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`Scenario  : ${scenarioName}`);
  console.log(`Mô tả     : ${scenario.desc}`);
  console.log(`Broker    : ${process.env.KAFKA_BROKER || "localhost:9092"}`);
  console.log(`Topic     : ${TOPIC}`);
  console.log(`Events    : ${scenario.events.length} message(s)`);
  console.log("─".repeat(50));

  await producer.connect();
  console.log("✅ Kafka producer đã kết nối\n");

  for (let i = 0; i < scenario.events.length; i++) {
    const { userId, commentId, message } = scenario.events[i];
    const event = makeFakeEvent(userId, commentId, message);

    await producer.send({
      topic: TOPIC,
      messages: [{ value: JSON.stringify(event) }],
    });

    console.log(
      `📤 Đã gửi message ${i + 1}/${scenario.events.length}:`
    );
    console.log(`   userId    : ${userId}`);
    console.log(`   commentId : ${commentId}`);
    console.log(`   message   : "${message}"`);
    console.log();

    // Delay giữa các message nếu cần
    if (scenario.delay && i < scenario.events.length - 1) {
      await new Promise((r) => setTimeout(r, scenario.delay));
    }
  }

  console.log("─".repeat(50));
  console.log("✅ Đã gửi xong. Xem kết quả trong cửa sổ chạy core-service.");
  console.log("💡 Sau khi xử lý, kiểm tra:");
  console.log("   - core-service/data/blacklist.json");
  console.log("   - core-service/data/review_queue.json");

  await producer.disconnect();
}

run().catch((err) => {
  console.error("❌ Lỗi:", err.message);
  process.exit(1);
});
