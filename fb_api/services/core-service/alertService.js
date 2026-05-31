/**
 * alertService.js
 * Lắng nghe topic Dead Letter Queue `dlq_events`.
 * Tự động kích hoạt in cảnh báo bắt mắt ra Console logs và giả lập (hoặc gửi thật) bắn Alert Slack.
 */

const { Kafka } = require("kafkajs");
const https = require("https");

const BROKER = process.env.KAFKA_BROKER || "localhost:9092";
const TOPIC = "dlq_events";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

const kafka = new Kafka({
  clientId: "alert-service",
  brokers: [BROKER],
});

const consumer = kafka.consumer({ groupId: "alert-service-group" });
let _initialized = false;

/**
 * Gửi webhook tin nhắn Slack thật nếu được cấu hình.
 */
function sendSlackWebhook(payload) {
  if (!SLACK_WEBHOOK_URL) return Promise.resolve(false);

  return new Promise((resolve) => {
    try {
      const url = new URL(SLACK_WEBHOOK_URL);
      const data = JSON.stringify(payload);
      
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 5000,
      };

      const req = https.request(options, (res) => {
        resolve(res.statusCode === 200);
      });

      req.on("error", () => resolve(false));
      req.write(data);
      req.end();
    } catch {
      resolve(false);
    }
  });
}

/**
 * Tạo payload Slack Rich Block chuyên nghiệp.
 */
function buildSlackBlocks(event) {
  const { commentId, action, finalError, commentInfo = {}, failedAt } = event;
  
  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚨 *CẢNH BÁO LỖI HỆ THỐNG - DEAD LETTER QUEUE (DLQ)* 🚨\nMột bình luận lỗi đã vượt quá giới hạn thử lại tự động và cần xử lý thủ công.`
        }
      },
      {
        type: "divider"
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Comment ID:*\n\`${commentId}\`` },
          { type: "mrkdwn", text: `*Hành động:*\n\`${action}\`` },
          { type: "mrkdwn", text: `*Người đăng:*\n${commentInfo.userName || "N/A"} (\`${commentInfo.userId || "N/A"}\`)` },
          { type: "mrkdwn", text: `*Thời gian lỗi:*\n${failedAt ? new Date(failedAt).toLocaleString() : new Date().toLocaleString()}` }
        ]
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Nội dung bình luận:*\n> "${commentInfo.message || ""}"`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Lỗi cuối cùng:*\n\`\`\`${finalError || "Không xác định"}\`\`\``
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `💡 *Gợi ý vận hành:* Sử dụng Facebook Page Dashboard hoặc \`test-hide-real.js\` để ẩn/xóa bình luận này một cách thủ công.`
          }
        ]
      }
    ]
  };
}

/**
 * Bắt đầu lắng nghe dlq_events.
 */
async function start() {
  if (_initialized) return;

  try {
    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
    
    console.log(`[AlertService] 🔄 Đang lắng nghe topic cảnh báo DLQ '${TOPIC}'...`);

    await consumer.run({
      eachMessage: async ({ message }) => {
        const rawValue = message.value?.toString();
        if (!rawValue) return;

        let event;
        try {
          event = JSON.parse(rawValue);
        } catch {
          console.warn("[AlertService] ⚠️ Tin nhắn không phải JSON hợp lệ.");
          return;
        }

        const { commentId, action, finalError, commentInfo = {} } = event;

        // 1. In cảnh báo ra Console logs (hộp màu đỏ bắt mắt)
        console.error("\n" + "🛑".repeat(25));
        console.error("               CRITICAL ALERT — SYSTEM DLQ");
        console.error("🛑".repeat(25));
        console.error(`  [!] Comment ID  : ${commentId}`);
        console.error(`  [!] Action      : ${action}`);
        console.error(`  [!] User        : ${commentInfo.userName} (${commentInfo.userId})`);
        console.error(`  [!] Message     : "${commentInfo.message}"`);
        console.error(`  [!] Final Error : ${finalError || "Timeout/API failure"}`);
        console.error("🛑".repeat(25) + "\n");

        // 2. Tạo Slack Rich Block
        const slackPayload = buildSlackBlocks(event);

        // 3. Giả lập / Gửi Slack Alert thật
        if (SLACK_WEBHOOK_URL) {
          const sent = await sendSlackWebhook(slackPayload);
          if (sent) {
            console.log("[AlertService] 📲 Đã gửi cảnh báo lỗi Slack thành công!");
          } else {
            console.warn("[AlertService] ⚠️ Gửi cảnh báo Slack thất bại.");
          }
        } else {
          console.log("[AlertService] 📲 [GIẢ LẬP SLACK ALERT] Bắn Slack Block Payload:");
          console.log(JSON.stringify(slackPayload, null, 2));
        }
      }
    });

    _initialized = true;
    console.log("[AlertService] ✅ Dịch vụ cảnh báo AlertService đã khởi chạy nền.");
  } catch (err) {
    console.error("[AlertService] ❌ Khởi động consumer cảnh báo thất bại:", err.message);
  }
}

async function stop() {
  if (consumer) {
    await consumer.disconnect();
    _initialized = false;
  }
}

module.exports = {
  start,
  stop
};
