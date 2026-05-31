/**
 * aiAnalyzer.js
 * Gọi Google Gemini API để phân tích intent và sentiment của comment.
 *
 * Intent:
 *   - ask_price      : hỏi giá cả / thông tin sản phẩm
 *   - complaint      : khiếu nại / yêu cầu hỗ trợ
 *   - compliment     : khen ngợi
 *   - interaction    : tương tác thông thường (hỏi thăm, bình luận vui)
 *   - other          : không xác định
 *
 * Sentiment:
 *   - positive       : tích cực
 *   - neutral        : trung tính
 *   - negative       : tiêu cực
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

const MAX_RETRIES = 2;
const DEFAULT_RESULT = { intent: "other", sentiment: "neutral" };

// Danh sách model ưu tiên — thử lần lượt nếu model trước thất bại
const MODEL_PRIORITY = [
  "gemini-3.5-flash",          // model mới nhất, miễn phí
  "gemini-3.1-flash-lite",     // nhẹ hơn, fallback
  "gemini-1.5-flash-latest",   // cũ hơn, fallback cuối
];

let genAI = null;
let model = null;

function initGemini() {
  if (model) return;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    console.warn("[AIAnalyzer] ⚠️  GEMINI_API_KEY chưa cấu hình. Sẽ trả về kết quả mặc định.");
    return;
  }
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({ model: MODEL_PRIORITY[0] });
  console.log(`[AIAnalyzer] ✅ Gemini model: ${MODEL_PRIORITY[0]}`);
}


/**
 * Tạo prompt ngắn gọn, yêu cầu trả về JSON đơn giản.
 */
function buildPrompt(commentText) {
  return `Bạn là AI phân tích bình luận mạng xã hội. Hãy phân tích bình luận Facebook sau và trả về JSON.

Bình luận: "${commentText}"

Quy tắc phân loại intent:
- "ask_price": hỏi giá, hỏi thông tin sản phẩm/dịch vụ
- "complaint": khiếu nại, chưa nhận hàng, không hài lòng, yêu cầu hỗ trợ
- "compliment": khen ngợi, hài lòng, tích cực về sản phẩm/dịch vụ
- "interaction": tương tác thông thường, bình luận vui, hỏi thăm chung
- "other": không thuộc các loại trên

Quy tắc phân loại sentiment:
- "positive": nội dung mang cảm xúc tích cực, vui vẻ
- "neutral": nội dung trung tính, không rõ cảm xúc
- "negative": nội dung tiêu cực, bực bội, thất vọng

Chỉ trả về JSON, không giải thích thêm:
{"intent":"<intent>","sentiment":"<sentiment>"}`;
}

/**
 * Parse JSON từ response của Gemini.
 * Gemini đôi khi bọc kết quả trong ```json ... ```, cần xử lý.
 */
function parseGeminiResponse(text) {
  // Loại bỏ markdown code block nếu có
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  // Validate các field
  const validIntents = ["ask_price", "complaint", "compliment", "interaction", "other"];
  const validSentiments = ["positive", "neutral", "negative"];

  return {
    intent: validIntents.includes(parsed.intent) ? parsed.intent : "other",
    sentiment: validSentiments.includes(parsed.sentiment)
      ? parsed.sentiment
      : "neutral",
  };
}

/**
 * Phân tích intent và sentiment của một comment bằng Gemini.
 * Tự động thử fallback model nếu model chính bị lỗi 404 (deprecated)
 * hoặc 429 (quota exceeded).
 */
async function analyzeComment(commentText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    console.log("[AIAnalyzer] Gemini chưa cấu hình, dùng kết quả mặc định.");
    return DEFAULT_RESULT;
  }

  if (!genAI) genAI = new GoogleGenerativeAI(apiKey);

  const prompt = buildPrompt(commentText);
  const preview = commentText.substring(0, 60);

  for (const modelName of MODEL_PRIORITY) {
    const currentModel = genAI.getGenerativeModel({ model: modelName });

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[AIAnalyzer] 🤖 [${modelName}] Phân tích (lần ${attempt}): "${preview}..."`);

        const result = await currentModel.generateContent(prompt);
        const responseText = result.response.text();

        console.log(`[AIAnalyzer] 📨 Gemini: ${responseText.trim()}`);
        const analyzed = parseGeminiResponse(responseText);
        console.log(`[AIAnalyzer] ✅ intent=${analyzed.intent}, sentiment=${analyzed.sentiment}`);
        return analyzed;

      } catch (err) {
        const msg = err.message || "";
        const is404 = msg.includes("404") || msg.includes("not found for API");
        const is429 = msg.includes("429") || msg.includes("Quota exceeded") || msg.includes("quota");

        if (is404) {
          console.warn(`[AIAnalyzer] ⚠️  Model "${modelName}" không tồn tại → thử model tiếp theo`);
          break; // sang model kế tiếp

        } else if (is429) {
          // Đọc thời gian retry-after từ lỗi nếu có (ví dụ: "retry in 27.78s")
          const retryMatch = msg.match(/retry[^\d]*(\d+\.?\d*)\s*s/i);
          const waitSec = retryMatch ? Math.min(parseFloat(retryMatch[1]), 10) : 5;
          console.warn(`[AIAnalyzer] ⏳ Quota "${modelName}" hết, chờ ${waitSec}s rồi thử model tiếp`);
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          break; // sang model kế tiếp sau khi chờ

        } else {
          console.error(`[AIAnalyzer] ❌ [${modelName}] Lần ${attempt}: ${msg.substring(0, 120)}`);
          if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  console.warn("[AIAnalyzer] ⚠️  Tất cả model thất bại → dùng kết quả mặc định.");
  return DEFAULT_RESULT;
}

module.exports = { analyzeComment };

