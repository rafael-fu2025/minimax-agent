import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forward chat requests to the Express backend during dev.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});