// Standard error envelope. See docs/AUTH_API_SPEC.md §1 and
// docs/BACKEND_INTEGRATION_PLAN.md §7.
//
// Routes throw HttpError subclasses; a Fastify error handler renders them.

/**
 * @typedef {Object} ErrorDetail
 * @property {string} code
 * @property {string} message
 * @property {object=} detail
 */

/**
 * @typedef {Object} ErrorBody
 * @property {ErrorDetail} error
 */

export class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code
   * @param {string} message
   * @param {object=} detail
   */
  constructor(statusCode, code, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** @returns {ErrorBody} */
  toBody() {
    const body = { error: { code: this.code, message: this.message } };
    if (this.detail !== undefined) body.error.detail = this.detail;
    return body;
  }
}

export class BadRequest extends HttpError {
  constructor(code, message, detail) {
    super(400, code, message, detail);
    this.name = 'BadRequest';
  }
}

export class Unauthorized extends HttpError {
  constructor(code = 'unauthorized', message = 'Authentication required.') {
    super(401, code, message);
    this.name = 'Unauthorized';
  }
}

export class Forbidden extends HttpError {
  /**
   * @param {string} [code]
   * @param {string} [message]
   * @param {{resource?: string, action?: string, [k: string]: any}=} detail
   */
  constructor(code = 'forbidden', message = 'Forbidden.', detail) {
    super(403, code, message, detail);
    this.name = 'Forbidden';
  }
}

export class NotFound extends HttpError {
  constructor(code = 'not-found', message = 'Resource not found.') {
    super(404, code, message);
    this.name = 'NotFound';
  }
}

export class Conflict extends HttpError {
  constructor(code, message, detail) {
    super(409, code, message, detail);
    this.name = 'Conflict';
  }
}

export class UnprocessableEntity extends HttpError {
  constructor(code, message, detail) {
    super(422, code, message, detail);
    this.name = 'UnprocessableEntity';
  }
}

export class TooManyRequests extends HttpError {
  constructor(code = 'rate-limited', message = 'Rate limit exceeded.', detail) {
    super(429, code, message, detail);
    this.name = 'TooManyRequests';
  }
}

export class NotImplemented extends HttpError {
  constructor(code = 'not-implemented', message = 'Not implemented yet.') {
    super(501, code, message);
    this.name = 'NotImplemented';
  }
}
