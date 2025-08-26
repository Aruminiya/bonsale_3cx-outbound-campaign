// 加入台灣時間 (UTC+8) 的 log function
export function getTaiwanTimestamp() {
  return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

export function logWithTimestamp(...args: unknown[]) {
  const now = getTaiwanTimestamp();
  console.log(`[${now}]`, ...args);
}
export function warnWithTimestamp(...args: unknown[]) {
  const now = getTaiwanTimestamp();
  console.warn(`[${now}]`, ...args);
}
export function errorWithTimestamp(...args: unknown[]) {
  const now = getTaiwanTimestamp();
  console.error(`[${now}]`, ...args);
}
