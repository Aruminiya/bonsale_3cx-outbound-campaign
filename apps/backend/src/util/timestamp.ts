// 加入台灣時間 (UTC+8) 的 log function
export function getTaiwanTimestamp() {
  return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

// 檢查是否為開發環境
const isDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === undefined;

export function logWithTimestamp(...args: unknown[]): void;
export function logWithTimestamp(options: { isForce: boolean }, ...args: unknown[]): void;
export function logWithTimestamp(optionsOrFirstArg: unknown | { isForce: boolean }, ...args: unknown[]) {
  let isForce = false;
  let actualArgs: unknown[];

  // 檢查第一個參數是否為選項對象
  if (typeof optionsOrFirstArg === 'object' && optionsOrFirstArg !== null && 'isForce' in optionsOrFirstArg) {
    isForce = (optionsOrFirstArg as { isForce: boolean }).isForce;
    actualArgs = args;
  } else {
    actualArgs = [optionsOrFirstArg, ...args];
  }

  if (!isDevelopment && !isForce) return;
  const now = getTaiwanTimestamp();
  console.log(`[${now}]`, ...actualArgs);
}

export function warnWithTimestamp(...args: unknown[]): void;
export function warnWithTimestamp(options: { isForce: boolean }, ...args: unknown[]): void;
export function warnWithTimestamp(optionsOrFirstArg: unknown | { isForce: boolean }, ...args: unknown[]) {
  let isForce = false;
  let actualArgs: unknown[];

  // 檢查第一個參數是否為選項對象
  if (typeof optionsOrFirstArg === 'object' && optionsOrFirstArg !== null && 'isForce' in optionsOrFirstArg) {
    isForce = (optionsOrFirstArg as { isForce: boolean }).isForce;
    actualArgs = args;
  } else {
    actualArgs = [optionsOrFirstArg, ...args];
  }

  if (!isDevelopment && !isForce) return;
  const now = getTaiwanTimestamp();
  console.warn(`[${now}]`, ...actualArgs);
}

export function errorWithTimestamp(...args: unknown[]): void;
export function errorWithTimestamp(options: { isForce: boolean }, ...args: unknown[]): void;
export function errorWithTimestamp(optionsOrFirstArg: unknown | { isForce: boolean }, ...args: unknown[]) {
  let isForce = false;
  let actualArgs: unknown[];

  // 檢查第一個參數是否為選項對象
  if (typeof optionsOrFirstArg === 'object' && optionsOrFirstArg !== null && 'isForce' in optionsOrFirstArg) {
    isForce = (optionsOrFirstArg as { isForce: boolean }).isForce;
    actualArgs = args;
  } else {
    actualArgs = [optionsOrFirstArg, ...args];
  }

  if (!isDevelopment && !isForce) return;
  const now = getTaiwanTimestamp();
  console.error(`[${now}]`, ...actualArgs);
}
