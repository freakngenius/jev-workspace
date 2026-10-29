import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A lockfile in a parent folder would otherwise make Turbopack pick the wrong root.
  turbopack: { root: import.meta.dirname },
  serverExternalPackages: ["unpdf"],
  // A check build can go elsewhere so it never swaps files under a running `npm run app`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
