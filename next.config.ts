import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Three.js + canvas need to run in browser only
  experimental: {
    optimizePackageImports: ['three', 'lucide-react'],
  },
};

export default nextConfig;
