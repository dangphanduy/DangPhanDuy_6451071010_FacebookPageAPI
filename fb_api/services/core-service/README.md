# Kết nối Facebook Comment Thật — Hướng dẫn từng bước

## Tại sao comment thật chưa hoạt động?

| Vấn đề | Nguyên nhân | Đã sửa |
|---|---|---|
| Core service không nhận comment | Webhook chưa kết nối Facebook | ✅ Thêm ngrok tự động |
| `hideComment` không hoạt động | API dùng v19.0, token là v25.0 | ✅ Cập nhật v25.0 |
| Token chưa có trong env | `.env` để placeholder | ✅ Token đã điền sẵn |

---

## Bước 1 — Khởi động Kafka

```powershell
cd fb_api
docker-compose up -d kafka kafka-ui
```

Chờ ~15 giây cho Kafka sẵn sàng.

---

## Bước 2 — Khởi động Webhook Service (sẽ tự tạo ngrok URL)

Mở **Terminal 1**:

```powershell
cd fb_api/services/webhook-service
node server.js
```

Kết quả mong đợi — **copy URL này**:

```
╔══════════════════════════════════════════╗
║        WEBHOOK SERVICE — Started         ║
╚══════════════════════════════════════════╝
═══════════════════════════════════════════════════════
🌐 NGROK PUBLIC URL (dùng để cấu hình Facebook Webhook):
   Callback URL  : https://xxxx-xxx.ngrok-free.app/webhook
   Verify Token  : 123456
═══════════════════════════════════════════════════════
```

> Nếu ngrok báo lỗi, chạy thủ công: `npx ngrok http 3001` và copy URL `/webhook`

---

## Bước 3 — Cấu hình Facebook Developer Console

1. Vào **https://developers.facebook.com** → chọn App của bạn
2. **Webhooks** → **Edit** (hoặc Add Subscription)
3. Điền:
   - **Callback URL**: `https://xxxx.ngrok-free.app/webhook` *(URL lấy ở Bước 2)*
   - **Verify Token**: `123456`
4. Nhấn **Verify and Save** → Terminal 1 sẽ in: `✅ Webhook verified bởi Facebook`
5. Tích chọn subscription field: **`feed`** (để nhận comment events)
6. Nhấn **Subscribe**

---

## Bước 4 — Khởi động Core Service

Mở **Terminal 2**:

```powershell
cd fb_api/services/core-service
node server.js
```

Kết quả mong đợi:
```
[Server] HTTP port    : 3002
[Server] ✅ HTTP server đang chạy tại http://localhost:3002
[Server] ✅ Kafka consumer đã kết nối.
[Server] ✅ Đang lắng nghe topic: raw_events
```

---

## Bước 5 — Test với comment thật

Vào Facebook Page của bạn và đăng bình luận. Quan sát **Terminal 2**:

### Bình luận bình thường:
```
💬 Comment từ Đặng Phan Duy (USER_ID): "Sản phẩm tốt quá!"
🔎 Spam: isSpam=false, level=none
📨 Gemini: {"intent":"compliment","sentiment":"positive"}
📊 action: none
```

### Bình luận "b" lặp 3 lần (như trong ảnh của bạn):
```
💬 Comment: "b"
🔎 Spam: isSpam=true, level=repeat
⛔ userId=USER_ID đã bị blacklist
📊 action: hide_and_blacklist | hidden: true
```

→ Trên Facebook sẽ thấy comment tự động bị ẩn!

---

## Kiểm tra kết quả

```powershell
# Xem thống kê xử lý
curl http://localhost:3002/status

# Xem hàng chờ review (comment scam)
curl http://localhost:3002/queue

# Xem blacklist
type fb_api\services\core-service\data\blacklist.json
```

---

## Xử lý lỗi thường gặp

| Lỗi | Cách sửa |
|---|---|
| `hideComment` trả về `false` | Kiểm tra token có quyền `pages_manage_engagement` |
| Webhook không nhận được event | Kiểm tra subscription field `feed` đã được tick |
| Ngrok URL thay đổi sau khi restart | Phải cập nhật lại URL trong Facebook Developer Console |
| `Kafka not connected` | Chờ thêm 10–15 giây sau `docker-compose up` |

---

## Quyền token cần thiết

Token trong `.env` phải có các quyền:
- ✅ `pages_read_engagement`
- ✅ `pages_manage_engagement` ← **bắt buộc để ẩn comment**
- ✅ `pages_show_list`

Kiểm tra tại: https://developers.facebook.com/tools/explorer/
