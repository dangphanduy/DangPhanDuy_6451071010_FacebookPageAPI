/**
 * test-hide-real.js
 * Test xem hideComment có thực sự hoạt động với comment ID thật không.
 *
 * Cách lấy commentId thật:
 *   1. Vào Facebook Page, đăng bình luận bất kỳ
 *   2. Chạy: node test-hide-real.js get   → lấy danh sách comment ID
 *   3. Chạy: node test-hide-real.js hide <commentId>  → ẩn comment đó
 *
 * Ví dụ:
 *   node test-hide-real.js get
 *   node test-hide-real.js hide 1234567890_9876543210
 */

require("dotenv").config();
const https = require("https");

const TOKEN    = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const GRAPH    = "graph.facebook.com";
const API_VER  = "v25.0";

// ─── Helper: GET request ──────────────────────────────────────────────────────
function graphGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ ...params, access_token: TOKEN }).toString();
    const options = {
      hostname: GRAPH,
      path: `/${API_VER}/${path}?${query}`,
      method: "GET",
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.end();
  });
}

// ─── Helper: POST request ─────────────────────────────────────────────────────
function graphPost(path, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ ...params, access_token: TOKEN }).toString();
    const options = {
      hostname: GRAPH,
      path: `/${API_VER}/${path}?${query}`,
      method: "POST",
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ─── Lệnh: GET — lấy danh sách post và comment ────────────────────────────────
async function getComments() {
  console.log("🔍 Đang lấy danh sách bài viết...\n");

  // Lấy Page ID từ token
  const me = await graphGet("me", { fields: "id,name" });
  console.log(`📄 Page: ${me.name} (ID: ${me.id})\n`);

  // Lấy posts gần nhất
  const posts = await graphGet(`${me.id}/posts`, { fields: "id,message,created_time", limit: 3 });

  if (!posts.data || posts.data.length === 0) {
    console.log("❌ Không có bài viết nào.");
    return;
  }

  for (const post of posts.data) {
    console.log(`\n📝 Bài viết: "${(post.message || "").substring(0, 50)}"`);
    console.log(`   Post ID: ${post.id}`);
    console.log(`   Thời gian: ${post.created_time}`);

    // Lấy comment của bài viết này
    const comments = await graphGet(`${post.id}/comments`, {
      fields: "id,message,from,created_time",
    });

    if (!comments.data || comments.data.length === 0) {
      console.log("   → Chưa có comment.");
    } else {
      console.log(`   → ${comments.data.length} comment(s):`);
      for (const c of comments.data) {
        console.log(`      Comment ID : ${c.id}`);
        console.log(`      Người đăng : ${c.from?.name}`);
        console.log(`      Nội dung   : "${c.message}"`);
        console.log(`      ---`);
      }
    }
  }

  console.log("\n💡 Để ẩn comment, chạy:");
  console.log("   node test-hide-real.js hide <Comment_ID>");
}

// ─── Lệnh: HIDE — ẩn một comment ─────────────────────────────────────────────
async function hideComment(commentId) {
  console.log(`🙈 Đang ẩn comment: ${commentId} ...`);

  const result = await graphPost(commentId, { is_hidden: "true" });

  console.log(`\nHTTP Status: ${result.status}`);
  console.log("Facebook trả về:", JSON.stringify(result.body, null, 2));

  if (result.body?.success === true) {
    console.log("\n✅ Ẩn thành công! Comment đã bị ẩn trên Facebook.");
    console.log("   → Đây là bằng chứng hideComment() TỰ ĐỘNG hoạt động.");
    console.log("   → Khi webhook kết nối, hệ thống sẽ tự gọi lệnh này cho mỗi spam comment.");
  } else if (result.body?.error) {
    console.log("\n❌ Lỗi từ Facebook API:");
    console.log(`   Code   : ${result.body.error.code}`);
    console.log(`   Message: ${result.body.error.message}`);
    console.log(`   Type   : ${result.body.error.type}`);
    console.log("\n💡 Nguyên nhân thường gặp:");
    console.log("   - Token thiếu quyền 'pages_manage_engagement'");
    console.log("   - Comment ID không đúng");
    console.log("   - Token đã hết hạn");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN || TOKEN === "your_page_access_token_here") {
    console.error("❌ Chưa điền FACEBOOK_PAGE_ACCESS_TOKEN vào .env");
    process.exit(1);
  }

  const cmd = process.argv[2];

  if (cmd === "get") {
    await getComments();
  } else if (cmd === "hide") {
    const commentId = process.argv[3];
    if (!commentId) {
      console.error("❌ Thiếu commentId. Dùng: node test-hide-real.js hide <commentId>");
      process.exit(1);
    }
    await hideComment(commentId);
  } else {
    console.log("Cách dùng:");
    console.log("  node test-hide-real.js get              → xem danh sách comment");
    console.log("  node test-hide-real.js hide <commentId> → ẩn comment đó");
  }
}

main().catch((err) => {
  console.error("❌ Lỗi:", err.message);
  process.exit(1);
});
