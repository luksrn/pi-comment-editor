import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildWrappedSourceRows,
	createResponseDocument,
	decorateMarkdownLines,
	isMarkdownPath,
	type MarkdownDecorator,
} from "../extensions/comment-editor/response-review.ts";

function sentinelDecorator(): MarkdownDecorator {
	const wrap = (open: string, close = open) => (text: string) => `${open}${text}${close}`;
	return {
		heading: wrap("{h}"),
		link: wrap("{l}"),
		linkUrl: wrap("{u}"),
		code: wrap("{c}"),
		codeBlockBorder: wrap("{f}"),
		quote: wrap("{q}"),
		quoteBorder: wrap("{qb}"),
		hr: wrap("{r}"),
		listBullet: wrap("{m}"),
		bold: wrap("{b}"),
		italic: wrap("{i}"),
		strikethrough: wrap("{s}"),
		underline: wrap("{un}"),
	};
}

const noHighlight = (code: string): string[] => code.split("\n");

describe("isMarkdownPath", () => {
	test("recognizes markdown extensions case-insensitively", () => {
		expect(isMarkdownPath("notes.md")).toBe(true);
		expect(isMarkdownPath("docs/guide.markdown")).toBe(true);
		expect(isMarkdownPath("a/b/c.mdown")).toBe(true);
		expect(isMarkdownPath("UPPER.MD")).toBe(true);
		expect(isMarkdownPath("glossary.mkd")).toBe(true);
		expect(isMarkdownPath("changelog.mdx")).toBe(true);
	});

	test("recognizes extension-less markdown basenames", () => {
		expect(isMarkdownPath("README")).toBe(true);
		expect(isMarkdownPath("docs/CHANGELOG")).toBe(true);
		expect(isMarkdownPath("contributing")).toBe(true);
		expect(isMarkdownPath("CODE_OF_CONDUCT")).toBe(true);
	});

	test("rejects non-markdown paths", () => {
		expect(isMarkdownPath("main.ts")).toBe(false);
		expect(isMarkdownPath("package.json")).toBe(false);
		expect(isMarkdownPath("README.txt")).toBe(false);
		expect(isMarkdownPath("notes")).toBe(false);
		expect(isMarkdownPath("archive.tar.gz")).toBe(false);
		expect(isMarkdownPath("md")).toBe(false);
	});
});

describe("createResponseDocument markdown flag", () => {
	test("defaults to plain source unless the title looks markdown", () => {
		expect(createResponseDocument("one\ntwo").markdown).toBe(false);
		expect(createResponseDocument("one\ntwo", "main.ts").markdown).toBe(false);
	});

	test("auto-detects markdown from the title", () => {
		expect(createResponseDocument("one\ntwo", "notes.md").markdown).toBe(true);
		expect(createResponseDocument("one\ntwo", "docs/README").markdown).toBe(true);
	});

	test("honors an explicit markdown option over the title", () => {
		expect(createResponseDocument("one\ntwo", undefined, { markdown: true }).markdown).toBe(true);
		expect(createResponseDocument("one\ntwo", "notes.md", { markdown: false }).markdown).toBe(false);
	});

	test("keeps source lines untouched for quoting", () => {
		const document = createResponseDocument("# Heading\n\nbody\n", "notes.md");
		expect(document.markdown).toBe(true);
		expect(document.lines[0]).toBe("# Heading");
		expect(document.displayLines[0]).toBe("# Heading");
	});
});

describe("decorateMarkdownLines", () => {
	test("styles headings and keeps the marker visible", () => {
		const [line] = decorateMarkdownLines(["## Fix the retry logic"], sentinelDecorator(), noHighlight);
		expect(line).toBe("{h}##{b} Fix the retry logic{b}{h}");
	});

	test("underlines level-one headings", () => {
		const [line] = decorateMarkdownLines(["# Title"], sentinelDecorator(), noHighlight);
		expect(line).toBe("{h}#{b}{un} Title{un}{b}{h}");
	});

	test("styles inline bold, italic, code spans, links, and strikethrough", () => {
		const [line] = decorateMarkdownLines(
			["The **current** code uses `value` and [docs](https://x.test) ~~old~~."],
			sentinelDecorator(),
			noHighlight,
		);
		expect(line).toBe(
			"The {b}**current**{b} code uses {c}`value`{c} and {l}[docs]{l}{u}(https://x.test){u} {s}~~old~~{s}.",
		);
	});

	test("keeps code span content literal inside bold", () => {
		const [line] = decorateMarkdownLines(["**a `b` c**"], sentinelDecorator(), noHighlight);
		expect(line).toBe("{b}**a {c}`b`{c} c**{b}");
	});

	test("does not treat word-wrapped underscores as italic", () => {
		const [line] = decorateMarkdownLines(["snake_case_name"], sentinelDecorator(), noHighlight);
		expect(line).toBe("snake_case_name");
		expect(decorateMarkdownLines(["*real emphasis*"], sentinelDecorator(), noHighlight)[0]).toBe(
			"{i}*real emphasis*{i}",
		);
	});

	test("styles blockquotes with a border marker and italic content", () => {
		const [line] = decorateMarkdownLines(["> Add logging."], sentinelDecorator(), noHighlight);
		expect(line).toBe("{qb}>{qb}{q} {i}Add logging.{i}{q}");
	});

	test("styles list bullets and ordered markers", () => {
		const [bullet] = decorateMarkdownLines(["- [x] retry"], sentinelDecorator(), noHighlight);
		expect(bullet).toBe("{m}- {m}[x] retry");
		const [ordered] = decorateMarkdownLines(["12. next"], sentinelDecorator(), noHighlight);
		expect(ordered).toBe("{m}12. {m}next");
	});

	test("styles horizontal rules before list markers", () => {
		expect(decorateMarkdownLines(["---"], sentinelDecorator(), noHighlight)[0]).toBe("{r}---{r}");
		expect(decorateMarkdownLines(["- - -"], sentinelDecorator(), noHighlight)[0]).toBe("{r}- - -{r}");
		expect(decorateMarkdownLines(["***"], sentinelDecorator(), noHighlight)[0]).toBe("{r}***{r}");
	});

	test("does not treat hashtags as headings", () => {
		const [line] = decorateMarkdownLines(["#hashtag"], sentinelDecorator(), noHighlight);
		expect(line).toBe("#hashtag");
	});

	test("highlights fenced code and keeps the interior literal", () => {
		const decorated = decorateMarkdownLines(
			["before", "```ts", "const x = 1;", "**literal**", "```", "after"],
			sentinelDecorator(),
			(code, language) => {
				expect(language).toBe("ts");
				return code.split("\n").map((line) => `{hl}${line}{hl}`);
			},
		);
		expect(decorated).toEqual([
			"before",
			"{f}```ts{f}",
			"{hl}const x = 1;{hl}",
			"{hl}**literal**{hl}",
			"{f}```{f}",
			"after",
		]);
	});

	test("preserves visible text and stays within width after wrapping", () => {
		const source = [
			"# Heading with **bold** and `code`",
			"> A quote that is long enough to wrap at narrow widths",
			"- A list item with [a link](https://example.test/some/path) inside",
			"```ts",
			"const value = 1; // a very long comment that should wrap when narrow",
			"```",
			"plain text",
		];
		const document = createResponseDocument(source.join("\n"), "notes.md");
		const decorated = decorateMarkdownLines(
			document.displayLines,
			sentinelDecorator(),
			(code) => code.split("\n").map((line) => `{hl}${line}{hl}`),
		);
		for (const width of [4, 8, 12, 24, 60]) {
			for (const row of buildWrappedSourceRows(document, width, decorated)) {
				expect(visibleWidth(row.text)).toBeLessThanOrEqual(width);
			}
		}
		// Visible text is unchanged by decoration.
		for (let index = 0; index < source.length; index++) {
			expect(decorated[index].replace(/\{[a-z]+\}/g, "")).toBe(source[index]);
		}
	});
});
