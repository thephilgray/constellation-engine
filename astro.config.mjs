// @ts-check
import { defineConfig } from 'astro/config';
import aws from "astro-sst";
import tailwindcss from '@tailwindcss/vite';

import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  adapter: aws(),
  output: "server",
  vite: {
    plugins: [tailwindcss()],
    define: {
      // "process.env": {}, // Handled by alias now
    },
    resolve: {
      alias: {
        "fs/promises": "/src/mocks/fs.ts",
        fs: "/src/mocks/fs.ts",
        crypto: "/src/mocks/crypto.ts",
        path: "/src/mocks/path.ts",
        os: "/src/mocks/os.ts",
        process: "/src/mocks/process.ts",
      }
    },
    optimizeDeps: {
      exclude: ["sst"],
    },
  },

  integrations: [react()]
});