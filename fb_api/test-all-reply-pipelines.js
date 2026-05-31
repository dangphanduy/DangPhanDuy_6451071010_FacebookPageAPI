/**
 * test-all-reply-pipelines.js
 * Script kiểm thử tự động toàn bộ luồng phản hồi:
 *   1. Lệnh hỏi giá (ask_price intent) -> trả lời vui lòng inbox.
 *   2. Cảm xúc tích cực (positive sentiment) -> cảm ơn.
 *   3. Cảm xúc tiêu cực (negative sentiment) -> xin lỗi.
 *   4. Kiểm thử tính Idempotent (gửi 2 lệnh trùng lặp).
 *
 * Chạy lệnh:
 *   node test-all-reply-pipelines.js
 */

const { Kafka } = require("kafkajs");

const BROKER = process.env.KAFKA_BROKER || "localhost:9092";
const RAW_EVENTS_TOPIC = "raw_events";
const REPLY_COMMANDS_TOPIC = "reply_commands";

const kafka = new Kafka({
  clientId: "reply-test-publisher",
  brokers: [BROKER],
});

const producer = kafka.producer();

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRawEvent(commentId, messageText, userName = "Khách Hàng") {
  const payload = {
    entry: [
      {
        changes: [
          {
            field: "feed",
            value: {
              comment_id: commentId,
              post_id: "post_test_999",
              from: { id: `user_${commentId}`, name: userName },
              message: messageText,
            },
          },
        ],
      },
    ],
    receivedAt: new Date().toISOString(),
  };

  await producer.send({
    topic: RAW_EVENTS_TOPIC,
    messages: [{ value: JSON.stringify(payload) }],
  });
  console.log(`[Test] 📣 Đã gửi comment vào raw_events: "${messageText}" (commentId: ${commentId})`);
}

async function sendReplyCommandDirectly(commandId, commentId, replyMessage) {
  const payload = {
    commandId,
    commentId,
    postId: "post_test_999",
    userId: `user_direct_${commentId}`,
    userName: "Khách Hàng Trực Tiếp",
    originalMessage: "Tin nhắn giả lập",
    replyMessage,
    sentiment: "positive",
    intent: "compliment",
    timestamp: new Date().toISOString(),
  };

  await producer.send({
    topic: REPLY_COMMANDS_TOPIC,
    messages: [{ value: JSON.stringify(payload) }],
  });
  console.log(`[Test] 📣 Đã gửi trực tiếp lệnh phản hồi vào reply_commands: commandId=${commandId} | replyMessage="${replyMessage}"`);
}

async function run() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║    TEST PIPELINE AUTO-REPLY — START      ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`Broker : ${BROKER}`);

  try {
    await producer.connect();
    console.log("✅ Kafka Producer connected.");

    // ─── KỊCH BẢN 1: Hỏi Giá (ask_price intent) ──────────────────────────────
    console.log("\n--- Kịch bản 1: Kiểm thử Hỏi Giá ---");
    const commentIdPrice = `comment_price_${Date.now()}`;
    await sendRawEvent(commentIdPrice, "Sản phẩm này giá bao nhiêu vậy shop? Có sale không?", "Nguyễn Văn Giá");

    await delay(3000); // Đợi core-service và Gemini xử lý

    // ─── KỊCH BẢN 2: Cảm Xúc Tích Cực (positive sentiment) ─────────────────────
    console.log("\n--- Kịch bản 2: Kiểm thử Cảm xúc Tích cực ---");
    const commentIdPositive = `comment_pos_${Date.now()}`;
    await sendRawEvent(commentIdPositive, "Dịch vụ ở đây siêu chất lượng, nhân viên hỗ trợ nhiệt tình lắm nha!", "Lê Tích Cực");

    await delay(3000);

    // ─── KỊCH BẢN 3: Cảm Xúc Tiêu Cực (negative sentiment) ─────────────────────
    console.log("\n--- Kịch bản 3: Kiểm thử Cảm xúc Tiêu cực ---");
    const commentIdNegative = `comment_neg_${Date.now()}`;
    await sendRawEvent(commentIdNegative, "Trải nghiệm quá tệ hại, hàng mua về bị vỡ hỏng mà gọi shop không ai nghe máy bực mình ghê!", "Trần Tiêu Cực");

    await delay(3000);

    // ─── KỊCH BẢN 4: Kiểm thử tính Idempotent (Chống trùng lặp) ───────────────
    console.log("\n--- Kịch bản 4: Kiểm thử Tính Idempotent (Chống gửi lặp) ---");
    const sharedCommandId = `cmd_idempotent_${Date.now()}`;
    const sharedCommentId = `comment_idem_${Date.now()}`;
    
    // Gửi lệnh lần thứ nhất
    await sendReplyCommandDirectly(sharedCommandId, sharedCommentId, "Cảm ơn quý khách! Lần 1 thành công.");
    await delay(1500); // Đợi backend-api tiêu thụ và lưu vào SQLite

    // Gửi cùng commandId lần thứ hai (nội dung khác để dễ kiểm chứng)
    await sendReplyCommandDirectly(sharedCommandId, sharedCommentId, "Cảnh báo: Nếu bạn thấy comment này, Idempotency đã THẤT BẠI!");
    
    await delay(2000);

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║   TEST PIPELINE AUTO-REPLY — COMPLETED   ║");
    console.log("╚══════════════════════════════════════════╝");
    console.log("👉 Vui lòng quan sát logs của 'core-service' và 'backend-api' để đối soát kết quả.");

  } catch (err) {
    console.error("❌ Test failed:", err.message);
  } finally {
    await producer.disconnect();
  }
}

run();
