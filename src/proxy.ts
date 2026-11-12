import { clerkMiddleware } from '@clerk/nextjs/server';
import { appOrigin } from './access/clerk-config';

export default clerkMiddleware(() => {}, () => ({ authorizedParties: [appOrigin()] }));

export const config = {
  matcher: ['/((?!_next|favicon.ico).*)'],
};
