/**
 * pi-coding-agent extension — claudish.
 *
 * An adapter, not a second implementation. The Claude Code plugin's behaviour
 * lives in shell scripts that read a Claude-shaped JSON payload on stdin and
 * print a Claude-shaped JSON reply on stdout:
 *
 *   rewrite.sh        MessageDisplay  -> {hookSpecificOutput:{displayContent}}
 *   rewrite-md.sh     PostToolUse     -> {systemMessage} (opt-in)
 *   session-notice.sh SessionStart    -> {systemMessage}
 *   claudish-ctl.sh   backs /claudish -> plain text
 *   claudish-md.sh    /claudish file  -> plain text (path written)
 *
 * This file only translates pi's events into those payloads and the replies
 * back onto pi's display surfaces, so prompts, provider handling, language
 * rules, style presets and failure text stay identical to the plugin's. A
 * TypeScript re-implementation would drift the first time a prompt is tuned.
 *
 * Display-only, like the plugin: the Markdown transformer changes what is
 * drawn, never the message that is stored or sent to the model.
 *
 * The plugin's top rule still holds: hooks fail open. Every call here is
 * wrapped so a crash, a timeout or unparseable output leaves pi's original
 * text on screen. The commands are the exception — a person asked for them,
 * so their failures are reported.
 */

import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

/** This file lives in <repo>/pi/, the scripts one level up. */
const PLUGIN_ROOT = process.env.CLAUDISH_PLUGIN_ROOT?.trim() || resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPT = {
	rewrite: join(PLUGIN_ROOT, "rewrite.sh"),
	rewriteMd: join(PLUGIN_ROOT, "rewrite-md.sh"),
	notice: join(PLUGIN_ROOT, "session-notice.sh"),
	ctl: join(PLUGIN_ROOT, "claudish-ctl.sh"),
	md: join(PLUGIN_ROOT, "claudish-md.sh"),
} as const;

/**
 * rewrite.sh gives up on its own after CLAUDISH_TIMEOUT (45s) plus provider
 * overhead; this is only the outer backstop, so a hung curl cannot wedge the
 * session forever.
 */
const REWRITE_TIMEOUT_MS = 60_000;
/** rewrite-md.sh has the same LLM budget, plus Markdown file I/O. */
const REWRITE_MD_TIMEOUT_MS = 180_000;
/**
 * A person is waiting on /claudish file; claudish-md.sh caps itself at
 * CLAUDISH_MD_TIMEOUT (150s default).
 */
const FILE_TIMEOUT_MS = 600_000;

/**
 * Cap on remembered rewrites. The transformer is synchronous and cannot await
 * the hook, so the rewrite has to be finished before the final render and
 * looked up afterwards by its text. Old entries are dropped FIFO; losing one
 * only means that message falls back to the original on a later re-render
 * (a terminal resize), never on the screen it already drew.
 */
const CACHE_LIMIT = 500;

type DisplayMode = "append" | "replace";

interface ModeState {
	enabled: boolean;
	mode: DisplayMode;
}

interface HookReply {
	/** Replacement Markdown for this message; "" hides it (replace-mode stream). */
	display?: string;
	/** One-off line for the user (session notice, Markdown-hook warnings). */
	systemMessage?: string;
}

interface RunResult extends HookReply {
	code: number;
	stdout: string;
	stderr: string;
}

interface RunOptions {
	/** Written to the script's stdin; the builder receives the temp directory. */
	stdin?: string | ((dir: string) => string);
	/** Extra files written into the temp directory, keyed by file name. */
	files?: Record<string, string>;
	/** Positional arguments after the script path. */
	args?: string[];
	timeoutMs: number;
}

interface ClaudishEntry {
	kind: "dashboard" | "text" | "last" | "error";
	text: string;
	intro?: string;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** The flag files are tested with `[ -f ]` in the scripts, so a directory is not a flag. */
async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/** Non-empty text blocks — the unit the transformer, message_end and pi all see. */
function textBlocks(content: unknown): { type: "text"; text: string }[] {
	return (Array.isArray(content) ? content : []).filter(
		(block): block is { type: "text"; text: string } =>
			block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
	);
}

/** rewrite.sh prints one pretty-printed jq object; anything else is not a reply. */
function parseReply(stdout: string): HookReply {
	const text = stdout.trim();
	if (!text) return {};
	try {
		const value = JSON.parse(text) as {
			hookSpecificOutput?: { displayContent?: unknown };
			systemMessage?: unknown;
		};
		const reply: HookReply = {};
		const display = value?.hookSpecificOutput?.displayContent;
		if (typeof display === "string") reply.display = display;
		if (typeof value?.systemMessage === "string" && value.systemMessage.trim()) {
			reply.systemMessage = value.systemMessage;
		}
		return reply;
	} catch {
		return {};
	}
}

/**
 * Run one plugin script the way the plugin expects to be run: payload on
 * stdin, JSON (or text) on stdout.
 *
 * pi.exec spawns with stdio ["ignore","pipe","pipe"], so it has no stdin
 * option — the payload goes through a file that bash redirects. Paths travel as
 * positional parameters, never spliced into the command string, so a directory
 * with a quote or a space cannot become part of the command.
 */
async function runScript(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	script: string,
	options: RunOptions,
): Promise<RunResult | undefined> {
	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(tmpdir(), "claudish-pi-"));
		for (const [name, body] of Object.entries(options.files ?? {})) {
			await writeFile(join(dir, name), body, "utf8");
		}
		const inputPath = join(dir, "stdin");
		const stdin = typeof options.stdin === "function" ? options.stdin(dir) : (options.stdin ?? "");
		await writeFile(inputPath, stdin, "utf8");

		const result = await pi.exec(
			"bash",
			[
				"-c",
				'script=$1; input=$2; shift 2; exec "$script" "$@" < "$input"',
				"_",
				script,
				inputPath,
				...(options.args ?? []),
			],
			{ cwd: ctx.cwd, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, signal: ctx.signal },
		);
		return { ...parseReply(result.stdout), code: result.code, stdout: result.stdout, stderr: result.stderr };
	} catch {
		return undefined;
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Mirror of rewrite.sh:85-101.
 *
 * The transformer has to answer synchronously, on every render, whether a
 * streaming message should be hidden — spawning bash per render is not an
 * option. So the mode is read here too, and re-read at message_start, which
 * means a /claudish change applies from the next message. Keep the two in
 * sync: the same env vars, the same flag files, the same rule that only
 * append and replace count.
 */
async function readMode(): Promise<ModeState> {
	// rewrite.sh:85,162 uses the value verbatim and passes through unless it is
	// exactly "1" (which the unset default supplies): "true" or "yes" is off
	// there, so replace mode must not hide a stream the script will not rewrite.
	let enabled = ((process.env.CLAUDISH_ENABLED ?? "").trim() || "1") === "1";
	const offFile = process.env.CLAUDISH_OFF_FILE?.trim() || join(homedir(), ".claude", "claudish-off");
	if (await isFile(offFile)) enabled = false;

	let mode: DisplayMode = process.env.CLAUDISH_MODE === "replace" ? "replace" : "append";
	const modeFile = process.env.CLAUDISH_MODE_FILE?.trim() || join(homedir(), ".claude", "claudish-mode");
	if (await isFile(modeFile)) {
		const stored = (await readFile(modeFile, "utf8").catch(() => "")).replace(/\s+/g, "");
		if (stored === "append" || stored === "replace") mode = stored;
	}
	return { enabled, mode };
}

interface BranchEntry {
	type?: string;
	message?: { role?: string; content?: unknown };
}

/** The last real user turn, as text — rewrite.sh reads it for context only. */
function lastUserQuestion(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch() as BranchEntry[];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
							.map((block) => block.text)
							.join("\n")
					: "";
		if (text.trim()) return text;
	}
	return undefined;
}

function lastAssistantMessage(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch() as BranchEntry[];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		const text = content
			.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
			.map((block) => block.text.trim())
			.join("\n\n");
		if (text) return text;
	}
	return undefined;
}

/**
 * /claudish file: the path is taken from the raw argument line (not word
 * splitting), so runs of spaces survive; one pair of surrounding quotes is
 * dropped and a leading ~/ expands — the same rules as claudish-ctl.sh:250-259,
 * because the same people type the same paths.
 */
function parseFileArgument(argline: string): string {
	let path = argline.replace(/^\s*file/, "").trim();
	const quoted =
		path.length >= 2 &&
		((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")));
	if (quoted) path = path.slice(1, -1);
	if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	return path;
}

export default function claudish(pi: ExtensionAPI) {
	const startedAt = Date.now();
	const rewrites = new Map<string, string>();
	const toolPaths = new Map<string, string>();

	let seq = 0;
	let missing = false;
	let warnedMissing = false;
	/** Display mode for the message currently streaming (set at message_start). */
	let streaming: ModeState = { enabled: true, mode: "append" };
	/**
	 * Non-empty text blocks in the message currently streaming. Whether a rewrite
	 * is even possible (exactly one block) decides whether replace mode may hide
	 * the stream, and the transformer cannot see the message it is drawing — only
	 * its own block — so the count is kept here from message_update.
	 */
	let streamBlocks = 0;

	/**
	 * The cache key is the message text itself: the transform context carries no
	 * timestamp for live messages. The text is not quite the whole story — the
	 * rewrite also sees the user's question and the current style/language — so
	 * two identical messages can share the newer rewrite after the settings
	 * change. Only the wording differs; the message on screen is the same text.
	 */
	const remember = (text: string, display: string): void => {
		rewrites.delete(text);
		rewrites.set(text, display);
		if (rewrites.size > CACHE_LIMIT) {
			const oldest = rewrites.keys().next().value;
			if (oldest !== undefined) rewrites.delete(oldest);
		}
	};

	async function ready(ctx: ExtensionContext): Promise<boolean> {
		if (missing) return false;
		const absent: string[] = [];
		for (const path of Object.values(SCRIPT)) {
			if (!(await exists(path))) absent.push(path);
		}
		if (absent.length === 0) return true;
		missing = true;
		if (!warnedMissing) {
			warnedMissing = true;
			ctx.ui.notify("claudish: extension idle — missing " + absent.join(", "), "error");
		}
		return false;
	}

	function emit(ctx: ExtensionContext, entry: ClaudishEntry): void {
		if (!ctx.hasUI) {
			const text = entry.kind === "last" ? (entry.intro ?? "") + "\n" + entry.text : entry.text;
			ctx.ui.notify(text, entry.kind === "error" ? "error" : "info");
			return;
		}
		pi.appendEntry<ClaudishEntry>("claudish", entry);
	}

	// --- display rewrite ---------------------------------------------------

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		streamBlocks = 0;
		streaming = await readMode();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		streamBlocks = textBlocks(event.message.content).length;
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (!(await ready(ctx))) return;

		const stop = (message as { stopReason?: string }).stopReason;
		// Failed or unfinished turns have nothing worth rewriting, and pi already
		// prints its own error line for them.
		if (stop === "error" || stop === "aborted" || stop === "pending" || stop === "deferred") return;

		const timestamp = Number((message as { timestamp?: number }).timestamp ?? 0);
		// A resumed session can replay history through the same events; those
		// messages are older than this process, and their rewrite would arrive too
		// late to be rendered anyway.
		if (timestamp && timestamp < startedAt - 5_000) return;

		const blocks = textBlocks(message.content);
		// pi renders every text block through its own Markdown instance, so one
		// rewrite cannot be split across several blocks. Tool-call-only turns have
		// no prose at all. Both are left alone.
		if (blocks.length !== 1) return;

		// Must match what the transformer receives: AssistantMessageComponent
		// trims each text block before rendering it.
		const text = blocks[0].text.trim();

		streaming = await readMode();
		if (!streaming.enabled) return;

		const rawSessionId = String(ctx.sessionManager.getSessionId() ?? "")
			.replace(/[^A-Za-z0-9._-]/g, "-")
			.slice(0, 64);
		// rewrite.sh builds $TMPDIR/claudish-to-english/<session>/<message>/ from
		// this without sanitising it, so a session id of "." or ".." would climb
		// out of the buffer root. Neither is a directory name; neither is kept.
		const sessionId = rawSessionId && rawSessionId !== "." && rawSessionId !== ".." ? rawSessionId : "nosession";
		const messageId = `pi-${process.pid}-${++seq}-${timestamp}`;
		const question = lastUserQuestion(ctx);

		const reply = await runScript(pi, ctx, SCRIPT.rewrite, {
			timeoutMs: REWRITE_TIMEOUT_MS,
			// rewrite.sh buffers chunks under $TMPDIR/claudish-to-english/<session>/<message>/
			// and builds that path from these two fields without sanitising them.
			files: question
				? {
						"transcript.jsonl":
							JSON.stringify({
								type: "user",
								isMeta: false,
								message: { role: "user", content: question },
							}) + "\n",
					}
				: {},
			// One message, one chunk, final: the plugin's buffer-to-final protocol
			// collapses to a single call, and append mode then returns
			// "original + label + rewrite" exactly as it would after streaming.
			stdin: (dir) =>
				JSON.stringify({
					message_id: messageId,
					session_id: sessionId,
					index: 0,
					final: true,
					delta: text,
					transcript_path: join(dir, "transcript.jsonl"),
					cwd: ctx.cwd,
				}),
		});

		if (!reply || typeof reply.display !== "string") return;
		remember(text, reply.display);
	});

	pi.registerMarkdownTransformer(
		(markdown, context) => {
			if (context.messageType !== "assistant") return markdown;
			if (context.isStreaming) {
				// Replace mode hides the stream so the reader never sees the original
				// and then a different text: the same trade the plugin makes. That only
				// pays off when the message will actually be rewritten — message_end
				// needs exactly one text block, and a second block means the original
				// stays. Hiding it then would leave an empty message until the turn
				// ends, so the count from message_update decides. With rewrites paused
				// there is nothing coming to replace it either, so it streams through.
				return streaming.enabled && streaming.mode === "replace" && streamBlocks <= 1 ? "" : markdown;
			}
			return rewrites.get(markdown) ?? markdown;
		},
		{ messageTypes: ["assistant"] },
	);

	// --- start-of-session notice ------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		rewrites.clear();
		toolPaths.clear();
		streaming = { enabled: true, mode: "append" };
		if (!(await ready(ctx))) return;

		// session-notice.sh warns that /claudish flags from an earlier session are
		// still active. In Claude that is a systemMessage; here it is the same
		// one-off warning line, not a transcript entry.
		const reply = await runScript(pi, ctx, SCRIPT.notice, { timeoutMs: 5_000 });
		if (reply?.systemMessage) ctx.ui.notify(reply.systemMessage, "warning");
	});

	// --- Markdown file rewrite (opt-in, PostToolUse equivalent) ------------

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const path = (event.args as { path?: unknown } | undefined)?.path;
		if (typeof path === "string" && path) toolPaths.set(event.toolCallId, path);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const path = toolPaths.get(event.toolCallId);
		if (path === undefined) return;
		toolPaths.delete(event.toolCallId);
		if (event.isError) return;
		if (!(await ready(ctx))) return;

		// rewrite-md.sh keeps every gate (opt-in flag, directory, extension,
		// length) and fails open; the adapter only supplies the same payload
		// shape Claude's PostToolUse event has.
		const reply = await runScript(pi, ctx, SCRIPT.rewriteMd, {
			timeoutMs: REWRITE_MD_TIMEOUT_MS,
			stdin: JSON.stringify({
				cwd: ctx.cwd,
				session_id: String(ctx.sessionManager.getSessionId() ?? "nosession"),
				tool_input: { file_path: resolve(ctx.cwd, path) },
			}),
		});
		if (reply?.systemMessage) ctx.ui.notify(reply.systemMessage, "warning");
	});

	// --- /claudish ---------------------------------------------------------

	async function runFile(ctx: ExtensionCommandContext, argline: string): Promise<void> {
		const target = parseFileArgument(argline);
		if (!target) {
			emit(ctx, {
				kind: "error",
				text: "claudish: usage: /claudish file <path or URL> — writes NAME.plain.md beside the file, or in this folder for a URL",
			});
			return;
		}
		const run = await runScript(pi, ctx, SCRIPT.md, {
			timeoutMs: FILE_TIMEOUT_MS,
			args: ["--sibling", "--", target],
		});
		if (!run) {
			emit(ctx, { kind: "error", text: "claudish: could not run claudish-md.sh" });
			return;
		}
		const written = run.stdout.trim().split("\n").pop() ?? "";
		const notes = run.stderr.trim();
		if (run.code !== 0 || !written) {
			emit(ctx, { kind: "error", text: notes || "claudish-md: failed (exit " + run.code + ")" });
			return;
		}
		emit(ctx, {
			kind: "text",
			text: `claudish: wrote ${written} (plain-language rewrite of ${target})` + (notes ? `\n${notes}` : ""),
		});
	}

	async function runCtl(ctx: ExtensionCommandContext, argline: string, dashboard: boolean): Promise<void> {
		const run = await runScript(pi, ctx, SCRIPT.ctl, {
			timeoutMs: 15_000,
			args: ["--stdin-args"],
			// One line, word-split by the script with globbing disabled: arguments
			// are never shell-evaluated, so a language name with spaces still works.
			stdin: `${argline}\n`,
		});
		if (!run) {
			emit(ctx, { kind: "error", text: "claudish: could not run claudish-ctl.sh" });
			return;
		}
		if (run.code !== 0) {
			emit(ctx, {
				kind: "error",
				text: run.stderr.trim() || run.stdout.trim() || "claudish: claudish-ctl.sh failed (exit " + run.code + ")",
			});
			return;
		}
		const text = run.stdout.replace(/\s+$/, "");
		if (!text.trim()) {
			emit(ctx, { kind: "error", text: "claudish: claudish-ctl.sh printed nothing" });
			return;
		}
		// The dashboard is preformatted (aligned columns); markdown would eat the
		// spacing, so it is rendered as plain text.
		emit(ctx, { kind: dashboard ? "dashboard" : "text", text });
	}

	pi.registerCommand("claudish", {
		description:
			"Show the claudish dashboard, or switch the rewrite on the fly — on, off, append, replace, style, language, model, last, file, cycle, reset",
		getArgumentCompletions: (prefix) => {
			const item = (value: string, description: string) => ({ value, label: value, description });
			// A style preset is a fixed list, so it is worth completing; the other
			// arguments are free text (a language name, a model, a path) or short
			// words the dashboard already spells out.
			const style = /^style(?:\s+(\S*))?$/i.exec(prefix);
			if (style) {
				return ["tldr", "5y", "caveman", "default"]
					.filter((value) => value.startsWith(style[1] ?? ""))
					.map((value) => ({ value: `style ${value}`, label: value, description: "style preset" }));
			}
			if (prefix.includes(" ")) return null;
			const subcommands = [
				["on", "rewrite every message again"],
				["off", "pause rewrites, keep the setting"],
				["append", "show the original, then the rewrite"],
				["replace", "show the rewrite instead of the original"],
				["style", "tldr | 5y | caveman | default"],
				["language", "rewrite into this language, or default"],
				["model", "use this model, or default"],
				["last", "show the last assistant message as written"],
				["file", "rewrite a Markdown file or URL to NAME.plain.md"],
				["cycle", "step through off, append, replace"],
				["reset", "clear every override"],
				["status", "the dashboard"],
			];
			return subcommands
				.filter(([value]) => value.startsWith(prefix.trim()))
				.map(([value, description]) => item(value, description));
		},
		handler: async (rawArgs, ctx) => {
			const argline = (rawArgs ?? "").replace(/\r?\n/g, " ").trim();
			const command = argline.split(/\s+/, 1)[0].toLowerCase();

			if (command === "last") {
				const original = lastAssistantMessage(ctx);
				if (!original) {
					emit(ctx, { kind: "error", text: "claudish: no assistant message in this session yet" });
					return;
				}
				// No <!-- claudish:original --> marker: that exists to tell Claude's
				// display hook to skip a reply, and an entry is not a reply.
				emit(ctx, {
					kind: "last",
					intro: "the rewrite is display-only — the transcript still keeps the original:",
					text: original,
				});
				return;
			}

			if (command === "file") {
				await runFile(ctx, argline);
				return;
			}

			const dashboard = argline === "" || /^(status|menu|help|dashboard)$/i.test(argline);
			await runCtl(ctx, argline, dashboard);
		},
	});

	pi.registerEntryRenderer<ClaudishEntry>("claudish", (entry, _options, theme) => {
		const data = entry.data;
		if (!data || typeof data.text !== "string") return undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (data.kind === "last") {
			if (data.intro) box.addChild(new Text(theme.fg("dim", data.intro), 0, 0));
			box.addChild(new Markdown(data.text, 0, 0, getMarkdownTheme()));
			return box;
		}
		box.addChild(new Text(data.kind === "error" ? theme.fg("error", data.text) : data.text, 0, 0));
		return box;
	});
}
