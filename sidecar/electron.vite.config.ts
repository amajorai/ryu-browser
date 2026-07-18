import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: resolve(import.meta.dirname, "src/main/index.ts"),
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: resolve(import.meta.dirname, "src/preload/index.ts"),
				output: {
					format: "cjs",
					entryFileNames: "index.cjs",
				},
			},
		},
	},
	renderer: {
		root: resolve(import.meta.dirname, "src/renderer"),
		// Pin a port distinct from desktop (5173) and island (5174).
		server: {
			port: 5175,
			strictPort: true,
		},
		build: {
			rollupOptions: {
				input: resolve(import.meta.dirname, "src/renderer/index.html"),
			},
		},
	},
});
