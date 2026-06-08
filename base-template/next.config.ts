import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  images: { remotePatterns: [{ protocol: 'https', hostname: 'picsum.photos' }] },
  async headers() {
    return [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors *' }, { key: 'X-Frame-Options', value: 'SAMEORIGIN' }] }];
  }
};

export default nextConfig;