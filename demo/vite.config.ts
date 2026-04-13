import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "deggen.ngrok.app",
      "0198-2a02-a315-43da-ae80-4154-a432-ad33-c3a9.ngrok-free.app",
    ],
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
