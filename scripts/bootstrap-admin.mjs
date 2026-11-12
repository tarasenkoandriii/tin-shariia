import { createClerkClient } from '@clerk/backend';
import { database } from '../src/db/runtime.mjs';
import { bootstrapAdmin } from '../src/access/membership.mjs';

const userId = process.argv[2];
if (!userId || !process.env.CLERK_SECRET_KEY) throw new Error('CLERK_USER_AND_SECRET_REQUIRED');
const user = await createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY }).users.getUser(userId);
const email = user.emailAddresses.find(address => address.id === user.primaryEmailAddressId
  && address.verification?.status === 'verified')?.emailAddress;
await bootstrapAdmin(await database(), { clerkId: user.id, verifiedEmail: email });
console.log('Initial administrator created');
