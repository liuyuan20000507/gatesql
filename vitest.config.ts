import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // 与 tsconfig 的 paths 保持一致，让测试里的 "@/lib/..." 能解析
      "@": path.resolve(process.cwd(), "src"),
    },
  },
});