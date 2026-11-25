import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app has no next/image; with this the image optimizer (/_next/image) answers 404 instead of being reachable.
  images: { unoptimized: true },
};

export default nextConfig;
