/**
 * circuitBreaker.js
 * Cơ chế Circuit Breaker bảo vệ hệ thống khi Facebook API bị lỗi liên tiếp.
 * 3 trạng thái:
 *   - CLOSED: Hoạt động bình thường. Lỗi liên tiếp >= 10 ➔ OPEN.
 *   - OPEN: Mở mạch (fail-fast). Tự động từ chối gọi thật trong 30s ➔ HALF_OPEN.
 *   - HALF_OPEN: Thử nghiệm 1 request. Thành công ➔ CLOSED. Thất bại ➔ OPEN.
 */

const State = {
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
};

let currentState = State.CLOSED;
let consecutiveFailures = 0;
const FAILURE_THRESHOLD = 10;
const RESET_TIMEOUT_MS = 30 * 1000; // 30 giây
let nextAttemptTime = 0;

/**
 * Lấy trạng thái hiện tại (tự động cập nhật từ OPEN sang HALF_OPEN khi quá hạn reset)
 */
function getState() {
  const now = Date.now();
  
  if (currentState === State.OPEN && now >= nextAttemptTime) {
    currentState = State.HALF_OPEN;
    console.log(`[CircuitBreaker] 🔄 Mạch tự động chuyển từ OPEN sang HALF_OPEN (Thử nghiệm).`);
  }
  
  return currentState;
}

/**
 * Ghi nhận một lượt gọi API thành công.
 */
function recordSuccess() {
  consecutiveFailures = 0;
  if (currentState !== State.CLOSED) {
    currentState = State.CLOSED;
    console.log(`[CircuitBreaker] ✅ Khôi phục mạch đóng CLOSED (Bình thường).`);
  }
}

/**
 * Ghi nhận một lượt gọi API thất bại.
 */
function recordFailure() {
  consecutiveFailures++;
  console.warn(`[CircuitBreaker] ❌ Thất bại liên tiếp: ${consecutiveFailures}/${FAILURE_THRESHOLD}`);
  
  if (consecutiveFailures >= FAILURE_THRESHOLD || currentState === State.HALF_OPEN) {
    currentState = State.OPEN;
    nextAttemptTime = Date.now() + RESET_TIMEOUT_MS;
    console.error(`[CircuitBreaker] 🚨 Mạch bị BẺ OPEN (Ngắt mạch). Tự động từ chối gọi thực tế trong ${RESET_TIMEOUT_MS / 1000}s.`);
  }
}

/**
 * Hàm bọc thực thi hành động Facebook API với Circuit Breaker.
 * @param {Function} actionFn - hàm bất đồng bộ thực hiện cuộc gọi
 * @returns {Promise<any>}
 */
async function executeWithBreaker(actionFn) {
  const state = getState();
  
  if (state === State.OPEN) {
    // Fail-fast: từ chối gọi thật và ném lỗi ngay
    throw new Error("Circuit Breaker is OPEN. Facebook API calls are temporarily blocked (fail-fast).");
  }

  try {
    const result = await actionFn();
    
    // Nếu hàm trả về false (ẩn comment thất bại)
    if (result === false) {
      recordFailure();
      return false;
    }
    
    recordSuccess();
    return true;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Lấy giá trị số của trạng thái phục vụ cho Prometheus metrics
 */
function getNumericState() {
  const state = getState();
  if (state === State.CLOSED) return 0;
  if (state === State.OPEN) return 1;
  return 2; // HALF_OPEN
}

module.exports = {
  executeWithBreaker,
  getState,
  getNumericState,
  State,
};
