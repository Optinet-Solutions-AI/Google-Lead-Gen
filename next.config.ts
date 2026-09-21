import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Measurement reports are plain HTML files kept OUT of `public/` on purpose:
  // they contain affiliate domains, brand names and contact data, so they are
  // served only through /api/admin/reports/[slug], which checks admin access.
  // Serverless tracing cannot see a runtime `readFile`, so include them here.
  outputFileTracingIncludes: {
    "/api/admin/reports/[slug]": ["./reports/**"],
  },

  experimental: {
    // Every dashboard page is force-dynamic, and Next defaults dynamic
    // segments to a 0s client cache — so going Scrape -> Leads -> Scrape
    // re-renders on the server all three times. These keep a just-visited
    // page instant on return while still being short enough that queue
    // status does not look stale (the scrape list also auto-refreshes).
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
};

export default nextConfig;
