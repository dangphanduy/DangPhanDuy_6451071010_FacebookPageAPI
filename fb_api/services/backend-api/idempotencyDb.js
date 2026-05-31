/**
 * idempotencyDb.js
 * Quản lý kết nối SQLite và lưu trữ thông tin command_id của các lệnh phản hồi.
 * Cung cấp cơ chế check-and-register nhằm bảo đảm tính Idempotent cho Kafka consumer.
 */

const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, "idempotency.db");
console.log(`[IdempotencyDB] 📁 Database path: ${DB_PATH}`);

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("[IdempotencyDB] ❌ Lỗi kết nối SQLite:", err.message);
  } else {
    console.log("[IdempotencyDB] ✅ Đã kết nối SQLite Database.");
  }
});

// Khởi tạo cơ sở dữ liệu
function initDb() {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS processed_commands (
        command_id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL,
        reply_message TEXT NOT NULL,
        status TEXT NOT NULL, -- 'processing', 'completed', 'failed'
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => {
        if (err) {
          console.error("[IdempotencyDB] ❌ Khởi tạo bảng thất bại:", err.message);
          reject(err);
        } else {
          console.log("[IdempotencyDB] ✅ Bảng processed_commands đã sẵn sàng.");
          resolve();
        }
      }
    );
  });
}

/**
 * Thực hiện kiểm tra và đăng ký command_id (Atomic Check-and-Register).
 * @param {string} commandId
 * @param {string} commentId
 * @param {string} replyMessage
 * @returns {Promise<boolean>} - Trả về true nếu đăng ký thành công (chưa từng tồn tại), false nếu đã tồn tại.
 */
function checkAndRegisterCommand(commandId, commentId, replyMessage) {
  return new Promise((resolve) => {
    const query = `INSERT INTO processed_commands (command_id, comment_id, reply_message, status) VALUES (?, ?, ?, 'processing')`;
    db.run(query, [commandId, commentId, replyMessage], function (err) {
      if (err) {
        // Lỗi UNIQUE constraint khi trùng lặp khóa chính
        if (err.message.includes("UNIQUE constraint failed")) {
          resolve(false); // Đã tồn tại, bỏ qua
        } else {
          console.error(`[IdempotencyDB] ❌ Lỗi khi chèn command ${commandId}:`, err.message);
          resolve(false); // Trả về false phòng hờ lỗi nghiêm trọng khác
        }
      } else {
        // Insert thành công
        resolve(this.changes > 0);
      }
    });
  });
}

/**
 * Cập nhật trạng thái xử lý của một command.
 * @param {string} commandId
 * @param {string} status - 'completed' | 'failed'
 * @param {string} [errorMessage]
 */
function updateCommandStatus(commandId, status, errorMessage = null) {
  return new Promise((resolve, reject) => {
    const query = `UPDATE processed_commands SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?`;
    db.run(query, [status, errorMessage, commandId], function (err) {
      if (err) {
        console.error(`[IdempotencyDB] ❌ Cập nhật trạng thái thất bại cho command ${commandId}:`, err.message);
        reject(err);
      } else {
        resolve(this.changes > 0);
      }
    });
  });
}

/**
 * Đọc tất cả commands để phục vụ hiển thị / thống kê (optional).
 */
function getAllCommands(limit = 100) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM processed_commands ORDER BY updated_at DESC LIMIT ?`, [limit], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

module.exports = {
  initDb,
  checkAndRegisterCommand,
  updateCommandStatus,
  getAllCommands,
};
