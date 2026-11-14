import { clerkMiddleware } from '@clerk/nextjs/server';
import { appOrigin } from './access/clerk-config';

export default clerkMiddleware(() => {}, () => ({ authorizedParties: [appOrigin()] }));

export const config = {
  matcher: ['/((?!_next|favicon.ico|api/internal/dispatch|api/internal/captions-reader|\\.well-known/workflow).*)'],
};
