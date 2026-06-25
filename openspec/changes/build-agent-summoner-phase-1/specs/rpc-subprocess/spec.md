## ADDED Requirements

### Requirement: Spawn a pi RPC subprocess
The system SHALL spawn sub-agents as `pi --mode rpc` subprocesses using Node's `child_process.spawn`. Each spawned instance MUST be a real, independent pi session with its own stdin/stdout communication channel.

#### Scenario: Successful subprocess spawn
- **WHEN** the orchestrator requests a Crafter subprocess with a specific prompt
- **THEN** `rpc-client.ts` spawns `pi --mode rpc --model <model>` and returns a client handle with stdin/stdout streams

#### Scenario: Spawn failure
- **WHEN** the `pi` binary is not available or the spawn fails
- **THEN** `rpc-client.ts` throws an error with a descriptive message; the orchestrator reports the failure to the user

### Requirement: Send prompts and receive responses over JSONL
The system SHALL communicate with subprocesses using JSONL framing on stdin/stdout. Each message MUST be one complete JSON object terminated by a newline. Requests and responses MUST be correlated by an `id` field.

#### Scenario: Sending a prompt and receiving a result
- **WHEN** `rpc-client.ts` sends `{"id": "1", "type": "prompt", "content": "Fix the auth bug"}` to the subprocess's stdin
- **THEN** the client reads stdout lines until it receives `{"id": "1", "type": "response", "result": "..."}` with the matching id

#### Scenario: Receiving an event stream
- **WHEN** the subprocess emits progress events during work
- **THEN** `rpc-client.ts` reads lines like `{"type": "event", "event": "progress", "data": "..."}` and surfaces them via a callback or async iterator

### Requirement: JSONL framing compliance
The system SHALL split stdout on `\n` characters only. It MUST NOT use Node's `readline` module, which adds buffering behavior incompatible with pi's RPC protocol. A custom buffer-accumulate-and-split implementation MUST be used.

#### Scenario: Partial line received
- **WHEN** stdout delivers a partial JSON object without a trailing newline
- **THEN** the client buffers the partial data and waits for the next chunk containing the `\n` before parsing

#### Scenario: Multiple messages in one chunk
- **WHEN** stdout delivers `{"id":"1"}\n{"id":"2"}\n` in a single chunk
- **THEN** the client splits on `\n` and processes both messages independently

### Requirement: Graceful subprocess termination
The system SHALL provide a method to cleanly terminate a subprocess and release its resources when work is complete or when the orchestrator decides to abort.

#### Scenario: Normal completion
- **WHEN** the subprocess returns a final response and the client has no more work for it
- **THEN** `rpc-client.ts` sends a termination command (or closes stdin) and waits for the subprocess to exit

#### Scenario: Force kill
- **WHEN** the orchestrator needs to abort a running subprocess mid-task
- **THEN** `rpc-client.ts` calls `subprocess.kill()` and cleans up stream listeners

### Requirement: Model and thinking level at spawn time
The system SHALL accept model and thinking-level parameters at spawn time and pass them to the `pi` command as `--model <provider/id:thinking>`.

#### Scenario: Model with thinking level
- **WHEN** the orchestrator requests a Gatekeeper with model `anthropic/claude-opus-4-5` and thinking `high`
- **THEN** the subprocess spawns with `--model anthropic/claude-opus-4-5:high`

#### Scenario: Default model (Phase 1 hardcoded)
- **WHEN** no specific model is provided by the orchestrator
- **THEN** the subprocess spawns with a hardcoded default model suitable for Phase 1
