# omp extension API: grader call, structured output, status and notify, directory loading

Research target: omp 18.6.1 (`v18.6.1` upstream source). Answers use the extension API and source at that tag, not a locally modified runtime.

## Questions

### 1. Can the extension resolve `@advisor` at call time and directly send only the Prompt with registry auth?

**Yes.** `ctx.models.resolve(spec)` resolves a model string or configured role alias against the registry's currently available models and effective settings. Its implementation delegates role aliases to the same settings-backed role-resolution helper as core model selection; call it when grading, rather than capturing the advisor model in extension initialization. `ExtensionContext` exposes both `models` and `modelRegistry`. [Extension model-query implementation](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/model-api.ts#L1-L37) · [Extension context types](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/types.ts#L485-L519)

A direct `@oh-my-pi/pi-ai` `completeSimple` call accepts a model, a `Context`, and simple-stream options. `ModelRegistry.resolver(model, sessionId?)` returns the registry-backed `ApiKeyResolver`; `SimpleStreamOptions.apiKey` accepts that resolver, and the stream layer resolves it before the provider attempt. `completeSimple` streams exactly the context supplied to it; it does not call the session side-turn pipeline. [AI public exports](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/index.ts#L1-L52) · [Completion implementation](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/stream.ts#L1638-L1652) · [Simple options and `Context` types](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/types.ts#L699-L759) · [Registry auth resolver](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/config/model-registry.ts#L2936-L3018)

The request can be constructed with one user message and no system prompt, tools, or other messages, so only the Prompt text is in the model context:

```ts
const model = ctx.models.resolve("@advisor");
if (!model) throw new Error("No available model for @advisor");

const result = await completeSimple(
  model,
  { messages: [{ role: "user", content: promptText }] },
  {
    apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
    reasoning: "medium",
  },
);
```

`UserMessage.content` accepts a string; `Context` has an optional `systemPrompt`, required messages, and optional tools. Omitting the optional fields prevents session history/snapshot content from being sent. [AI context/message types](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/types.ts#L1053-L1055) · [AI context type](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/types.ts#L1501-L1506)

### 2. Can the call request medium reasoning regardless of the role default?

**Yes, as a per-call request.** `SimpleStreamOptions.reasoning` accepts `Effort`, and the canonical effort set includes `medium`; it is separate from the model role's configured selector. Supplying `reasoning: "medium"` therefore overrides the advisor role's configured default for this request. [AI simple options](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/types.ts#L699-L717) · [Provider effort handling](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/provider-compat-reference.md#2-reasoning-levels)

**Qualification:** this requests medium; it cannot make a model or endpoint honor an unsupported effort. omp's reasoning policy maps or clamps efforts using the selected model's capabilities, and some endpoints omit or translate the wire value. The design decision holds if “medium” means the explicit request option, not a guarantee about each provider's internal computation. [Provider effort handling and fallback](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/provider-compat-reference.md#2-reasoning-levels)

### 3. Does the direct completion path support JSON Schema, forced tool calls, or JSON mode? What are the provider limits?

**Partly.** `completeSimple` supports tools and tool-choice options, so a single function tool whose `parameters` is a JSON Schema can be offered and its call forced; the completed assistant message carries the tool call/arguments. `Tool` includes a JSON-schema-compatible `parameters` field and optional `strict`; `Context.tools` supplies the tools; `toolChoice` accepts required/any or a named function. This is the available structured-output route, not a promise that every endpoint enforces a schema. [Tool/context types](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/types.ts#L1463-L1506) · [Tool-choice type](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/types.ts#L115-L127) · [Simple options](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/types.ts#L699-L759) · [Provider tool and forced-choice reference](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/provider-compat-reference.md#3-tool-handling-per-provider)

There is **no generic `response_format` / JSON-mode / output-JSON-Schema option** on `SimpleStreamOptions` in the 18.6.1 API. The Google adapter contains wire serialization for `responseSchema`/`responseJsonSchema`, but its generic `buildGoogleGenerateContentParams` does not populate those fields from `SimpleStreamOptions`; it constructs generation config from sampling, tools, and other supported fields. Do not treat those internal serializer fields as a public direct-completion API. [Simple options](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/types.ts#L699-L759) · [Google request construction](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/providers/google-shared.ts#L806-L855) · [Google wire serialization](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/ai/src/providers/google-shared.ts#L1105-L1125)

Provider differences for the tool-schema workaround:

| Provider path | What works / what can be lost |
| --- | --- |
| OpenAI Chat Completions and Responses | Tool JSON schemas are normalized/adapted, but a schema that cannot be represented may be quarantined; strict is gated by endpoint compatibility. Unsupported forced choices may downgrade to `auto`; named-choice support also varies. |
| Anthropic | Tool schemas are normalized; only compatible schemas use strict mode. A strict-schema 400 is retried without strict, so the schema is then not strictly enforced. Unsupported forced choices, or forced choice conflicting with mandatory/prefix-bound thinking, may downgrade to `auto`. |
| Google Gemini / Vertex | Functions are encoded as function declarations; a named force uses `ANY` plus an allowed-function-name list. CCA/Claude paths use the legacy `parameters` field instead of `parametersJsonSchema`. This tool route is available; generic output JSON Schema is not exposed by the simple options. |
| Bedrock | Tool schema is sent as JSON input schema; native choice supports auto/any/named tool. This is tool-call output, not a generic JSON-mode setting. |
| Ollama / string-choice hosts | Only `none` and `required` are native choices; a named pin is emulated by filtering the offered tools and requiring a call. |

The important general failure mode is **silent weakening**: compatibility policy can change a forced choice to `auto`, or remove a stale pin. Strict schemas also have per-provider normalization/retry behavior. If prompt-tutor needs reliably parseable output, use a forced schema tool and make schema/response validation and fallback policy explicit; do not rely on JSON mode or universal strictness. [Forced-choice mappings and downgrades](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/provider-compat-reference.md#4-forced-tool-choice) · [Schema normalization and strict fallback by provider](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/provider-compat-reference.md#3-tool-handling-per-provider)

### 4. Do status and notify work in `session_start` and from a timeout after `input` returns?

**Yes in an interactive UI session.** `ExtensionUIContext` defines `notify` and `setStatus`; `setStatus(key, text)` is documented as footer/status-bar text, and passing `undefined` clears it. The authoring guide demonstrates `notify` from `session_start` and `setStatus` from an event handler. TUI supports status/notifications; RPC UI emits fire-and-forget UI requests, while no-UI/headless implementations are no-ops. [UI API types](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/types.ts#L265-L299) · [Extension guide examples and UI modes](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/extensions.md#quick-start) · [UI integration notes](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/extensions.md#ui-integration-points)

`ctx.setTimeout` is a managed timer, not a handler-scoped deadline. Its callback runs after the scheduling handler can return. The callback can close over its event `ctx`; non-dialog UI methods are forwarded by the handler UI proxy, and managed timer dispatch does not invalidate that context. A timer may therefore call `ctx.ui.setStatus` or `notify` after `input` returns. This is source-supported behavior, not separately observed in a throwaway TUI run. [Handler UI proxy and context construction](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/runner.ts#L192-L240) · [Managed timer wiring](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/runner.ts#L1367-L1420) · [Managed timer implementation](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/managed-timers.ts#L1-L75)

### 5. Are `event.source === "interactive"` and `ctx.agent.kind === "main"` available, and does an immediate return preserve the Prompt?

**Yes.** The input event type exposes `source: "interactive" | "rpc" | "extension"`. For main-session Enter/Ctrl+Enter, the documented source is `"interactive"`; `ctx.agent.kind` is `"main"` for the top-level session and `"sub"` for subagents. This lets prompt-tutor limit review to human interactive prompts in the main session. [Input event type](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/types.ts#L1037-L1041) · [Input source contract](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/extensions.md#external-input-interception) · [Top-level identity](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/runner.ts#L488-L495)

Returning `undefined` (or `{}`) makes no change. `emitInput` chains only defined `text`/`images` replacements; it returns an empty transformation if none changed, while `handled: true` stops normal dispatch. The existing input is otherwise passed through. The host trims replacement text before dispatch; no-op return does not add tutor content to the Prompt. [Input result type](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/types.ts#L1271-L1285) · [Input handler chaining](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/runner.ts#L1941-L1965) · [Input semantics](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/extensions.md#external-input-interception)

### 6. Does `ctx.setTimeout` exist, and can detached rejection kill the session?

**Yes, with an important distinction.** `ctx.setTimeout` exists in `ExtensionContext`; its managed callback catches synchronous throws and rejected promises, reports them through the extension error channel, is unref'd, and is cleared on session shutdown. An uncaught throw/rejection from a **raw detached timer or detached promise** is outside that containment; extension docs and implementation describe it as process-level `uncaughtException` and fatal to the session. Use `ctx.setTimeout`/`ctx.setInterval` for deferred work, and still catch/report failures in detached work not run by a managed timer. [Timer API type](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/types.ts#L554-L557) · [Managed timer error containment](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/managed-timers.ts#L1-L75) · [Background-work contract](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/extensions.md#background-work-ctxsetinterval--ctxsettimeout)

### 7. How do directory extensions load, including profile scope, dependencies, and extra files?

**Directory entrypoints are supported.** For explicitly configured directories, a non-empty `package.json` `omp.extensions` (or legacy `pi.extensions`) list is authoritative; absent that, `index.ts` is preferred over `index.js`; absent those, the loader scans one level for `.ts`/`.js` files and child directories with an index/manifest. It does not recurse beyond that level. Native auto-discovery scans `.ts`/`.js` under `<cwd>/.omp/extensions` and the active agent directory's `extensions/`. The project extension root is cwd-based; the user root follows the active profile. [Directory resolver](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/directory-resolution.ts#L31-L142) · [Loader discovery and configured-directory expansion](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/loader.ts#L526-L654) · [Discovery roots/order](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/extension-loading.md#inputs-to-extension-loading)

The default profile's user extension directory is normally `~/.omp/agent/extensions`; `omp --profile <name>` uses `~/.omp/profiles/<name>/agent/extensions`. Thus profiles do not share that user extension directory, although project `.omp/extensions` applies to the current working directory under any profile. Explicit `extensions:` settings and enabled plugin entrypoints are additional loading routes. [Profile-aware discovery](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/extension-loading.md#1-auto-discovered-native-extension-modules) · [Profiles](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/config-usage.md#profiles)

An `index.ts` can import sibling files and extension-local dependencies: modules are dynamically imported as a graph, and the loader preserves extension-relative imports, package `imports` aliases, and extension-local dependencies. The extension runs in-process and is not sandboxed. So one extension directory/package can ship extra TypeScript/JavaScript/data files; it should import those files from its entrypoint. A `package.json` manifest can select multiple entry files. [Module graph/loading contract](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/extension-loading.md#module-import-and-factory-contract) · [Extension package manifest](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/skills/authoring-extensions.md#packagejson-manifest)

### 8. Can an extension read the active profile name?

**Yes via the process environment; no dedicated extension-context field.** `ExtensionContext` has no profile property. The CLI activates a named `--profile` before session setup; `setProfile` writes the name to `process.env.OMP_PROFILE` (and legacy `PI_PROFILE`). Activating the default profile clears those variables. An extension can use `process.env.OMP_PROFILE` as the named profile or treat it as absent as the default. This is enough to distinguish profile-scoped Scope rules, but it is an environment convention rather than a typed `ctx.profile` API. [CLI profile bootstrap](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/cli.ts#L486-L501) · [Profile environment and accessors](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/utils/src/dirs.ts#L575-L620) · [Extension context fields](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/extensibility/extensions/types.ts#L485-L555)

## Implications for the design

- **ADR 0003 holds:** the grader can resolve `@advisor` at use time and call the AI completion API directly with only the Prompt in its context, using the same registry's credential resolver. `ctx.runEphemeralTurn` is unnecessary and would violate the one-Prompt boundary because it sends the conversation snapshot. [Ephemeral-turn contract](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/extensions.md#ephemeral-side-turns-ctxrunephemeralturn)
- Keep the medium-reasoning decision, but specify it as a **per-request requested effort**. Provider/model capability means the exact wire behavior may be clamped or mapped.
- Add a concrete structured Review schema/tool to the design only if prompt-tutor can tolerate provider compatibility downgrades. Direct generic JSON mode/output-schema is not available; forced tool calls are a workaround, not guaranteed strict output across all providers.
- Startup/status/notification API and managed deferral exist; use `ctx.setTimeout` rather than raw timers, and do not let the timer mutate or replace the Prompt. `input` can gate on `source === "interactive"` and `agent.kind === "main"`, then return without a result to pass through unchanged.
- A Scope can use the active profile name from `process.env.OMP_PROFILE` (`undefined` for default) in addition to cwd/profile rules. There is no `ctx.profile` field.

**Follow-up grilling question:** Is best-effort forced-tool schema output acceptable for Review persistence, or must prompt-tutor reject/retry or locally validate responses whenever the selected advisor provider cannot honor strict schemas/forced tool choice?

**Contradictions:** No contradiction found with ADR 0003. Its required API exists. Refine “medium reasoning” to mean the explicit requested effort rather than guaranteed provider execution at exactly medium.

## Sources and verification boundary

All upstream links above are pinned to `v18.6.1` and cite the extension/AI source, API types, or first-party docs. The local `omp` is 18.6.1. No throwaway extension was installed or run; claims above are source/type/docs-confirmed, not an independent observation of a live TUI session or every provider. A live UI confirmation could use a temporary extension passed explicitly to an omp process launched with an isolated temporary `HOME`/config root, observe `session_start` status/notify and schedule the same calls from `input` with a short `ctx.setTimeout`; this need not touch `~/.omp`.
