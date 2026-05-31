/**
 * rateLimiter.js
 * Giới hạn tần suất gửi bình luận của người dùng (Rate Limiting).
 * Quy tắc: Tối đa 20 bình luận trong vòng 1 phút (60 giây) cho mỗi userId.
 */

const userCommentsHistory = new Map();
const LIMIT_WINDOW_MS = 60 * 1000; // 60 giây
const MAX_COMMENTS = 20;

/**
 * Kiểm tra xem người dùng có đang spam với tần suất quá cao hay không.
 * @param {string} userId - ID người dùng Facebook
 * @param {number} [eventTime=Date.now()] - Mốc thời gian xảy ra sự kiện
 * @returns {boolean} - true nếu bị rate limited (vượt quá ngưỡng)
 */
function checkRateLimit(userId, eventTime = Date.now()) {
  if (!userCommentsHistory.has(userId)) {
    userCommentsHistory.set(userId, []);
  }

  const timestamps = userCommentsHistory.get(userId);

  // Lọc và chỉ giữ lại các mốc thời gian trong vòng 60 giây qua tính đến mốc eventTime
  const recentTimestamps = timestamps.filter(ts => eventTime - ts < LIMIT_WINDOW_MS);

  // Ghi nhận mốc thời gian hiện tại
  recentTimestamps.push(eventTime);
  userCommentsHistory.set(userId, recentTimestamps);

  // Nếu vượt quá ngưỡng 20 bình luận trong 1 phút
  if (recentTimestamps.length > MAX_COMMENTS) {
    console.warn(`[RateLimiter] ⚠️  Cảnh báo: userId=${userId} gửi quá nhanh! (${recentTimestamps.length} bình luận/phút)`);
    return true;
  }

  return false;
}

module.exports = {
  checkRateLimit,
};
