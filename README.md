# pp_web (project_p frontend)

Vite + React SPA for PDF Parallel Translate Reader.

## Architecture
- This folder is frontend-only.
- Backend API/Auth/DB is in `../pp_back` (source mirror: `git@github.com:GoHJ7/project_p_backend.git`).
- Browser requests always use `/api/*`.
- In local dev, Vite proxies `/api/*` to `VITE_BACKEND_ORIGIN` (default `http://localhost:3001`).

## Local run
1. Install deps

```bash
npm install
```

2. Configure env

```bash
cp .env.example .env
```

3. Start dev server (port 5173)

```bash
npm run dev
```

## Scripts
- `npm run dev`
- `npm run build`
- `npm run preview`
- `npm run lint`

## Notes
- This app does not include server routes or DB code.
- Authentication is handled by backend NextAuth endpoints under `/api/auth/*`.
- Flow 렌더 튜닝은 `.env`의 `VITE_FLOW_*` 변수로 조정 가능:
  - `VITE_FLOW_PARAGRAPH_MIN_WIDTH_RATIO`
  - `VITE_FLOW_PARAGRAPH_MAX_WIDTH_RATIO`
  - `VITE_FLOW_PARAGRAPH_MAX_INDENT_RATIO`
  - `VITE_FLOW_WIDTH_TUNE_MIN`, `VITE_FLOW_WIDTH_TUNE_MAX`
  - `VITE_FLOW_WIDTH_TUNE_PASS_LIMIT`
  - `VITE_FLOW_WIDTH_TUNE_THRESHOLD_LINES`
  - `VITE_FLOW_WIDTH_TUNE_STEP`, `VITE_FLOW_WIDTH_TUNE_STEP_LARGE`
  - `VITE_FLOW_START_ANCHOR_GAP_WEIGHT`
  - `VITE_FLOW_FIRST_PARAGRAPH_TOP_WEIGHT`
  - `VITE_FLOW_FIRST_PARAGRAPH_TOP_MAX_PX`
  - `VITE_FLOW_PARAGRAPH_HEADING_MAX_INDENT_RATIO`
