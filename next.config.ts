import type { NextConfig } from 'next';
import { withWorkflow } from "workflow/next";

const config: NextConfig = {
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    }, {
      source: '/:path(editorial|invite|api)/:rest*',
      headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
    }];
  },
};

export default withWorkflow(config);
