---
name: coding-standards
description: Project coding standards, naming conventions, function design rules, error handling patterns, logging principles, and anti-patterns to avoid. Load this before writing or reviewing any code.
---

## What I Do

Define the coding standards every agent must follow when writing, reviewing, or modifying code in this project. Load me before implementing anything.

## When to Use Me

- Before writing any new code
- When reviewing code for quality
- When unsure about naming, structure, or patterns
- When implementing error handling or logging

---

## Naming Conventions

### Variables & Functions — clear, descriptive, intention-revealing

```typescript
// ✅ Good
const userEmailAddress = 'user@example.com';
function calculateMonthlySubscriptionTotal(items: Item[]): number { }
function isEligibleForDiscount(user: User): boolean { }

// ❌ Bad
const uea = 'user@example.com';
function calc(i: any) { }
function check(u: any) { }
```

### Classes & Components — noun phrases, clear purpose

```typescript
// ✅ Good
class UserAuthenticationService { }
class OrderPaymentProcessor { }

// ❌ Bad
class Manager { }
class Helper { }
class Utility { }
```

### Constants — descriptive, explains purpose

```typescript
// ✅ Good
const MAX_LOGIN_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_SECONDS = 30;

// ❌ Bad
const MAX = 5;
const TIMEOUT = 30;
```

---

## Function Design

- Keep functions **under 30 lines** if possible
- Aim for **≤3 parameters**
- **Flatten control flow** — avoid deep nesting
- One function, one responsibility

```typescript
// ✅ Good — focused, single responsibility
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

async function registerUser(email: string, password: string): Promise<User> {
  if (!validateEmail(email)) throw new Error('Invalid email address');
  const user = await createUserAccount(email, password);
  await sendWelcomeEmail(email);
  return user;
}

// ❌ Bad — does too many things
async function registerUser(email: string, password: string): Promise<User> {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) throw new Error('Invalid email');
  const hashedPassword = hashPassword(password);
  const user = await database.users.create({ email, password: hashedPassword });
  await emailService.send(email, 'Welcome!', `Hello ${email}...`);
  analytics.track('user_registered', { email });
  return user;
}
```

---

## Comments & Documentation

Document the **why**, not the **what**:

```typescript
// ✅ Good — explains reasoning
// Using setTimeout instead of setInterval to prevent overlapping
// requests if the API is slow to respond
setTimeout(pollApi, 5000);

// ❌ Bad — states the obvious
// Set timeout to 5000
setTimeout(pollApi, 5000);
```

Document non-obvious decisions with trade-offs:

```typescript
// ✅ Good
/**
 * Using localStorage instead of cookies because:
 * 1. We need to store more than 4KB of data
 * 2. Data doesn't need to be sent with every request
 * Trade-off: Data won't sync across tabs automatically
 */
class LocalStorageCache { }
```

Use **JSDoc-style** for public APIs — helps both humans and LLMs understand intent:

```typescript
/**
 * Fetches user profile by ID.
 * @throws {Error} If user is not found or the API is unreachable.
 */
async function fetchUserProfile(userId: string): Promise<UserProfile> { }
```

Keep comments up to date — a comment that contradicts the code is worse than no comment.

---

## Error Handling

Handle errors explicitly. Fail fast with clear messages. Never swallow errors silently.

```typescript
// ✅ Good — explicit, informative
async function fetchUserData(userId: string): Promise<UserData> {
  try {
    const response = await api.get(`/users/${userId}`);
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error(`User ${userId} not found`);
    }
    if (error.response?.status === 403) {
      throw new Error(`Access denied for user ${userId}`);
    }
    console.error('Unexpected error fetching user:', error);
    throw new Error('Failed to fetch user data. Please try again.');
  }
}

// ❌ Bad — silent failure
async function fetchUserData(userId: string): Promise<UserData | null> {
  try {
    const response = await api.get(`/users/${userId}`);
    return response.data;
  } catch (error) {
    return null; // Never do this
  }
}
```

Validate early, fail with clear messages:

```typescript
// ✅ Good
function processOrder(order: Order): void {
  if (!order) throw new Error('Order is required');
  if (!order.items?.length) throw new Error('Order must contain at least one item');
  if (!order.customerId) throw new Error('Order must have a customer ID');
  // proceed...
}
```

---

## Strategic Logging

Log what's **surprising**, not what's **expected** — the Information Entropy Principle.

- ✅ **High-value**: unexpected errors, edge cases, performance anomalies, security events
- ❌ **Low-value**: "Server started", "Request received", "Function called"

The debugging test: *"If this breaks at 3 AM, what would I desperately need to know?"*

Rules:
- Use log levels appropriately: `error`, `warn`, `info`, `debug`
- Never log inside loops unless absolutely necessary
- Never log sensitive data (passwords, tokens, PII)

---

## File & Module Structure

- Files: **under 500 lines** generally, hard limit **1000 lines**
- Each module has **one clear purpose** — if it's growing too large, it's doing too much
- Clear boundaries between modules — internals stay internal
- Explicit imports/exports over implicit ones

---

## TypeScript-Specific

- Prefer `interface` over `type` for object shapes (better error messages, extendable)
- Use `type` for unions, intersections, and mapped types
- Enable `strict: true` in `tsconfig.json`
- Avoid `any` — use `unknown` and narrow with type guards
- Use `as const` for literal types and tuple inference

```typescript
// ✅ Good
interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

type ApiResponse<T> = { data: T; error: null } | { data: null; error: string };

// ❌ Bad
type User = { id: any; email: any; role: string };
```

---

## Core Principles (Quick Reference)

| Principle | Rule |
|---|---|
| **KISS** | Simplest solution that works. Readability over cleverness. |
| **YAGNI** | Only build what's explicitly needed right now. |
| **DRY** | Extract after 2–3 repetitions. Don't over-abstract. |
| **Single Responsibility** | One module, one purpose. One function, one job. |

---

## Anti-Patterns — Never Do These

### Code
- ❌ Functions longer than 50 lines
- ❌ Files longer than 1000 lines
- ❌ Deep nesting (more than 3–4 levels)
- ❌ Magic numbers or unexplained constants
- ❌ Cryptic variable names (`x`, `tmp`, `data`, `obj`)
- ❌ Comments explaining what instead of why
- ❌ Try-catch blocks that swallow errors silently
- ❌ Duplicate code in 3+ places without extraction

### Architecture
- ❌ Microservices for a small team
- ❌ Over-engineering for current scale
- ❌ Technology choices based on resume building
- ❌ Premature optimization
- ❌ Tight coupling everywhere
- ❌ No clear module boundaries

---

## Decision Checklist

Before finalizing any implementation, verify:

1. **Necessity** — Does this directly address a requirement?
2. **Simplicity** — Is this the simplest way to solve the problem?
3. **Clarity** — Will others (and future me) understand this easily?
4. **Maintainability** — How hard will this be to change or debug later?
5. **Conventions** — Does this follow established patterns in this codebase?

Good code: works correctly, readable by humans and LLMs, maintainable without archaeology, modifiable when requirements change.
