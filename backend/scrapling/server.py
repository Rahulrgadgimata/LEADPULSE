#!/usr/bin/env python3
"""
LeadPulse Scrapling sidecar — robust HTML fetch + search-engine scrape.

Uses https://github.com/D4Vinci/Scrapling (Fetcher / StealthyFetcher) so Node
collectors get TLS impersonation + stealth browser fetches without reimplementing
anti-bot logic in Puppeteer.

Endpoints (JSON):
  GET  /health
  POST /fetch   { "url", "mode": "fetcher"|"stealth", "timeout_ms"? }
  POST /search  { "query", "engine": "brave"|"bing"|"duckduckgo"|"google", "limit"?, "mode"? }
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s scrapling: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("scrapling-sidecar")

HOST = os.environ.get("SCRAPLING_HOST", "127.0.0.1")
PORT = int(os.environ.get("SCRAPLING_PORT", "3765"))
DEFAULT_MODE = os.environ.get("SCRAPLING_DEFAULT_MODE", "fetcher")
MAX_HTML_CHARS = int(os.environ.get("SCRAPLING_MAX_HTML_CHARS", str(2_000_000)))
# Cap parallel browser/TLS work so discovery's multi-source fan-out cannot
# spawn a dozen Chromium instances at once and melt the machine.
FETCH_SLOTS = threading.Semaphore(int(os.environ.get("SCRAPLING_CONCURRENCY", "3")))
STEALTH_SLOTS = threading.Semaphore(int(os.environ.get("SCRAPLING_STEALTH_CONCURRENCY", "1")))


def _html_of(page: Any) -> str:
    content = getattr(page, "html_content", None)
    if content is not None:
        return str(content)
    body = getattr(page, "body", b"") or b""
    if isinstance(body, bytes):
        return body.decode("utf-8", errors="replace")
    return str(body)


def _status_of(page: Any) -> int:
    try:
        return int(getattr(page, "status", 0) or 0)
    except Exception:
        return 0


def fetch_page(url: str, mode: str = "fetcher", timeout_ms: int = 30000) -> dict:
    """Fetch a URL with Scrapling. Returns {ok, status, url, html, error?}."""
    mode = (mode or DEFAULT_MODE).lower().strip()
    timeout_s = max(5, min(90, int(timeout_ms / 1000) or 30))
    slot = STEALTH_SLOTS if mode == "stealth" else FETCH_SLOTS

    if not slot.acquire(timeout=max(timeout_s + 15, 45)):
        return {
            "ok": False,
            "status": 0,
            "url": url,
            "html": "",
            "mode": mode,
            "error": "busy",
        }

    try:
        if mode == "stealth":
            from scrapling.fetchers import StealthyFetcher

            page = StealthyFetcher.fetch(
                url,
                headless=True,
                network_idle=False,
                disable_resources=True,
                timeout=timeout_s * 1000,
            )
        else:
            from scrapling.fetchers import Fetcher

            # curl_cffi TLS impersonation — beats many WAF soft-blocks.
            page = Fetcher.get(url, timeout=timeout_s, impersonate="chrome")

        html = _html_of(page)
        if len(html) > MAX_HTML_CHARS:
            html = html[:MAX_HTML_CHARS]
        status = _status_of(page) or 200
        final = getattr(page, "url", None) or url
        return {
            "ok": status < 400 and bool(html),
            "status": status,
            "url": str(final),
            "html": html,
            "mode": mode,
        }
    except Exception as exc:
        log.warning("fetch failed %s (%s): %s", url, mode, exc)
        return {
            "ok": False,
            "status": 0,
            "url": url,
            "html": "",
            "mode": mode,
            "error": str(exc),
        }
    finally:
        slot.release()


def _attr(el: Any, name: str) -> str:
    if el is None:
        return ""
    try:
        if hasattr(el, "attrib") and el.attrib is not None:
            val = el.attrib.get(name)
            if val:
                return str(val)
    except Exception:
        pass
    try:
        got = el.css(f"::attr({name})").get()
        return str(got or "")
    except Exception:
        return ""


def _text(el: Any) -> str:
    if el is None:
        return ""
    try:
        return re.sub(r"\s+", " ", str(getattr(el, "text", None) or el.get() or "")).strip()
    except Exception:
        try:
            return re.sub(r"\s+", " ", str(el)).strip()
        except Exception:
            return ""


def _first(el: Any, selector: str) -> Any:
    """First element matching `selector`, or None.

    Indexing rather than .get(): scrapling's .get() yields a TextHandler (the
    serialised markup), which has no .css()/.attrib to drill into further.
    """
    if el is None:
        return None
    try:
        found = el.css(selector)
        return found[0] if len(found) else None
    except Exception:
        return None


def _self_text(el: Any) -> str:
    """All text inside an element, including nested tags.

    Uses .//text() rather than ::text because the CSS pseudo-element matches
    only *direct* text children. Bing wraps the query terms in <strong> inside
    the result heading, so ::text yielded "Understanding : Enhancing ..." for a
    title that actually reads "Understanding Fintech: Enhancing ...".
    """
    if el is None:
        return ""
    try:
        parts = el.xpath(".//text()").getall()
        return re.sub(r"\s+", " ", " ".join(str(p) for p in parts)).strip()
    except Exception:
        return _text(el)


def _sel_text(el: Any, selector: str) -> str:
    """All text of the first descendant matching `selector`."""
    return _self_text(_first(el, selector))


def _sel_attr(el: Any, selector: str, name: str = "href") -> str:
    if el is None:
        return ""
    try:
        got = el.css(f"{selector}::attr({name})").get()
        return str(got or "").strip()
    except Exception:
        return ""


def _unwrap_ddg(href: str) -> str:
    if not href:
        return ""
    href = href.replace("&amp;", "&").strip()
    if href.startswith("//"):
        href = "https:" + href
    try:
        parsed = urlparse(href)
        qs = parse_qs(parsed.query)
        if "uddg" in qs and qs["uddg"]:
            return unquote(qs["uddg"][0])
    except Exception:
        pass
    return href


def _unwrap_bing(href: str) -> str:
    """Bing routes some clicks through /ck/a?...&u=a1<base64url-of-target>."""
    if not href or "bing.com/ck/" not in href:
        return href
    match = re.search(r"[?&]u=a1([A-Za-z0-9_\-]+)", href)
    if not match:
        return href
    raw = match.group(1).replace("-", "+").replace("_", "/")
    raw += "=" * (-len(raw) % 4)
    try:
        decoded = base64.b64decode(raw).decode("utf-8", "replace")
        return decoded if decoded.startswith("http") else href
    except Exception:
        return href


def _unwrap_google(href: str) -> str:
    """Keyless Google serves /url?q=<target> rather than direct hrefs."""
    if not href or not href.startswith("/url?"):
        return href
    try:
        qs = parse_qs(urlparse(href).query)
        for key in ("q", "url"):
            if qs.get(key):
                return unquote(qs[key][0])
    except Exception:
        pass
    return href


# Anti-bot pages are small and say so in their <title>. A full results page can
# legitimately contain "captcha" or "blocked" inside inline JS config — matching
# those as bare substrings over the whole body marked healthy Brave responses
# (284KB, 20 parsed results) as blocked and discarded every one of them.
CHALLENGE_MARKERS = (
    "unusual traffic",
    "verify you are human",
    "just a moment",
    "are you a robot",
    "select all squares",
    "before you continue",
    "our systems have detected",
    "attention required",
)


def _looks_blocked(html: str) -> bool:
    """True only when the response is an anti-bot page instead of results.

    Only consulted after parsing returned nothing: successfully parsed results
    are the authoritative signal that we were served a real results page, so
    they always win over any textual heuristic.
    """
    low = (html or "").lower()
    if not low or len(low) < 400:
        return True

    title = ""
    match = re.search(r"<title[^>]*>(.*?)</title>", low, re.S)
    if match:
        title = match.group(1).strip()
    if any(marker in title for marker in CHALLENGE_MARKERS):
        return True

    # Google's rate-limit interstitial redirects here; unambiguous.
    if "/sorry/index" in low or "recaptcha/api.js" in low[:6000]:
        return True

    # A challenge phrase in a *short* document is a challenge. In a long one it
    # is script text on a page that also carries results.
    if len(low) < 20000 and any(marker in low for marker in CHALLENGE_MARKERS):
        return True

    return False


def _collect(rows: list[tuple[str, str, str]], limit: int, reject: str) -> list[dict]:
    """Shared tail of every parser: unwrap-free dedupe, filter, truncate."""
    results: list[dict] = []
    seen: set[str] = set()
    for href, title, snippet in rows:
        if not href or not href.startswith("http") or not title:
            continue
        if re.search(reject, href, re.I):
            continue
        if href in seen:
            continue
        seen.add(href)
        results.append({"url": href, "title": title[:200], "snippet": snippet[:400]})
        if len(results) >= limit:
            break
    return results


def _parse_google(page: Any, limit: int) -> list[dict]:
    rows: list[tuple[str, str, str]] = []
    for block in page.css("#search .g, div.g, div[data-hveid] > div > div"):
        try:
            href = _unwrap_google(_sel_attr(block, "a"))
            title = _sel_text(block, "h3") or _sel_text(block, "a")
            snippet = _sel_text(block, ".VwiC3b") or _sel_text(block, ".IsZvec")
            rows.append((href, title, snippet))
        except Exception:
            continue

    if not rows:
        # Keyless Google increasingly serves a JS shell with /url?q= anchors and
        # no recognisable result containers; salvage what is linkable.
        for a in page.css("#rso a[href], a[href^='/url?']"):
            try:
                rows.append((_unwrap_google(_attr(a, "href")), _sel_text(a, "h3") or _self_text(a), ""))
            except Exception:
                continue

    return _collect(rows, limit, r"google\.(com|co)|webcache|accounts\.google|/search\?")


def _parse_brave(page: Any, limit: int) -> list[dict]:
    """Brave's current results page: one [data-type="web"] node per result."""
    rows: list[tuple[str, str, str]] = []
    blocks = list(page.css('[data-type="web"]')) or list(
        page.css("#results .snippet, div.snippet, .snippet")
    )
    for block in blocks:
        try:
            href = _sel_attr(block, "a")
            title = (
                _sel_text(block, ".title")
                or _sel_text(block, ".snippet-title")
                or _sel_text(block, "a")
            )
            snippet = _sel_text(block, ".snippet-description") or _sel_text(block, ".snippet-content")
            rows.append((href, title, snippet))
        except Exception:
            continue
    return _collect(rows, limit, r"brave\.com|search\.brave")


def _parse_bing(page: Any, limit: int) -> list[dict]:
    """Bing organic results: li.b_algo, direct hrefs (occasionally /ck/a wrapped)."""
    rows: list[tuple[str, str, str]] = []
    for block in page.css("li.b_algo"):
        try:
            href = _unwrap_bing(_sel_attr(block, "h2 a") or _sel_attr(block, "a"))
            title = _sel_text(block, "h2 a") or _sel_text(block, "h2")
            snippet = (
                _sel_text(block, ".b_caption p")
                or _sel_text(block, ".b_algoSlug")
                or _sel_text(block, "p")
            )
            rows.append((href, title, snippet))
        except Exception:
            continue
    return _collect(rows, limit, r"bing\.com|microsofttranslator|go\.microsoft")


def _parse_ddg(page: Any, limit: int) -> list[dict]:
    """Handles both html.duckduckgo.com (.result__a) and lite (.result-link)."""
    rows: list[tuple[str, str, str]] = []

    for block in page.css(".result, .results_links, .web-result"):
        try:
            if _first(block, "a.result__a") is None:
                continue
            rows.append((
                _unwrap_ddg(_sel_attr(block, "a.result__a")),
                _sel_text(block, "a.result__a"),
                _sel_text(block, ".result__snippet"),
            ))
        except Exception:
            continue

    if not rows:
        # Lite endpoint (and any layout where anchors are not wrapped in cards).
        for link in page.css("a.result__a, a.result-link"):
            try:
                rows.append((_unwrap_ddg(_attr(link, "href")), _self_text(link), ""))
            except Exception:
                continue

    return _collect(rows, limit, r"duckduckgo\.com")


# Per engine: the endpoints to try in order, and the parser for their markup.
# DuckDuckGo lists two because the lite endpoint stays up under throttling that
# already turned the html endpoint into a challenge page.
ENGINES = {
    "brave": (["https://search.brave.com/search?q={q}&source=web"], _parse_brave),
    "bing": (["https://www.bing.com/search?q={q}&count={n}&setlang=en"], _parse_bing),
    "duckduckgo": (
        [
            "https://html.duckduckgo.com/html/?q={q}",
            "https://lite.duckduckgo.com/lite/?q={q}",
        ],
        _parse_ddg,
    ),
    "google": (["https://www.google.com/search?q={q}&hl=en&num={n}&pws=0"], _parse_google),
}

ENGINE_ALIASES = {"ddg": "duckduckgo", "duck": "duckduckgo", "msn": "bing"}


def search_engine(query: str, engine: str = "brave", limit: int = 10, mode: str = "fetcher") -> dict:
    engine = (engine or "brave").lower().strip()
    engine = ENGINE_ALIASES.get(engine, engine)
    if engine not in ENGINES:
        engine = "brave"
    limit = max(1, min(20, int(limit or 10)))
    q = quote_plus(query)

    urls, parser = ENGINES[engine]

    # Every endpoint over TLS impersonation first, and only then one stealth
    # (browser) attempt. Escalating per endpoint instead meant a throttled
    # engine paid for two browser launches per query and still returned
    # nothing — the single largest avoidable cost in a blocked run.
    attempts = [(u, mode or "fetcher") for u in urls]
    if mode != "stealth":
        attempts.append((urls[0], "stealth"))
    else:
        attempts = [(u, "stealth") for u in urls]

    from scrapling.parser import Selector

    last_error = None
    for url_template, try_mode in attempts:
        url = url_template.format(q=q, n=min(limit, 20))

        fetched = fetch_page(url, mode=try_mode, timeout_ms=45000)
        if not fetched.get("ok"):
            status = fetched.get("status") or 0
            # 429/403 is throttling, not an empty result set — the caller must
            # back off rather than retry the next query immediately.
            last_error = (
                "blocked" if status in (401, 403, 429) else (fetched.get("error") or f"status {status}")
            )
            continue

        html = fetched.get("html") or ""

        # Parse before judging. Results in hand prove we were served a real
        # results page, whatever words its inline scripts happen to contain.
        try:
            results = parser(Selector(html), limit)
        except Exception as exc:  # a layout change must not 500 the sidecar
            log.warning("parse %s failed: %s", engine, exc)
            results = []

        if results:
            return {
                "ok": True,
                "engine": engine,
                "mode": try_mode,
                "blocked": False,
                "results": results,
                "count": len(results),
            }

        if _looks_blocked(html):
            last_error = "blocked"
            log.info("search %s blocked on mode=%s for %r", engine, try_mode, query)
            continue

        last_error = "zero_results"
        log.info("search %s zero results on mode=%s for %r", engine, try_mode, query)

    return {
        "ok": False,
        "engine": engine,
        # Only a genuine challenge counts as blocked; "no matches" must not make
        # the caller think the whole engine is unavailable.
        "blocked": last_error == "blocked",
        "results": [],
        "count": 0,
        "error": last_error or "no_results",
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        log.debug("%s - %s", self.address_string(), fmt % args)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(min(length, 2_000_000))
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            self._send(
                200,
                {
                    "ok": True,
                    "service": "scrapling-sidecar",
                    "version": "1.1.0",
                    "default_mode": DEFAULT_MODE,
                    "engines": sorted(ENGINES.keys()),
                },
            )
            return
        self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path == "/fetch":
                url = str(data.get("url") or "").strip()
                if not url.startswith("http"):
                    self._send(400, {"ok": False, "error": "url_required"})
                    return
                result = fetch_page(
                    url,
                    mode=str(data.get("mode") or DEFAULT_MODE),
                    timeout_ms=int(data.get("timeout_ms") or 30000),
                )
                # Always 200 with ok flag so Node clients can read the body easily.
                self._send(200, result)
                return

            if path == "/search":
                query = str(data.get("query") or "").strip()
                if not query:
                    self._send(400, {"ok": False, "error": "query_required"})
                    return
                result = search_engine(
                    query,
                    engine=str(data.get("engine") or "brave"),
                    limit=int(data.get("limit") or 10),
                    mode=str(data.get("mode") or DEFAULT_MODE),
                )
                self._send(200, result)
                return

            self._send(404, {"ok": False, "error": "not_found"})
        except Exception as exc:
            log.error("handler error: %s\n%s", exc, traceback.format_exc())
            self._send(500, {"ok": False, "error": str(exc)})


def main() -> int:
    # Eager-import Fetcher so boot fails loudly if scrapling is missing.
    try:
        from scrapling.fetchers import Fetcher  # noqa: F401
    except Exception as exc:
        log.error("Scrapling import failed: %s", exc)
        log.error("Install with: py -3.10 -m pip install -r backend/scrapling/requirements.txt")
        return 1

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("Scrapling sidecar listening on http://%s:%s", HOST, PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
