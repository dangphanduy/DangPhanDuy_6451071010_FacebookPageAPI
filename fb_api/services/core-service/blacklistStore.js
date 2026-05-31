/**
 * blacklistStore.js
 * Quản lý danh sách blacklist nội bộ (lưu file JSON).
 * Theo dõi số lần vi phạm của từng userId trong cửa sổ thời gian.
 */

const fs = require("fs");
const path = require("path");

const BLACKLIST_PATH = path.join(__dirname, "data", "blacklist.json");
const SPAM_REPEAT_THRESHOLD = parseInt(process.env.SPAM_REPEAT_THRESHOLD) || 3;
const SPAM_WINDOW_HOURS = parseInt(process.env.SPAM_WINDOW_HOURS) || 24;
const RECIDIVISM_THRESHOLD = parseInt(process.env.RECIDIVISM_THRESHOLD) || 5;

// ─── Đọc / Ghi file ──────────────────────────────────────────────────────────

function readStore() {
  try {
    const raw = fs.readFileSync(BLACKLIST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { users: {} };
  }
}

function writeStore(store) {
  fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ─── API công khai ────────────────────────────────────────────────────────────

/**
 * Ghi nhận một vi phạm của userId.
 * @param {string} userId
 * @param {string} reason  - lý do vi phạm
 * @returns {{ totalViolations: number, recentViolations: number, isBlacklisted: boolean, shouldWarnAdmin: boolean }}
 */
function recordViolation(userId, reason = "spam") {
  const store = readStore();
  const now = new Date().toISOString();

  if (!store.users[userId]) {
    store.users[userId] = {
      totalViolations: 0,
      violations: [],
      firstSeen: now,
      lastSeen: now,
      isBlacklisted: false,
      reason: "",
    };
  }

  const user = store.users[userId];
  user.totalViolations += 1;
  user.lastSeen = now;
  user.reason = reason;
  user.violations.push({ timestamp: now, reason });

  // Lọc vi phạm trong cửa sổ 24h gần nhất
  const windowStart = new Date(
    Date.now() - SPAM_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString();
  const recentViolations = user.violations.filter(
    (v) => v.timestamp >= windowStart
  );
  user.violations = recentViolations; // Chỉ giữ vi phạm trong cửa sổ

  // Nếu lặp vi phạm >= ngưỡng trong cửa sổ → blacklist
  if (recentViolations.length >= SPAM_REPEAT_THRESHOLD) {
    user.isBlacklisted = true;
    console.log(
      `[BlacklistStore] ⛔ userId=${userId} đã bị blacklist (${recentViolations.length} vi phạm trong ${SPAM_WINDOW_HOURS}h)`
    );
  }

  writeStore(store);

  return {
    totalViolations: user.totalViolations,
    recentViolations: recentViolations.length,
    isBlacklisted: user.isBlacklisted,
    shouldWarnAdmin: user.totalViolations >= RECIDIVISM_THRESHOLD,
  };
}

/**
 * Kiểm tra userId có trong blacklist không.
 * @param {string} userId
 * @returns {boolean}
 */
function isBlacklisted(userId) {
  const store = readStore();
  return store.users[userId]?.isBlacklisted === true;
}

/**
 * Lấy thông tin vi phạm của userId.
 * @param {string} userId
 */
function getUserInfo(userId) {
  const store = readStore();
  return store.users[userId] || null;
}

/**
 * Lấy toàn bộ danh sách blacklist.
 */
function getAllBlacklisted() {
  const store = readStore();
  return Object.entries(store.users)
    .filter(([, info]) => info.isBlacklisted)
    .map(([userId, info]) => ({ userId, ...info }));
}

/**
 * Xóa một người dùng ra khỏi blacklist.
 * @param {string} userId
 * @returns {boolean} - true nếu thành công
 */
function unblacklistUser(userId) {
  const store = readStore();
  if (store.users[userId]) {
    store.users[userId].isBlacklisted = false;
    store.users[userId].violations = []; // Xóa lịch sử vi phạm gần đây
    writeStore(store);
    console.log(`[BlacklistStore] 🔓 Đã gỡ bỏ blacklist cho userId=${userId}`);
    return true;
  }
  return false;
}

module.exports = {
  recordViolation,
  isBlacklisted,
  getUserInfo,
  getAllBlacklisted,
  unblacklistUser,
};
