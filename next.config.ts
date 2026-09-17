import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Measurement reports are plain HTML files kept OUT of `public/` on purpose:
  // they contain affiliate domains, brand names and contact data, so they are
  // served only through /api/admin/reports/[slug], which checks admin access.
  // Serverless tracing cannot see a runtime `readFile`, so include them here.
  outputFileTracingIncludes: {
    "/api/admin/reports/[slug]": ["./reports/**"],
  },
};

export default nextConfig;
