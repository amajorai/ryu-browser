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
		// Keep boundary codecs inside the sandboxed preload; its require cannot load
		// arbitrary Node packages. The page and shell sandbox settings stay intact.
		plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
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
		// Pin a port distinct from desktop (5173), island (5174), and webapp (5175).
		server: {
			port: 5176,
			strictPort: true,
		},
		build: {
			rollupOptions: {
				input: resolve(import.meta.dirname, "src/renderer/index.html"),
			},
		},
	},
});
