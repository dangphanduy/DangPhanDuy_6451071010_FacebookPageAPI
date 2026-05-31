/**
 * facebookClient.js (Backend API)
 * Gọi Facebook Graph API trực tiếp để thực hiện phản hồi bình luận.
 * Tích hợp timeout 5 giây để tránh treo request.
 */

const https = require("https");

const GRAPH_URL    = (process.env.FACEBOOK_GRAPH_URL || "https://graph.facebook.com/v25.0").replace(/\/$/, "");
const ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "";

/**
 * Gửi POST request đến Facebook Graph API bằng https thuần.
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
      timeout: 5000, // Timeout 5 giây
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
 * Phản hồi bình luận (Trả lời comment).
 * @param {string} commentId
 * @param {string} message
 * @returns {Promise<boolean>} - true nếu thành công
 */
async function replyComment(commentId, message) {
  if (!ACCESS_TOKEN || ACCESS_TOKEN === "your_page_access_token_here") {
    console.warn("[FacebookClient] ⚠️ PAGE_ACCESS_TOKEN chưa cấu hình. Bỏ qua replyComment.");
    return false;
  }

  try {
    const result = await graphPost(`${commentId}/comments`, { message });
    if (result.body?.id || result.body?.success === true || result.status === 200) {
      console.log(`[FacebookClient] 💬 Đã reply comment ${commentId} thành công. Reply ID: ${result.body?.id || "N/A"}`);
      return true;
    } else {
      console.error(`[FacebookClient] ❌ Không thể reply comment ${commentId}:`, result.body);
      return false;
    }
  } catch (err) {
    console.error(`[FacebookClient] ❌ Lỗi khi reply comment ${commentId}:`, err.message);
    return false;
  }
}

module.exports = { replyComment };
