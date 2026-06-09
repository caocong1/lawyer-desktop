---
name: solidjs-store-vs-signal
description: SolidJS createStore vs createSignal — calling conventions, common pitfalls, and how mixing them causes silent runtime crashes in Tauri apps.
source: auto-skill
extracted_at: '2026-06-09T02:13:23.257Z'
---

# SolidJS: createStore vs createSignal — Calling Conventions

## The Bug
When using `createStore` to define shared state and then calling the returned value with `()` (as if it were a signal), the app silently crashes — components fail to render with no visible error. This is especially hard to debug in Tauri apps because the WebView doesn't always surface JS errors.

## Root Cause

### createSignal
```ts
const [value, setValue] = createSignal<string[]>([]);
// value is a getter function — MUST call with ()
<For each={value()}>{...}</For>
```

### createStore
```ts
const [store, setStore] = createStore<string[]>([]);
// store is a reactive Proxy — DO NOT call with ()
<For each={store}>{...}</For>
```

If you use `createStore` but call `store()` in JSX, SolidJS throws a runtime error that can silently kill the component tree.

## Fix
Choose one pattern and be consistent:

### Option A: All signals (recommended for simple arrays/objects)
```ts
// stores/conversation.ts
const [messages, setMessages] = createSignal<Message[]>([]);
const [conversations, setConversations] = createSignal<Conversation[]>([]);

export function useConversation() {
  return {
    messages,           // getter — call with messages()
    setMessages,
    conversations,      // getter — call with conversations()
    setConversations,
  };
}

// In components
const { messages } = useConversation();
<For each={messages()}>{...}</For>  // ✅ correct
```

### Option B: All stores (for complex nested state)
```ts
const [state, setState] = createStore({ messages: [], conversations: [] });

export function useConversation() {
  return { state, setState };
}

// In components
const { state } = useConversation();
<For each={state.messages}>{...}</For>  // ✅ correct — no ()
```

## Key Rules
1. **Never mix** `createStore` getters with `()` calls
2. **Never mix** `createSignal` getters without `()` calls
3. When exporting from a shared store module, document which pattern you use
4. If switching from `createStore` to `createSignal`, update ALL consumers to add `()`

## Diagnosis Checklist
If a SolidJS component silently doesn't render:
1. Open browser DevTools (in Tauri: right-click → Inspect, or set `devTools: true` in tauri.conf.json)
2. Check Console for `TypeError: X is not a function` — this means you called `()` on a store proxy
3. Check if the parent component crashes before reaching the child — a crash in `ChatArea` would prevent `FloatingInput` from rendering

## Tauri-Specific Notes
- Tauri WebView errors may not appear in terminal output
- Add `console.log` at the top of component functions to verify they execute
- If `tauri dev` shows the window but it's blank, it's almost always a JS runtime error
- Use `npm run build` to catch some type errors before runtime
