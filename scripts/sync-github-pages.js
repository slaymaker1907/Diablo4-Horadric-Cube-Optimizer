const fs = require("fs");
const path = require("path");
const os = require("os");

const SRC_ROOT = path.join(__dirname, "..");
const DST_ROOT = path.join(os.homedir(), "Documents", "Git", "slaymaker1907.github.io", "d4cubeoptim");

// src filename -> dst filename. index.html gets special frontmatter handling.
const FILE_MAP = {
	"d4cubeoptimv3.html": "index.html",
	"d4cubeoptimv3-worker.js": "d4cubeoptimv3-worker.js",
	"gear-slot-legality.js": "gear-slot-legality.js",
	"ilp.js": "ilp.js",
	"config.js": "config.js",
	// Rust/WASM browser artifacts (committed; no deploy build step required).
	// pkg-no-modules is the build the classic Web Worker actually loads via
	// importScripts (global `wasm_bindgen`); pkg-web is the ES-module build kept
	// for completeness. Both must ship or the live worker's WASM load 404s and
	// silently falls back to the JS solver.
	"rust/pkg-no-modules/d4optimizer.js": "rust/pkg-no-modules/d4optimizer.js",
	"rust/pkg-no-modules/d4optimizer_bg.wasm": "rust/pkg-no-modules/d4optimizer_bg.wasm",
	"rust/pkg-web/d4optimizer.js": "rust/pkg-web/d4optimizer.js",
	"rust/pkg-web/d4optimizer_bg.wasm": "rust/pkg-web/d4optimizer_bg.wasm",
};

// Root-level files that are never deployment candidates regardless of extension.
const EXCLUDED_NAMES = new Set([
	".gitignore",
	"LICENSE",
	...Object.keys(FILE_MAP),
]);

// Patterns that disqualify a file from being a deployment candidate.
const EXCLUDED_PATTERNS = [/\.test\.js$/, /\.md$/];

function stripBom(content) {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function extractJekyllFrontmatter(content) {
	const match = stripBom(content).match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
	return match ? match[1] : null;
}

function syncFiles() {
	console.log(`Syncing to: ${DST_ROOT}\n`);

	for (const [srcName, dstName] of Object.entries(FILE_MAP)) {
		const srcPath = path.join(SRC_ROOT, srcName);
		const dstPath = path.join(DST_ROOT, dstName);

		if (srcName === "d4cubeoptimv3.html") {
			const dstContent = fs.readFileSync(dstPath, "utf8");
			const frontmatter = extractJekyllFrontmatter(dstContent);
			if (!frontmatter) {
				throw new Error(`No Jekyll frontmatter found in ${dstPath} — aborting to avoid data loss.`);
			}
			const srcContent = fs.readFileSync(srcPath, "utf8");
			fs.writeFileSync(dstPath, frontmatter + srcContent, "utf8");
			console.log(`  index.html  (frontmatter preserved)`);
		} else {
			fs.mkdirSync(path.dirname(dstPath), { recursive: true });
			fs.copyFileSync(srcPath, dstPath);
			console.log(`  ${dstName}`);
		}
	}

	// Scan root for files that look like new deployment candidates.
	const candidates = fs.readdirSync(SRC_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.filter((name) => !EXCLUDED_NAMES.has(name))
		.filter((name) => !EXCLUDED_PATTERNS.some((p) => p.test(name)))
		.filter((name) => /\.(js|html|css)$/.test(name));

	if (candidates.length > 0) {
		console.log("\nPotential new deployment candidates (not copied):");
		candidates.forEach((f) => console.log(`  - ${f}`));
		console.log("Add them to FILE_MAP in scripts/sync-github-pages.js if they should be deployed.");
	}

	console.log("\nDone.");
}

syncFiles();
