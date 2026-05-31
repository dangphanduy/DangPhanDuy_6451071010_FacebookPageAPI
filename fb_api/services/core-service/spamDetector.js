/**
 * spamDetector.js
 * Phát hiện spam dựa trên:
 *   1. Chứa URL/link → spam nhẹ (mild)
 *   2. Từ khóa scam / độc hại rõ ràng → spam nghiêm trọng (severe)
 *   3. Nội dung giống hệt trong lịch sử gần đây → spam lặp (repeat)
 */

// ─── Cấu hình ─────────────────────────────────────────────────────────────────

// Regex phát hiện URL
const URL_REGEX =
  /https?:\/\/[^\s]+|www\.[^\s]+|\b[\w-]+\.(com|net|org|vn|io|xyz|top|click|info|biz)(\/[^\s]*)?/gi;

// Từ khóa scam / độc hại (tiếng Việt + tiếng Anh phổ biến)
const HARMFUL_KEYWORDS = [
  // Lừa đảo
  "lừa đảo", "scam", "hack", "phishing", "virus", "malware",
  "kiếm tiền nhanh", "làm giàu", "triệu phú", "thu nhập khủng",
  "đầu tư sinh lời", "forex", "bitcoin miễn phí", "crypto airdrop",
  // Bot / quảng cáo rác
  "mua follow", "tăng like", "sub4sub", "view4view",
  "click vào link", "bấm vào đây", "nhấn vào đây",
  // Nội dung 18+
  "xxx", "18+", "khiêu dâm", "sex",
];

// Lịch sử nội dung gần đây để phát hiện lặp (in-memory, key: userId)
// Format: { userId: [{ text: string, timestamp: number }] }
const recentMessages = {};
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 giờ
const DUPLICATE_THRESHOLD = 3; // Lặp >= 3 lần trong 24h

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Chuẩn hóa văn bản để so sánh (lowercase, bỏ dấu câu, khoảng trắng thừa)
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'()[\]{}\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Đếm số lần nội dung đã xuất hiện trong cửa sổ 24h gần nhất.
 */
function countRecentDuplicates(userId, normalizedText) {
  const now = Date.now();
  if (!recentMessages[userId]) recentMessages[userId] = [];

  // Loại bỏ các mục cũ quá 24h
  recentMessages[userId] = recentMessages[userId].filter(
    (m) => now - m.timestamp < DUPLICATE_WINDOW_MS
  );

  // Đếm số lần trùng
  const duplicateCount = recentMessages[userId].filter(
    (m) => m.text === normalizedText
  ).length;

  // Lưu tin nhắn hiện tại
  recentMessages[userId].push({ text: normalizedText, timestamp: now });

  return duplicateCount + 1; // +1 vì lần này cũng tính
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Phát hiện spam cho một comment.
 *
 * @param {string} userId    - ID người dùng Facebook
 * @param {string} message   - Nội dung bình luận
 * @returns {{
 *   isSpam: boolean,
 *   level: "none" | "mild" | "repeat" | "severe",
 *   reason: string,
 *   details: object
 * }}
 */
function detectSpam(userId, message) {
  if (!message || typeof message !== "string") {
    return { isSpam: false, level: "none", reason: "", details: {} };
  }

  const normalized = normalizeText(message);

  // ── 1. Kiểm tra từ khóa độc hại / scam ───────────────────────────────────
  const foundHarmful = HARMFUL_KEYWORDS.find((kw) =>
    normalized.includes(kw.toLowerCase())
  );
  if (foundHarmful) {
    console.log(
      `[SpamDetector] 🚨 SEVERE spam từ userId=${userId}: từ khóa "${foundHarmful}"`
    );
    return {
      isSpam: true,
      level: "severe",
      reason: "harmful_keyword",
      details: { keyword: foundHarmful, message },
    };
  }

  // ── 2. Kiểm tra URL / link ────────────────────────────────────────────────
  const links = message.match(URL_REGEX);
  if (links && links.length > 0) {
    console.log(
      `[SpamDetector] ⚠️  MILD spam từ userId=${userId}: chứa link "${links[0]}"`
    );
    return {
      isSpam: true,
      level: "mild",
      reason: "contains_link",
      details: { links, message },
    };
  }

  // ── 3. Kiểm tra nội dung lặp lại ─────────────────────────────────────────
  const repeatCount = countRecentDuplicates(userId, normalized);
  if (repeatCount >= DUPLICATE_THRESHOLD) {
    console.log(
      `[SpamDetector] 🔁 REPEAT spam từ userId=${userId}: lặp ${repeatCount} lần trong 24h`
    );
    return {
      isSpam: true,
      level: "repeat",
      reason: "repeated_content",
      details: { repeatCount, message },
    };
  }

  // ── Bình thường ───────────────────────────────────────────────────────────
  return { isSpam: false, level: "none", reason: "", details: {} };
}

module.exports = { detectSpam };
