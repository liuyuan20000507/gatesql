import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 自包含构建：.next/standalone 输出裁剪后的 server.js 与必需 node_modules，
  // Docker 运行时镜像只需要它（官方文档约定，见 node_modules/next/dist/docs output.md）
  output: "standalone",
};

export default nextConfig;
