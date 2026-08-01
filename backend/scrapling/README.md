# Scrapling sidecar (LeadPulse)

Uses the [Scrapling](https://github.com/D4Vinci/Scrapling) framework as the
primary fetch/search engine for discovery and enrichment.

## Local clone

The full upstream repo is cloned here (gitignored — large):

```
backend/scrapling/upstream/   ← git clone of D4Vinci/Scrapling
```

## Setup (once)

```bash
git clone --depth 1 https://github.com/D4Vinci/Scrapling.git backend/scrapling/upstream
py -3.10 -m pip install -e "./backend/scrapling/upstream[fetchers]"
scrapling install
```

Or from this folder:

```bash
py -3.10 -m pip install -r requirements.txt
scrapling install
```

## Run

The Node server auto-starts `server.py` on boot when `SCRAPLING_ENABLED` is
not `false`. Manual:

```bash
py -3.10 backend/scrapling/server.py
```

Endpoints: `GET /health`, `POST /fetch`, `POST /search` on `127.0.0.1:3765`.

## Env

```
SCRAPLING_ENABLED=true
SCRAPLING_HOST=127.0.0.1
SCRAPLING_PORT=3765
SCRAPLING_DEFAULT_MODE=fetcher   # or stealth
SCRAPLING_PYTHON=py
```
