/**
 * idempotencyStore.js
 * Quản lý lọc trùng lặp sự kiện (Idempotency) dựa trên commentId.
 * Lưu trữ danh sách commentId đã xử lý thành công vào file JSON để duy trì sau khi restart.
 */

const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "data", "processed_events.json");
const processedKeys = new Set();
let _loaded = false;

function ensureLoaded() {
  if (_loaded) return;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        list.forEach(key => processedKeys.add(key));
        console.log(`[IdempotencyStore] 💾 Đã tải ${processedKeys.size} idempotency keys từ file.`);
      }
    }
  } catch (err) {
    console.error("[IdempotencyStore] ❌ Lỗi khi tải file:", err.message);
  }
  _loaded = true;
}

function saveStore() {
  try {
    const list = Array.from(processedKeys);
    fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    console.error("[IdempotencyStore] ❌ Lỗi khi ghi file:", err.message);
  }
}

/**
 * Kiểm tra xem commentId đã được xử lý xong trước đó chưa.
 * @param {string} commentId 
 * @returns {boolean}
 */
function isDuplicate(commentId) {
  ensureLoaded();
  return processedKeys.has(commentId);
}

/**
 * Đánh dấu commentId đã được xử lý thành công.
 * @param {string} commentId 
 */
function markProcessed(commentId) {
  ensureLoaded();
  if (commentId && !processedKeys.has(commentId)) {
    processedKeys.add(commentId);
    saveStore();
    console.log(`[IdempotencyStore] 💾 Đã đánh dấu processed: ${commentId}`);
  }
}

module.exports = {
  isDuplicate,
  markProcessed,
};
