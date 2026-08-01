"use strict";

var PTJobQueue = {
  _jobs: [],
  _running: false,
  _cancelled: false,
  _onProgress: null,    // (doneCount, totalCount, lastChunk) => void
  _onSectionEnd: null,  // (jobs, lastJob) => void — 섹션 경계마다 부분 저장용
  _onComplete: null,    // (jobs) => void
  _onError: null,       // (error) => void
  _completedSections: null,

  MAX_RETRIES: 3,
  RETRY_BASE_MS: 5000,

  // ── 큐 초기화 및 실행 ─────────────────────────────────────────────────────
  async run(jobs, { onProgress, onSectionEnd, onComplete, onError } = {}) {
    this._jobs = jobs;
    this._running = true;
    this._cancelled = false;
    this._onProgress = onProgress || null;
    this._onSectionEnd = onSectionEnd || null;
    this._onComplete = onComplete || null;
    this._onError = onError || null;
    this._completedSections = new Set();

    const concurrency = Math.max(1, Math.min(
      Number(PTPrefs.getParallelRequests?.() || 6),
      Math.max(1, jobs.filter(job => job.status !== "done").length)
    ));
    PTLogger.info(`큐 시작: ${jobs.length}개 chunk, 병렬 ${concurrency}개`);

    try {
      await this._processAll();
    } catch (e) {
      if (e?.code !== "CANCELLED") {
        PTLogger.error(`큐 실패: ${e.message}`);
      }
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

  // ── 전체 chunk 병렬 처리 ──────────────────────────────────────────────────
  async _processAll() {
    const apiKey = PTPrefs.getApiKey();
    if (!apiKey) throw new PTError("API 키가 설정되지 않았습니다.", "NO_API_KEY");

    const total = this._jobs.length;
    let doneCount = this._jobs.filter(j => j.status === "done").length;
    const pendingIndexes = this._jobs
      .map((job, index) => job.status === "done" ? -1 : index)
      .filter(index => index >= 0);
    let cursor = 0;
    const concurrency = Math.max(1, Math.min(
      Number(PTPrefs.getParallelRequests?.() || 6),
      Math.max(1, pendingIndexes.length)
    ));

    const worker = async () => {
      while (!this._cancelled) {
        const queueIndex = cursor++;
        if (queueIndex >= pendingIndexes.length) return;
        const job = this._jobs[pendingIndexes[queueIndex]];
        const success = await this._processJob(job, apiKey);
        if (job.status === "done") doneCount++;

        if (this._onProgress) this._onProgress(doneCount, total, job);
        if (success) this._signalSectionEnd(job);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (this._cancelled) {
      PTLogger.info(`큐 취소됨: ${doneCount}/${total} chunk 완료`);
      throw new PTError("번역이 취소되었습니다.", "CANCELLED");
    }

    PTLogger.info(`큐 완료: ${doneCount}/${total} chunk 성공`);
    if (this._onComplete) {
      await this._onComplete(this._jobs);
    }
  },

  async _processJob(job, apiKey) {
    job.status = "running";
    let success = false;

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      if (this._cancelled) break;
      try {
        await PTRateLimiter.waitForSlot();
        if (this._cancelled) break;
        const isLastChunk = job.chunkIndex === job.totalChunks - 1;
        const result = await PTTranslator.translateChunk(job, apiKey, isLastChunk);
        job.translation = result.translation;
        job.blockTranslations = result.blockTranslations || job.blockTranslations || {};
        job.summary = result.summary || "";
        job.status = "done";
        job.error = null;
        job.retries = attempt;
        success = true;
        break;
      } catch (e) {
        PTLogger.warn(`chunk ${job.chunkId} 시도 ${attempt + 1} 실패: ${e.message}`);
        if (e?.nonRetryable) {
          job.status = "failed";
          job.error = e.message;
          PTLogger.error(`chunk ${job.chunkId} 재시도 불가 오류로 실패: ${e.message}`);
          break;
        }
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

    if (job.status === "running") job.status = "pending";
    return success;
  },

  _signalSectionEnd(lastJob) {
    if (!this._onSectionEnd || !lastJob?.sectionId || this._completedSections.has(lastJob.sectionId)) return;
    const sectionJobs = this._jobs.filter(job => job.sectionId === lastJob.sectionId);
    const terminal = sectionJobs.every(job => ["done", "failed"].includes(job.status));
    if (!terminal || !sectionJobs.some(job => job.status === "done")) return;
    this._completedSections.add(lastJob.sectionId);
    try {
      this._onSectionEnd(this._jobs, lastJob);
    } catch (e) {
      PTLogger.warn(`섹션 경계 저장 콜백 실패: ${e.message}`);
    }
  },

  _sleep(ms) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (this._cancelled || Date.now() - started >= ms) {
          resolve();
          return;
        }
        setTimeout(tick, Math.min(250, ms - (Date.now() - started)));
      };
      tick();
    });
  },
};
