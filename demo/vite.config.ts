import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    allowedHosts: ["localhost", "127.0.0.1", "0.0.0.0", "deggen.ngrok.app"],
  },
  resolve: {
    alias: {
      webrtpay: path.resolve(__dirname, "../src"),
    },
  },
  optimizeDeps: {
    exclude: ["webrtpay"],
  },
  worker: {
    format: "es",
  },
});
