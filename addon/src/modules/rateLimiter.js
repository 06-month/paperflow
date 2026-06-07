"use strict";

var PTRateLimiter = {
  // Gemini 3.1 Flash-Lite 무료 티어 기준
  RPM_LIMIT: 14,          // 15 중 14만 사용 (여유분)
  RPD_LIMIT: 1490,        // 1500 중 1490 사용

  _requestTimestamps: [], // 최근 1분간 요청 시각 기록
  _dailyCount: 0,
  _dailyResetTime: 0,

  init() {
    this._dailyCount = 0;
    this._dailyResetTime = Date.now() + 24 * 60 * 60 * 1000;
  },

  // ── 요청 전 대기 (필요 시) ─────────────────────────────────────────────────
  async waitForSlot() {
    // 일일 한도 초과 체크
    this._resetDailyIfNeeded();
    if (this._dailyCount >= this.RPD_LIMIT) {
      throw new PTRateLimitError(
        (this._dailyResetTime - Date.now()) || 86400000
      );
    }

    // RPM 체크: 최근 60초 내 요청 수
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    this._requestTimestamps = this._requestTimestamps.filter(t => t > oneMinuteAgo);

    if (this._requestTimestamps.length >= this.RPM_LIMIT) {
      // 가장 오래된 요청이 1분 지날 때까지 대기
      const oldestInWindow = this._requestTimestamps[0];
      const waitMs = (oldestInWindow + 60000) - now + 100; // +100ms 여유
      if (waitMs > 0) {
        PTLogger.info(`RPM 대기: ${Math.ceil(waitMs / 1000)}초`);
        await this._sleep(waitMs);
      }
    }

    // 슬롯 기록
    this._requestTimestamps.push(Date.now());
    this._dailyCount++;
    PTLogger.info(`요청 슬롯 확보 (RPM: ${this._requestTimestamps.length}/${this.RPM_LIMIT}, RPD: ${this._dailyCount}/${this.RPD_LIMIT})`);
  },

  _resetDailyIfNeeded() {
    if (Date.now() > this._dailyResetTime) {
      this._dailyCount = 0;
      this._dailyResetTime = Date.now() + 24 * 60 * 60 * 1000;
      PTLogger.info("일일 카운터 리셋");
    }
  },

  getRemainingToday() {
    this._resetDailyIfNeeded();
    return this.RPD_LIMIT - this._dailyCount;
  },

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  },
};
