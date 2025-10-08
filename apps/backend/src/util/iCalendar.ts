const { rrulestr } = require('rrule');

function iCalendarUtc8ToUtc(iCalendar: string): string {
  /**
   * 將 UTC+8 時間字串轉換為 UTC 時間字串
   * @param {string} rruleString - 包含 UTC+8 時間的 RRule 字串
   * @returns {string} 轉換為 UTC 時間的 RRule 字串
   */
  return iCalendar.replace(/(DTSTART|UNTIL):(\d{8}T\d{6})Z/g, (match, p1, p2) => {
    // 解析 UTC+8 時間
    const year = parseInt(p2.slice(0, 4));
    const month = parseInt(p2.slice(4, 6)) - 1; // 月份從 0 開始
    const day = parseInt(p2.slice(6, 8));
    const hour = parseInt(p2.slice(9, 11));
    const minute = parseInt(p2.slice(11, 13));
    const second = parseInt(p2.slice(13, 15));
    
    // 直接創建 UTC 時間，然後減去 8 小時
    const utcDate = new Date(Date.UTC(year, month, day, hour - 8, minute, second));
    
    // 格式化為 RRule 需要的字串格式
    const utcString = utcDate.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    
    // console.log(`轉換: ${p2} (UTC+8) → ${utcString} (UTC)`);
    
    return `${p1}:${utcString}`;
  });
}

// console.log('Original RRule:', TEST);
// console.log('Converted RRule:', iCalendarUtc8ToUtc(TEST));

// 檢查今天是否符合檔期
export function isTodayInSchedule(rruleString: string): boolean {
  const rule = rrulestr(iCalendarUtc8ToUtc(rruleString));

  // 檢查今天是否符合
  const now = new Date();
  const todayUTC = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const tomorrowUTC = new Date(todayUTC.getTime() + 24 * 60 * 60 * 1000);

  // console.log('查詢範圍 (UTC):');
  // console.log('開始:', todayUTC.toISOString());
  // console.log('結束:', tomorrowUTC.toISOString());

  const occurrences = rule.between(todayUTC, tomorrowUTC, true);

  if (occurrences.length > 0) {
    console.log('今天有符合的事件:', occurrences);
    return true;
  } else {
    console.log('今天沒有符合的事件');
    return false;
  }
}

