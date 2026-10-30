import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:5177";

export default defineConfig({
	testDir: ".",
	testMatch: /browser-shell\.spec\.ts/,
	fullyParallel: false,
	retries: 0,
	timeout: 45_000,
	reporter: "list",
	outputDir: path.join(tmpdir(), "ryu-browser-shell-playwright-results"),
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		viewport: { width: 1440, height: 900 },
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
			},
		},
	],
	webServer: {
		command: "bunx vite --config vite.browser-shell.config.ts",
		url: `${BASE_URL}/index.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
