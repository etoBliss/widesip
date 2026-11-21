import type { NextConfig } from "next";
const apiInternal=process.env.API_INTERNAL_URL;
const nextConfig: NextConfig = {
  transpilePackages: ["@widesip/validation"],
  async rewrites() {
    if (!apiInternal) return [];
    return [
      { source: "/api/:path*", destination: `${apiInternal}/api/:path*` },
      { source: "/v1/:path*", destination: `${apiInternal}/v1/:path*` },
    ];
  },
  async headers() {
    const headers=[
      {key:"X-Content-Type-Options",value:"nosniff"},
      {key:"X-Frame-Options",value:"DENY"},
      {key:"Referrer-Policy",value:"strict-origin-when-cross-origin"},
      {key:"Permissions-Policy",value:"camera=(), microphone=(), geolocation=()"},
    ];
    if(process.env.NODE_ENV==="production") headers.push({key:"Strict-Transport-Security",value:"max-age=31536000"});
    return [{source:"/:path*",headers}];
  },
};
export default nextConfig;
