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
