"use strict";

var PTJobQueue = {
  _jobs: [],
  _running: false,
  _cancelled: false,
  _onProgress: null,   // (doneCount, totalCount, lastChunk) => void
  _onComplete: null,   // (jobs) => void
  _onError: null,      // (error) => void

  MAX_RETRIES: 3,
  RETRY_BASE_MS: 5000,

  // ── 큐 초기화 및 실행 ─────────────────────────────────────────────────────
  async run(jobs, { onProgress, onComplete, onError } = {}) {
    this._jobs = jobs;
    this._running = true;
    this._cancelled = false;
    this._onProgress = onProgress || null;
    this._onComplete = onComplete || null;
    this._onError = onError || null;

    PTLogger.info(`큐 시작: ${jobs.length}개 chunk`);

    try {
      await this._processAll();
    } catch (e) {
      PTLogger.error(`큐 실패: ${e.message}`);
      if (this._onError) this._onError(e);
    } finally {
      this._running = false;
    }
  },

  cancel() {
    this._cancelled = true;
    PTLogger.info("번역 취소 요청");
  },

  isRunning() {
    return this._running;
  },

  // ── 전체 chunk 순차 처리 ──────────────────────────────────────────────────
  async _processAll() {
    const apiKey = PTPrefs.getApiKey();
    if (!apiKey) throw new PTError("API 키가 설정되지 않았습니다.", "NO_API_KEY");

    const total = this._jobs.length;
    let doneCount = this._jobs.filter(j => j.status === "done").length;

    for (const job of this._jobs) {
      if (this._cancelled) {
        PTLogger.info("번역 취소됨");
        break;
      }
      if (job.status === "done") continue; // 이미 완료된 chunk 스킵 (재개)

      job.status = "running";
      let success = false;

      for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
        if (this._cancelled) break;

        try {
          await PTRateLimiter.waitForSlot();
          const isLastChunk = job.chunkIndex === job.totalChunks - 1;
          const result = await PTTranslator.translateChunk(job, apiKey, isLastChunk);
          job.translation = result.translation;
          job.summary = result.summary || "";
          job.status = "done";
          job.error = null;
          success = true;
          break;
        } catch (e) {
          PTLogger.warn(`chunk ${job.chunkId} 시도 ${attempt + 1} 실패: ${e.message}`);

          if (e instanceof PTRateLimitError) {
            const waitMs = e.retryAfterMs || this.RETRY_BASE_MS;
            PTLogger.info(`Rate limit — ${Math.ceil(waitMs / 1000)}초 대기`);
            await this._sleep(waitMs);
          } else if (attempt < this.MAX_RETRIES) {
            const backoff = this.RETRY_BASE_MS * Math.pow(2, attempt);
            PTLogger.info(`재시도 대기: ${Math.ceil(backoff / 1000)}초`);
            await this._sleep(backoff);
          } else {
            job.status = "failed";
            job.error = e.message;
            PTLogger.error(`chunk ${job.chunkId} 최종 실패: ${e.message}`);
          }
        }
      }

      if (job.status === "done") doneCount++;

      // 진행률 콜백
      if (this._onProgress) {
        this._onProgress(doneCount, total, job);
      }

      // partial save: 섹션이 바뀔 때마다 중간 저장
      // (storage 모듈이 등록된 경우)
      if (success && this._onProgress) {
        // 다음 chunk가 다른 섹션이면 저장 시그널
        const nextJob = this._jobs[this._jobs.indexOf(job) + 1];
        if (!nextJob || nextJob.sectionId !== job.sectionId) {
          if (this._onProgress) {
            this._onProgress(doneCount, total, job, true /* sectionBoundary */);
          }
        }
      }
    }

    PTLogger.info(`큐 완료: ${doneCount}/${total} chunk 성공`);
    if (this._onComplete) this._onComplete(this._jobs);
  },

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  },
};
