# claudish-to-english

A Claude Code plugin: a `MessageDisplay` hook shows a plain-language rewrite of
each assistant message, produced by a local or remote LLM. **Display-only** —
Claude's reasoning and the saved transcript always keep the original text.

Plain bash + `jq` + `curl`. No build, no test suite, no dependencies to install.

`CONTRIBUTING.md` is the full version of this file; it is the source of truth if
the two ever disagree.

## Layout

| File | Role |
|---|---|
| `rewrite.sh` | `MessageDisplay` hook — the main event. Buffers streamed chunks, rewrites on the final one |
| `rewrite-md.sh` | `PostToolUse` hook — rewrites Markdown files (opt-in, off by default) |
| `claudish-md.sh` | on-demand CLI — rewrites a file or stdin; backs `/claudish file`. **Not a hook: fails loudly** |
| `md-core.sh` | Markdown frontmatter split + system prompt, shared by `rewrite-md.sh` and `claudish-md.sh` |
| `claudish-ctl.sh` | backs `/claudish`; writes the `~/.claude/claudish-*` flag files, prints the dashboard |
| `session-notice.sh` | `SessionStart` hook — warns that flag files from an earlier session are still active |
| `providers.sh` | provider layer (ollama / anthropic / openai / codex). Sourced by both hooks and the CLI |
| `lang.sh` | output-language resolver + the sanitiser for untrusted config values. Sourced by both hooks and the CLI |
| `commands/claudish.md` | the `/claudish` slash command |
| `hooks/hooks.json` | wires the three hooks |
| `pi/claudish.ts` | pi-coding-agent extension — an adapter that feeds pi's events to the scripts above; owns no prompt or provider logic |

Config precedence is consistent throughout: **flag file > env var > settings
file > built-in default**. Flag files exist because env vars are frozen at
session launch and cannot be changed mid-session.

## Non-negotiable: hooks fail open

On *any* problem — provider down, timeout, no `jq`, malformed payload, missing
file — a hook emits nothing and exits 0, leaving Claude's original text on
screen. This outranks every other consideration. Never add a code path where a
failure can swallow or corrupt an assistant message.

The one exception is `claudish-md.sh`, which is a command a person runs, not a
hook: it reports failures (`claudish-md: <reason>`, non-zero exit) instead of
staying silent. It still never prints or writes a partial or empty rewrite.

When changing a hook, verify it directly. All three must print nothing, exit 0:

```bash
printf 'not json'                        | bash rewrite.sh; echo "rc=$?"
printf ''                                | bash rewrite.sh; echo "rc=$?"
printf '{"session_id":"s","final":true}' | bash rewrite.sh; echo "rc=$?"
```

## Testing

`CLAUDISH_STUB=1` replaces the LLM call with a deterministic string — enough for
all display mechanics, no provider needed. Redirect the `*_FILE` variables so
the developer's own `~/.claude/claudish-*` files do not leak into the test:

```bash
BODY=$(python3 -c "print('This is a long assistant message. '*20)")
jq -nc --arg d "$BODY" \
  '{message_id:"m1",session_id:"s1",index:0,final:true,delta:$d,cwd:"/tmp"}' \
| CLAUDISH_STUB=1 CLAUDISH_STYLE=caveman \
  CLAUDISH_STYLE_FILE=/nonexistent CLAUDISH_LANG_FILE=/nonexistent \
  CLAUDISH_OFF_FILE=/nonexistent CLAUDISH_NOTICE=0 TMPDIR=/tmp/claudish-test \
  bash rewrite.sh | jq -r '.hookSpecificOutput.displayContent'
```

Also run `bash -n` on every script touched. `CLAUDISH_DEBUG=1` logs to
`${TMPDIR:-/tmp}/claudish-to-english/debug.log`.

To exercise the plugin in a real session, point a scratch project's
`.claude/settings.json` at the checkout **and** set
`"enabledPlugins": { "claudish-to-english@gvzdv-plugins": false }` — otherwise
the installed copy and the working copy both fire on the same message and
whichever writes last wins.

## The pi adapter

`pi/claudish.ts` is the only TypeScript in the repo, and it is deliberately an
adapter: no prompt, no provider layer, no language rule of its own. It turns
pi's events into the payloads the scripts already take, and their replies into
pi's display channels. Behaviour changes therefore belong in the scripts — the
extension should need no edit. Adding an event it forwards means keeping the
payload shape the script reads.

Two pieces must not drift:

- **`readMode()` mirrors `rewrite.sh:85-101`.** pi's Markdown transform is
  synchronous and runs on every render, so it cannot ask bash whether replace
  mode is on. It re-reads the env vars and flag files at `message_start`
  instead, which is why a `/claudish` change lands on the next message. Same
  files, same variables, same rule that only `append` and `replace` count,
  and the same gate on `CLAUDISH_ENABLED`: only the exact value `1` (the unset
  default) enables rewriting, as in `rewrite.sh:162`, so a stray `true` cannot
  leave replace mode hiding a stream that passes through unchanged.
- **The rewrite cache is keyed by message text, not by id or timestamp.** pi
  builds the streaming component before a message has either, so the transform
  context carries `messageId: undefined, timestamp: undefined` for live
  messages; the trimmed single text block it is handed is the only stable key.
  The rewrite also depends on the user's question and the style/language, so an
  identical message can share the newer rewrite; only its wording differs.
  Rewrites stay in memory: never write one into the session, or the display-only
  promise breaks.

Test it the same way as a hook — `CLAUDISH_STUB=1` plus the `*_FILE=/nonexistent`
redirects, e.g. `CLAUDISH_STUB=1 pi -e ./pi/claudish.ts`. There is no build step
and no test suite.

There is also no `package.json`, so a bare `tsc --noEmit` cannot resolve pi's
types. Point a throwaway tsconfig at the installed release:

```sh
PI_NM="$HOME/.pi/agent/install/releases/$(cat "$HOME/.pi/agent/install/current-version")/node_modules"
cat > /tmp/pi-tsconfig.json <<JSON
{ "compilerOptions": { "strict": true, "noEmit": true, "skipLibCheck": true,
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "types": ["node"], "typeRoots": ["$PI_NM/@types"],
    "paths": {
      "@earendil-works/pi-coding-agent": ["$PI_NM/@earendil-works/pi-coding-agent/dist/index.d.ts"],
      "@earendil-works/pi-tui": ["$PI_NM/@earendil-works/pi-tui/dist/index.d.ts"] } },
  "include": ["$PWD/pi/claudish.ts"] }
JSON
npx -y -p typescript tsc -p /tmp/pi-tsconfig.json
```

## Repo-specific traps

Each of these has caused a real regression.

**A new style preset touches four readers**, and missing one fails silently:
`rewrite.sh` (prompt + label), `claudish-ctl.sh` (`current_style`,
`style_source`, dashboard, validation + error text), `session-notice.sh`
(persisted-override warning), `commands/claudish.md` (`description`,
`argument-hint`). Plus `README.md` and `CHANGELOG.md`.

**Never emit ANSI escape codes.** `displayContent` is rendered as markdown —
use `**bold**`. Colour codes are palette indices a terminal theme may remap onto
a grey or the background; they also leak as literal bytes into `claude -p`
output piped to a file; and the hook has no tty on any descriptor (`[ -t 1 ]` is
always false, `/dev/tty` will not open) so it cannot detect either case.

**`allowed-tools` in `commands/claudish.md`** must be
`Bash("${CLAUDE_PLUGIN_ROOT}/claudish-ctl.sh":*)` — the quote closes *after* the
path. The variant with the quote before the slash breaks every `/claudish` call
with `Shell command permission check failed`. It has regressed twice; do not
"correct" it back. The same file sets `disable-model-invocation: true`: that
`allowed-tools` rule pre-approves the script, so without it Claude could run
`/claudish file <URL>` (a network fetch and a file write) with no permission
prompt. Keep it.

**Untrusted config values go through `lang.sh`.** The `language` key comes from
`.claude/settings*.json`, which travels with a repository and is not necessarily
the local user's text. Route it through `_claudish_lang_clean` (folds control
characters to spaces, caps at three words / 30 codepoints) before it reaches a
prompt or the screen. Never print a raw config value.

**Comments are load-bearing.** This codebase explains *why*, not *what*, and the
header comment in each script is its real documentation. Match that density and
update the header when behaviour changes.

## Changelog and releases

Contributors add an entry under `## [Unreleased]` in `CHANGELOG.md` and **never**
bump `.claude-plugin/plugin.json` or create tags. The maintainer cuts releases.

When making a change, add the `CHANGELOG.md` entry as part of the work — not as
a follow-up. Use `### Added` / `### Changed` / `### Fixed`, and say *why*, not
just what.

To cut a release, use the `/release` skill in `.claude/skills/release/`. SemVer
at `0.x`: MINOR for a new user-facing feature, PATCH for fixes only. Only
`plugin.json` and `CHANGELOG.md` carry a version. The tag goes on the **merge**
commit, never the bump commit.
