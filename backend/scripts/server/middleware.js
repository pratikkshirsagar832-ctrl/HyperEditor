/**
 * HTTP middleware helpers — sendJSON, sendError, sendSuccess, logError.
 * Standardizes all API response formats to { success, data } / { error }.
 */
import { createLogger } from './utils/logger.js';

const log = createLogger('middleware');

export function sendJSON(res, statusCode, data) {
  const body = data?.error
    ? { error: data.error, details: data.details }
    : { success: true, data };
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

export function sendSuccess(res, data) {
  sendJSON(res, 200, data ?? {});
}

export function sendError(res, statusCode, message, details) {
  const body = { error: message };
  if (details) body.details = details;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

export function logError(jobId, message, err) {
  log.error(message, { jobId }, err);
}
