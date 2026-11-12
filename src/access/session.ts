import { auth, currentUser } from '@clerk/nextjs/server';

export async function clerkId() {
  return (await auth()).userId;
}

export async function verifiedIdentity() {
  const user = await currentUser();
  if (!user) return null;
  return {
    clerkId: user.id,
    verifiedEmails: user.emailAddresses
      .filter(address => address.verification?.status === 'verified')
      .map(address => address.emailAddress),
  };
}
