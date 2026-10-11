// Typed application errors.
// Services throw these; the central error handler turns them into a consistent
// JSON response: { "error": { "code": "...", "message": "...", "details": ... } }.
// Routes therefore never build error responses by hand.

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
export const validationFailed = (details) =>
  new AppError(400, 'VALIDATION_FAILED', 'Request body failed validation', details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message) => new AppError(409, 'CONFLICT', message);
