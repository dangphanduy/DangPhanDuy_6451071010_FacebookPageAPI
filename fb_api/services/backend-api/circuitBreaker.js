/**
 * circuitBreaker.js
 * Quản lý trạng thái đóng/mở mạch khi gọi Facebook Graph API.
 * Tránh spam request dồn dập vào API lỗi.
 */

// Định nghĩa các trạng thái mạch
const STATES = {
  CLOSED: "CLOSED",       // Bình thường, mạch đóng
  OPEN: "OPEN",           // Lỗi liên tục, mạch mở (chặn hoàn toàn)
  HALF_OPEN: "HALF_OPEN", // Đang hé thử nghiệm lại mạch
};

// Cấu hình Circuit Breaker
const FAILURE_THRESHOLD = 5;      // Đạt 5 lỗi liên tiếp thì mở mạch
const COOLDOWN_PERIOD_MS = 30000; // Thời gian chờ mở mạch (30 giây)

let state = STATES.CLOSED;
let consecutiveFailures = 0;
let lastStateChangedAt = Date.now();
let nextAttemptTime = 0;

/**
 * Lấy trạng thái Circuit Breaker hiện tại dạng chuỗi.
 */
function getBreakerState() {
  // Tự động kiểm tra thời gian cooldown để chuyển OPEN -> HALF_OPEN nếu cần
  if (state === STATES.OPEN && Date.now() >= nextAttemptTime) {
    state = STATES.HALF_OPEN;
    lastStateChangedAt = Date.now();
    console.log(`[CircuitBreaker] ℹ️ Cooldown 30s kết thúc. Mạch tự động chuyển sang HALF_OPEN.`);
  }
  return state;
}

/**
 * Lấy trạng thái dạng số để xuất Prometheus Metrics.
 * 0: CLOSED, 1: OPEN, 2: HALF_OPEN
 */
function getNumericState() {
  const s = getBreakerState();
  if (s === STATES.CLOSED) return 0;
  if (s === STATES.OPEN) return 1;
  return 2;
}

/**
 * Đăng ký một lệnh gọi thành công.
 */
function recordSuccess() {
  if (state === STATES.HALF_OPEN) {
    console.log("[CircuitBreaker] 🎉 Thử nghiệm thành công ở HALF_OPEN. Đóng mạch (CLOSED).");
    state = STATES.CLOSED;
    lastStateChangedAt = Date.now();
  }
  consecutiveFailures = 0;
}

/**
 * Đăng ký một lệnh gọi thất bại.
 */
function recordFailure() {
  consecutiveFailures++;
  console.warn(`[CircuitBreaker] ⚠️ Ghi nhận lỗi lần ${consecutiveFailures}/${FAILURE_THRESHOLD}`);

  const currentState = getBreakerState();
  if (currentState === STATES.HALF_OPEN) {
    console.error("[CircuitBreaker] 🚨 Thử nghiệm thất bại ở HALF_OPEN. Mở mạch (OPEN) lại ngay lập tức.");
    state = STATES.OPEN;
    lastStateChangedAt = Date.now();
    nextAttemptTime = Date.now() + COOLDOWN_PERIOD_MS;
  } else if (state === STATES.CLOSED && consecutiveFailures >= FAILURE_THRESHOLD) {
    console.error(`[CircuitBreaker] 🚨 Đạt ngưỡng lỗi liên tiếp (${FAILURE_THRESHOLD} lần). Mở mạch (OPEN) trong 30 giây.`);
    state = STATES.OPEN;
    lastStateChangedAt = Date.now();
    nextAttemptTime = Date.now() + COOLDOWN_PERIOD_MS;
  }
}

/**
 * Bọc và thực thi hàm bất đồng bộ qua Circuit Breaker.
 * @param {Function} asyncFunction - Hàm bất đồng bộ thực hiện API call
 * @returns {Promise<any>}
 */
async function executeWithBreaker(asyncFunction) {
  const currentState = getBreakerState();

  if (currentState === STATES.OPEN) {
    throw new Error("Facebook API Circuit Breaker is OPEN (Fast-fail)");
  }

  try {
    const result = await asyncFunction();
    if (result === false) {
      // Coi như một lỗi logic (Facebook API trả về thất bại)
      recordFailure();
    } else {
      recordSuccess();
    }
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

module.exports = {
  executeWithBreaker,
  getBreakerState,
  getNumericState,
  recordSuccess,
  recordFailure,
  STATES,
};
