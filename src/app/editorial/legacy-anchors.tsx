'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// The old single-page /editorial had #videos, #youtube and #team sections. Bookmarks and links to them
// now open the standalone pages. Hashes never reach the server, so this runs in the browser.
const targets: Record<string, string> = {
  '#videos': '/editorial/videos', '#youtube': '/editorial/youtube', '#team': '/editorial/team',
};

export function LegacyAnchors() {
  const router = useRouter();
  useEffect(() => {
    const target = targets[window.location.hash];
    if (target) router.replace(target);
  }, [router]);
  return null;
}
