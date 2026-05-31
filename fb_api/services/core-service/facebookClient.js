/**
 * facebookClient.js
 * Gọi Facebook Graph API trực tiếp để thực hiện hành động kiểm duyệt.
 *
 * Các hành động hỗ trợ:
 *   - hideComment(commentId)   → Ẩn bình luận (is_hidden=true)
 *   - deleteComment(commentId) → Xóa bình luận
 */

const https = require("https");

// Dùng v25.0 để khớp với token trong appsettings.Development.json
const GRAPH_URL    = (process.env.FACEBOOK_GRAPH_URL || "https://graph.facebook.com/v25.0").replace(/\/$/, "");
const ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "";

// ─── Helper: gọi Graph API ────────────────────────────────────────────────────

/**
 * Gửi POST request đến Facebook Graph API bằng https thuần (không cần axios).
 */
function graphPost(path, params) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({
      ...params,
      access_token: ACCESS_TOKEN,
    }).toString();

    const url = new URL(`${GRAPH_URL}/${path}`);
    const options = {
      hostname: url.hostname,
      path: `${url.pathname}?${query}`,
      method: "POST",
      timeout: 5000, // Thêm timeout 5 giây
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("timeout", () => {
      console.error(`[FacebookClient] ⏳ Request POST ${path} bị timeout sau 5000ms.`);
      req.destroy(new Error("Facebook API POST Request Timeout"));
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * Gửi DELETE request đến Facebook Graph API.
 */
function graphDelete(path) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ access_token: ACCESS_TOKEN }).toString();
    const url = new URL(`${GRAPH_URL}/${path}`);
    const options = {
      hostname: url.hostname,
      path: `${url.pathname}?${query}`,
      method: "DELETE",
      timeout: 5000, // Thêm timeout 5 giây
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("timeout", () => {
      console.error(`[FacebookClient] ⏳ Request DELETE ${path} bị timeout sau 5000ms.`);
      req.destroy(new Error("Facebook API DELETE Request Timeout"));
    });

    req.on("error", reject);
    req.end();
  });
}

// ─── API công khai ────────────────────────────────────────────────────────────

/**
 * Ẩn bình luận (is_hidden = true).
 * @param {string} commentId
 * @returns {Promise<boolean>} - true nếu thành công
 */
async function hideComment(commentId) {
  if (!ACCESS_TOKEN || ACCESS_TOKEN === "your_page_access_token_here") {
    console.warn("[FacebookClient] ⚠️  PAGE_ACCESS_TOKEN chưa cấu hình. Bỏ qua hideComment.");
    return false;
  }

  try {
    const result = await graphPost(commentId, { is_hidden: "true" });
    if (result.body?.success === true || result.status === 200) {
      console.log(`[FacebookClient] 🙈 Đã ẩn comment: ${commentId}`);
      return true;
    } else {
      console.error(
        `[FacebookClient] ❌ Không thể ẩn comment ${commentId}:`,
        result.body
      );
      return false;
    }
  } catch (err) {
    console.error(`[FacebookClient] ❌ Lỗi khi ẩn comment ${commentId}:`, err.message);
    return false;
  }
}

/**
 * Xóa bình luận.
 * @param {string} commentId
 * @returns {Promise<boolean>} - true nếu thành công
 */
async function deleteComment(commentId) {
  if (!ACCESS_TOKEN || ACCESS_TOKEN === "your_page_access_token_here") {
    console.warn("[FacebookClient] ⚠️  PAGE_ACCESS_TOKEN chưa cấu hình. Bỏ qua deleteComment.");
    return false;
  }

  try {
    const result = await graphDelete(commentId);
    if (result.body?.success === true || result.status === 200) {
      console.log(`[FacebookClient] 🗑️  Đã xóa comment: ${commentId}`);
      return true;
    } else {
      console.error(
        `[FacebookClient] ❌ Không thể xóa comment ${commentId}:`,
        result.body
      );
      return false;
    }
  } catch (err) {
    console.error(`[FacebookClient] ❌ Lỗi khi xóa comment ${commentId}:`, err.message);
    return false;
  }
}

module.exports = { hideComment, deleteComment };
