// One log line for every error that ends as a generic 500, so a requestId the editor reports can be
// found in the Vercel logs. Messages are redacted: no URL credentials, query strings or bearer tokens.

const CODE = /^[A-Z][A-Z0-9_]{1,99}$/;

export function redactErrorText(value) {
  return String(value ?? '')
    .replace(/([a-z][\w+.-]*:\/\/)[^@\s/]+@/gi, '$1***@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?…')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(/\b(sk|xai|ya29|AIza)[-_A-Za-z0-9.]{8,}/g, '***')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

export function logUnexpectedError(scope, requestId, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('API_UNEXPECTED_ERROR', {
    scope, requestId,
    name: error instanceof Error ? error.name : typeof error,
    code: CODE.test(message) ? message : null,
    message: CODE.test(message) ? null : redactErrorText(message),
    cause: error?.cause?.code ?? null,
  });
}
