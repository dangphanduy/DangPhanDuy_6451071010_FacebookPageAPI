/**
 * decisionEngine.js
 * Ra quyết định tự động dựa trên kết quả từ spamDetector + aiAnalyzer.
 *
 * Bảng quyết định:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Tình huống                     │ Hành động                    │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  Spam mild (chứa link)          │ Ẩn bình luận ngay            │
 * │  Spam repeat (lặp ≥3 lần/24h)  │ Ẩn + thêm vào blacklist      │
 * │  Spam severe (link độc / scam)  │ Ẩn + đẩy vào hàng chờ       │
 * │  Trong blacklist                │ Ẩn, không gửi auto-reply     │
 * │  Tái phạm nhiều (≥5 lần total) │ Cảnh báo admin               │
 * │  Bình thường                    │ Chỉ log phân tích AI         │
 * └─────────────────────────────────────────────────────────────────┘
 */

const fs = require("fs");
const path = require("path");
const { hideComment } = require("./facebookClient");
const { recordViolation, isBlacklisted } = require("./blacklistStore");
const { publishModeration } = require("./kafkaProducer");
const { publishStatusUpdate } = require("./eventStatusStore");
const { executeWithBreaker } = require("./circuitBreaker");

const REVIEW_QUEUE_PATH = path.join(__dirname, "data", "review_queue.json");

// Helper: Ẩn comment kèm theo cập nhật trạng thái sự kiện và kích hoạt retry nếu lỗi
async function attemptHideComment(commentInfo, actionName, reasonName) {
  const { commentId } = commentInfo;
  
  await publishStatusUpdate(commentId, "processing", {
    action: actionName,
    message: `Đang thực hiện ẩn bình luận trên Facebook (Hành động: ${actionName})`
  });

  let hidden = false;
  let errorMsg = "Không thể gọi Facebook API hoặc Request bị Timeout.";
  try {
    // Thực thi thông qua Circuit Breaker
    hidden = await executeWithBreaker(async () => {
      return await hideComment(commentId);
    });
  } catch (err) {
    errorMsg = err.message;
    console.error(`[DecisionEngine] ❌ Lỗi Circuit Breaker hoặc API khi ẩn comment ${commentId}:`, errorMsg);
  }

  if (hidden) {
    await publishStatusUpdate(commentId, "completed", {
      action: actionName,
      message: `Đã ẩn bình luận thành công trên Facebook (Lý do: ${reasonName})`
    });
  } else {
    // Đánh dấu trạng thái là failed
    await publishStatusUpdate(commentId, "failed", {
      action: actionName,
      error: `${errorMsg} Đang kích hoạt Retry Service...`,
    });

    // Kích hoạt Retry Service bằng cách gửi event vào topic `retry_events`
    const retryPayload = {
      commentId,
      action: "hideComment", // Tên hàm cần gọi trong facebookClient
      commentInfo,
      error: "Facebook API Call Failed or Request Timed Out",
      retryCount: 0,
      maxRetries: 3,
      timestamp: new Date().toISOString(),
    };
    
    await publishModeration(retryPayload, "retry_events");
  }

  return hidden;
}

// ─── Review Queue ─────────────────────────────────────────────────────────────

function readReviewQueue() {
  try {
    const raw = fs.readFileSync(REVIEW_QUEUE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function addToReviewQueue(entry) {
  const queue = readReviewQueue();
  queue.push({
    ...entry,
    status: "pending",
    addedAt: new Date().toISOString(),
  });
  fs.writeFileSync(REVIEW_QUEUE_PATH, JSON.stringify(queue, null, 2), "utf-8");
  console.log(
    `[DecisionEngine] 📋 Đã thêm vào hàng chờ review: commentId=${entry.commentId}`
  );
}

// ─── Decision Engine ──────────────────────────────────────────────────────────

/**
 * Xử lý một comment dựa trên kết quả phân tích.
 *
 * @param {{
 *   commentId: string,
 *   userId: string,
 *   message: string,
 *   postId?: string,
 *   receivedAt: string
 * }} commentInfo
 *
 * @param {{
 *   isSpam: boolean,
 *   level: "none" | "mild" | "repeat" | "severe",
 *   reason: string,
 *   details: object
 * }} spamResult
 *
 * @param {{
 *   intent: string,
 *   sentiment: string
 * }} aiResult
 *
 * @returns {Promise<{
 *   action: string,
 *   hidden: boolean,
 *   addedToReviewQueue: boolean,
 *   blacklistInfo: object | null,
 *   adminWarning: boolean
 * }>}
 */
async function processDecision(commentInfo, spamResult, aiResult) {
  const { commentId, userId, userName, message, postId, receivedAt } = commentInfo;
  const { isSpam, level, reason, details } = spamResult;

  let action = "none";
  let hidden = false;
  let addedToReviewQueue = false;
  let blacklistInfo = null;
  let adminWarning = false;

  console.log(
    `\n[DecisionEngine] 🔍 Xử lý commentId=${commentId} | userId=${userId}`
  );
  console.log(
    `[DecisionEngine]    Spam: ${isSpam} (level=${level}, reason=${reason})`
  );
  console.log(
    `[DecisionEngine]    AI  : intent=${aiResult.intent}, sentiment=${aiResult.sentiment}`
  );

  // ── Kiểm tra blacklist trước ───────────────────────────────────────────────
  if (isBlacklisted(userId)) {
    console.log(
      `[DecisionEngine] ⛔ userId=${userId} đang trong blacklist → ẩn bình luận, bỏ qua auto-reply`
    );
    hidden = await attemptHideComment(commentInfo, "hide_blacklisted", "blacklisted_user_comment");
    action = "hide_blacklisted";

    // Ghi nhận vi phạm thêm và kiểm tra cảnh báo admin
    const info = recordViolation(userId, "blacklisted_user_comment");
    blacklistInfo = info;
    if (info.shouldWarnAdmin) {
      adminWarning = true;
      console.warn(
        `[DecisionEngine] 🚨 CẢNH BÁO ADMIN: userId=${userId} đã vi phạm ${info.totalViolations} lần. Xem xét block thủ công trên Facebook.`
      );
    }

    // Publish summary to Kafka
    try {
      await publishModeration({
        commentId,
        userId,
        action,
        reason: "blacklisted_user_comment",
        hidden,
        addedToReviewQueue,
        receivedAt,
        postId,
      });
    } catch (err) {
      console.error("[DecisionEngine] ❌ Failed to publish moderation event:", err.message);
    }

    return { action, hidden, addedToReviewQueue, blacklistInfo, adminWarning };
  }

  // ── Xử lý theo mức độ spam ────────────────────────────────────────────────
  if (isSpam) {
    switch (level) {
      // ── Spam nhẹ: ẩn ngay ─────────────────────────────────────────────────
      case "mild": {
        console.log(`[DecisionEngine] ⚠️  Spam nhẹ → ẩn bình luận ngay`);
        hidden = await attemptHideComment(commentInfo, "hide_mild_spam", reason);
        action = "hide_mild_spam";

        // Ghi nhận vi phạm
        const info = recordViolation(userId, reason);
        blacklistInfo = info;
        if (info.shouldWarnAdmin) {
          adminWarning = true;
          console.warn(
            `[DecisionEngine] 🚨 CẢNH BÁO ADMIN: userId=${userId} tái phạm nhiều lần (${info.totalViolations}). Xem xét block.`
          );
        }
        // Publish summary to Kafka
        try {
          await publishModeration({
            commentId,
            userId,
            action,
            reason,
            hidden,
            addedToReviewQueue,
            receivedAt,
            postId,
          });
        } catch (err) {
          console.error("[DecisionEngine] ❌ Failed to publish moderation event:", err.message);
        }
        break;
      }

      // ── Spam lặp: ẩn + blacklist ───────────────────────────────────────────
      case "repeat": {
        console.log(
          `[DecisionEngine] 🔁 Spam lặp → ẩn + thêm vào blacklist nội bộ`
        );
        hidden = await attemptHideComment(commentInfo, "hide_and_blacklist", reason);
        action = "hide_and_blacklist";

        const info = recordViolation(userId, reason);
        blacklistInfo = info;

        if (info.isBlacklisted) {
          console.log(
            `[DecisionEngine] ⛔ userId=${userId} đã bị thêm vào blacklist (lặp ${info.recentViolations} lần)`
          );
        }
        if (info.shouldWarnAdmin) {
          adminWarning = true;
          console.warn(
            `[DecisionEngine] 🚨 CẢNH BÁO ADMIN: userId=${userId} tái phạm ${info.totalViolations} lần. Xem xét block thủ công.`
          );
        }
        // Publish summary to Kafka
        try {
          await publishModeration({
            commentId,
            userId,
            action,
            reason,
            hidden,
            addedToReviewQueue,
            receivedAt,
            postId,
            blacklistInfo,
          });
        } catch (err) {
          console.error("[DecisionEngine] ❌ Failed to publish moderation event:", err.message);
        }
        break;
      }

      // ── Spam nghiêm trọng: ẩn + hàng chờ ────────────────────────────────────
      case "severe": {
        console.log(
          `[DecisionEngine] 🚨 Spam nghiêm trọng → ẩn ngay + đưa vào hàng chờ review`
        );
        hidden = await attemptHideComment(commentInfo, "hide_and_queue_review", reason);
        action = "hide_and_queue_review";

        addToReviewQueue({
          commentId,
          userId,
          message,
          postId,
          reason,
          spamDetails: details,
          aiAnalysis: aiResult,
          receivedAt,
        });
        addedToReviewQueue = true;

        const info = recordViolation(userId, reason);
        blacklistInfo = info;
        if (info.shouldWarnAdmin) {
          adminWarning = true;
          console.warn(
            `[DecisionEngine] 🚨 CẢNH BÁO ADMIN: userId=${userId} tái phạm ${info.totalViolations} lần. Xem xét block thủ công.`
          );
        }
        // Publish summary to Kafka (includes that it was queued for review)
        try {
          await publishModeration({
            commentId,
            userId,
            action,
            reason,
            hidden,
            addedToReviewQueue,
            receivedAt,
            postId,
            blacklistInfo,
          });
        } catch (err) {
          console.error("[DecisionEngine] ❌ Failed to publish moderation event:", err.message);
        }
        break;
      }

      default:
        action = "none";
    }
  } else {
    // ── Không phải spam: thực hiện luật phản hồi tự động bằng AI ─────────────
    console.log(
      `[DecisionEngine] ✅ Bình luận bình thường. intent=${aiResult.intent}, sentiment=${aiResult.sentiment}`
    );
    
    let replyMessage = "";
    
    // Ưu tiên 1: Câu hỏi về giá sản phẩm/dịch vụ
    if (aiResult.intent === "ask_price") {
      action = "reply_ask_price";
      replyMessage = "Chào bạn! Vui lòng inbox để được shop hỗ trợ báo giá chi tiết ạ! 🌸";
    }
    // Ưu tiên 2: Cảm xúc tích cực (positive)
    else if (aiResult.sentiment === "positive") {
      action = "reply_positive";
      replyMessage = "Cảm ơn bạn đã ủng hộ shop! Chúc bạn một ngày tốt lành! 🥰";
    }
    // Ưu tiên 3: Cảm xúc tiêu cực (negative)
    else if (aiResult.sentiment === "negative") {
      action = "reply_negative";
      replyMessage = "Rất xin lỗi vì trải nghiệm chưa tốt, bên mình sẽ liên hệ inbox kiểm tra và xử lý ngay ạ! 🥺";
    }
    
    if (replyMessage) {
      console.log(`[DecisionEngine] 💬 Kích hoạt phản hồi tự động: action=${action} | message="${replyMessage}"`);
      
      const commandId = `reply_${commentId}`;
      
      // 1. Cập nhật trạng thái sự kiện sang "reply_queued"
      await publishStatusUpdate(commentId, "reply_queued", {
        action,
        commandId,
        replyMessage,
        message: `Đã đưa yêu cầu phản hồi tự động vào hàng chờ Kafka (${action})`,
      });
      
      // 2. Gửi lệnh phản hồi tới topic "reply_commands" qua Kafka Producer
      const publishSuccess = await publishModeration({
        commandId,
        commentId,
        postId,
        userId,
        userName,
        originalMessage: message,
        replyMessage,
        sentiment: aiResult.sentiment,
        intent: aiResult.intent,
        timestamp: new Date().toISOString(),
      }, "reply_commands");
      
      if (publishSuccess) {
        console.log(`[DecisionEngine] 📣 Đã gửi lệnh phản hồi sang Kafka cho comment: ${commentId}`);
      } else {
        console.error(`[DecisionEngine] ❌ Gửi lệnh phản hồi sang Kafka thất bại cho comment: ${commentId}`);
      }
    } else {
      action = "none";
      console.log("[DecisionEngine] 💬 Bình luận trung tính hoặc không cần phản hồi tự động.");
    }
  }

  return { action, hidden, addedToReviewQueue, blacklistInfo, adminWarning };
}

module.exports = { processDecision, addToReviewQueue };
