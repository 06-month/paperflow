"use strict";

var PTRateLimiter = {
  // Gemini Flash-Lite 무료 티어 기준
  RPM_LIMIT: 14,          // 15 중 14만 사용 (여유분)
  RPD_LIMIT: 1490,        // 1500 중 1490 사용

  _requestTimestamps: [], // 최근 1분간 요청 시각 기록
  _dailyCount: 0,
  _dailyResetTime: 0,
  _initialized: false,

  init() {
    this._ensureInit();
  },

  // init() 없이 waitForSlot이 먼저 불려도 (예: panel 창에서 단독 로드)
  // 영속화된 카운터를 0으로 덮어쓰지 않도록 lazy-load 한다
  _ensureInit() {
    if (this._initialized) return;
    this._initialized = true;
    // 일일 카운터를 pref에 영속화 — Zotero 재시작으로 쿼터 추적이 리셋되지 않도록
    this._loadState();
    this._resetDailyIfNeeded();
  },

  // ── 요청 전 대기 (필요 시) ─────────────────────────────────────────────────
  async waitForSlot() {
    this._ensureInit();
    // 일일 한도 초과 체크
    this._resetDailyIfNeeded();
    if (this._dailyCount >= this.RPD_LIMIT) {
      throw new PTRateLimitError(
        Math.max(this._dailyResetTime - Date.now(), 60000)
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
    this._saveState();
    PTLogger.info(`요청 슬롯 확보 (RPM: ${this._requestTimestamps.length}/${this.RPM_LIMIT}, RPD: ${this._dailyCount}/${this.RPD_LIMIT})`);
  },

  _resetDailyIfNeeded() {
    if (Date.now() > this._dailyResetTime) {
      this._dailyCount = 0;
      this._dailyResetTime = this._nextPacificMidnight();
      this._saveState();
      PTLogger.info("일일 카운터 리셋");
    }
  },

  // Google 무료 티어 쿼터는 태평양 시간 자정에 리셋된다
  _nextPacificMidnight() {
    try {
      const now = new Date();
      const ptNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      const offsetMs = now.getTime() - ptNow.getTime();
      const ptMidnight = new Date(ptNow);
      ptMidnight.setHours(24, 0, 0, 0);
      return ptMidnight.getTime() + offsetMs;
    } catch (e) {
      PTLogger.warn(`태평양 자정 계산 실패 — 24시간 후로 대체: ${e.message}`);
      return Date.now() + 24 * 60 * 60 * 1000;
    }
  },

  getRemainingToday() {
    this._ensureInit();
    this._resetDailyIfNeeded();
    return this.RPD_LIMIT - this._dailyCount;
  },

  _loadState() {
    try {
      const raw = PTPrefs.get("rateLimiterState");
      const state = raw ? JSON.parse(raw) : null;
      this._dailyCount = Number(state?.dailyCount) || 0;
      this._dailyResetTime = Number(state?.dailyResetTime) || 0;
    } catch (e) {
      PTLogger.warn(`rate limiter 상태 로드 실패: ${e.message}`);
      this._dailyCount = 0;
      this._dailyResetTime = 0;
    }
  },

  _saveState() {
    try {
      PTPrefs.set("rateLimiterState", JSON.stringify({
        dailyCount: this._dailyCount,
        dailyResetTime: this._dailyResetTime,
      }));
    } catch (e) {
      PTLogger.warn(`rate limiter 상태 저장 실패: ${e.message}`);
    }
  },

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  },
};
