export function appOrigin() {
  const stage = process.env.APP_STAGE;
  const deployment = process.env.VERCEL_URL;
  const origin = process.env.APP_ORIGIN ?? (stage === 'preview' && deployment ? 'https://' + deployment : undefined);
  if (!origin || new URL(origin).origin !== origin) throw new Error('APP_ORIGIN_INVALID');
  const local = stage === 'development' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!local && !origin.startsWith('https://')) throw new Error('APP_ORIGIN_REQUIRES_HTTPS');
  if (stage === 'production' && (!process.env.CLERK_SECRET_KEY?.startsWith('sk_live_')
      || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_live_'))) {
    throw new Error('PRODUCTION_CLERK_KEYS_REQUIRED');
  }
  return origin;
}
