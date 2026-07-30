import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-comment-editor-package-"));
	temporaryDirectories.push(directory);
	return directory;
}

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	return result.stdout;
}

describe("npm package", () => {
	test("ships every runtime module and excludes repository-only files", () => {
		const destination = temporaryDirectory();
		const output = run("npm", ["pack", "--json", "--pack-destination", destination], projectRoot);
		const pack = JSON.parse(output) as Array<{
			filename: string;
			files: Array<{ path: string }>;
		}>;
		const paths = pack[0].files.map((file) => file.path);

		expect(paths).toContain("extensions/comment-editor/index.ts");
		expect(paths).toContain("extensions/comment-editor/response-review.ts");
		expect(paths).toContain("extensions/comment-editor/response-review-component.ts");
		for (const prefix of ["test/", "docs/", ".lavish/"]) {
			expect(paths.some((file) => file.startsWith(prefix))).toBe(false);
		}
		expect(paths.some((file) => file.endsWith(".tgz"))).toBe(false);
	});

	test("imports the extension entry from the packed artifact with declared peers", () => {
		const destination = temporaryDirectory();
		const output = run("npm", ["pack", "--json", "--pack-destination", destination], projectRoot);
		const [{ filename }] = JSON.parse(output) as Array<{ filename: string }>;
		const installRoot = path.join(destination, "install");
		mkdirSync(installRoot);
		run(
			"npm",
			[
				"install",
				"--ignore-scripts",
				"--legacy-peer-deps",
				"--no-audit",
				"--no-fund",
				path.join(destination, filename),
			],
			installRoot,
		);

		const peerScope = path.join(installRoot, "node_modules", "@earendil-works");
		mkdirSync(peerScope, { recursive: true });
		for (const peer of ["pi-coding-agent", "pi-tui"]) {
			symlinkSync(
				path.join(projectRoot, "node_modules", "@earendil-works", peer),
				path.join(peerScope, peer),
				"dir",
			);
		}

		const entry = path.join(
			installRoot,
			"node_modules",
			"@ramtinj95",
			"pi-comment-editor",
			"extensions",
			"comment-editor",
			"index.ts",
		);
		expect(readFileSync(entry, "utf8")).toContain("commentEditorExtension");
		run(
			process.execPath,
			["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(entry).href)})`],
			installRoot,
		);
	});
});
