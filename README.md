# Nano Banana Editor

MEIE (Multi-Element Image Engine) implementation.

## Workspace Layout

```text
Nano Banana Editor/
├── packages/
│   ├── web/       # Browser UI (upload + role assignment + preview)
│   ├── server/    # Task API + SSE status stream + static hosting
│   ├── shared/    # Shared generation contracts and validators
│   └── engine/    # Dual-track workflow simulation
├── docs/
│   └── technical-plan.md
├── package.json
└── pnpm-workspace.yaml
```

## Quick Start

```bash
export GEMINI_API_KEY="your_key"
# optional:
# export GEMINI_MODEL="gemini-3-pro-image-preview"
# export GEMINI_API_BASE_URL="https://generativelanguage.googleapis.com/v1beta"
node packages/server/src/index.js
```

Then open:

- `http://127.0.0.1:8787`

## Basic Validation

```bash
node scripts/check.js
# remote check (will call Gemini API):
# CHECK_REMOTE=1 node scripts/check.js
```
