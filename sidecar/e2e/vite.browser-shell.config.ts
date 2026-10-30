import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: path.resolve(HERE, "../src/renderer"),
	server: {
		host: "127.0.0.1",
		port: 5177,
		strictPort: true,
		hmr: false,
	},
});
