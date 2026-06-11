"use strict";

class PTError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = "PTError";
    this.code = code || "UNKNOWN";
    // true면 jobQueue가 재시도 없이 즉시 실패 처리
    this.nonRetryable = options.nonRetryable === true;
  }
}

class PTApiError extends PTError {
  constructor(message, status) {
    super(message, "API_ERROR");
    this.name = "PTApiError";
    this.status = status;
  }
}

class PTRateLimitError extends PTApiError {
  constructor(retryAfterMs) {
    super("Rate limit 초과", 429);
    this.name = "PTRateLimitError";
    this.retryAfterMs = retryAfterMs || 10000;
  }
}

class PTExtractionError extends PTError {
  constructor(message) {
    super(message, "EXTRACTION_ERROR");
    this.name = "PTExtractionError";
  }
}
