export async function youtubeApiErrorDetails(response) {
  const body = await response.json().catch(() => null);
  const error = body?.error;
  const safeCode = value => typeof value === 'string' && /^[a-z0-9_]{1,64}$/i.test(value) ? value : null;
  return {
    status: response.status,
    providerStatus: safeCode(error?.status),
    reason: safeCode(error?.details?.find?.(detail => detail?.reason)?.reason)
      ?? safeCode(error?.errors?.[0]?.reason),
  };
}
