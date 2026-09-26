import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
