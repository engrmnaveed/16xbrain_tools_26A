// Demo mode: a fully scripted swarm run that emits the exact same event
// stream as a real run — no API key, no cost. Perfect for showcasing.

const DEMO_SPEC = `## Objective
Build a Python web scraper for quotes.toscrape.com with unit tests.

## Deliverables
1. \`scraper.py\` — \`fetch_page(url)\` and \`parse_quotes(html)\` returning a list of \`{text, author, tags}\` dicts.
2. \`test_scraper.py\` — pytest unit tests using a fixture HTML sample (no live network calls in tests).

## Constraints
- Python 3.10+, only \`requests\` + \`beautifulsoup4\` as third-party deps.
- Functions must be pure and independently testable.
- Handle HTTP errors gracefully (raise \`ScraperError\`).

## Acceptance Criteria
1. \`parse_quotes\` extracts text, author, and tags from sample HTML.
2. \`fetch_page\` raises \`ScraperError\` on non-200 responses.
3. Tests run offline and pass with \`pytest\`.
4. No bare \`except\` clauses.`;

const DEMO_CODE_V1 = `### scraper.py
\`\`\`python
import requests
from bs4 import BeautifulSoup

class ScraperError(Exception):
    pass

def fetch_page(url):
    resp = requests.get(url, timeout=10)
    return resp.text  # BUG: no status check

def parse_quotes(html):
    soup = BeautifulSoup(html, "html.parser")
    quotes = []
    for q in soup.select(".quote"):
        quotes.append({
            "text": q.select_one(".text").get_text(strip=True),
            "author": q.select_one(".author").get_text(strip=True),
        })  # BUG: tags missing
    return quotes
\`\`\`

### test_scraper.py
\`\`\`python
from scraper import parse_quotes

SAMPLE = '<div class="quote"><span class="text">"Be yourself."</span>' \\
         '<small class="author">Oscar Wilde</small>' \\
         '<a class="tag">life</a></div>'

def test_parse_quotes():
    quotes = parse_quotes(SAMPLE)
    assert quotes[0]["author"] == "Oscar Wilde"
\`\`\`

## Run
\`pip install requests beautifulsoup4 pytest && pytest\``;

const DEMO_REVIEW_REJECT = `VERDICT: REJECT

1. Acceptance criterion 2 FAILS: \`fetch_page\` never checks \`resp.status_code\` — a 404 silently returns error-page HTML instead of raising \`ScraperError\`.
2. Acceptance criterion 1 FAILS: \`parse_quotes\` omits the \`tags\` field required by the spec.
3. Tests do not cover the error path or the \`tags\` extraction.
4. Missing test for empty HTML input.`;

const DEMO_CODE_V2 = `### scraper.py
\`\`\`python
import requests
from bs4 import BeautifulSoup

class ScraperError(Exception):
    """Raised when a page cannot be fetched."""

def fetch_page(url: str) -> str:
    try:
        resp = requests.get(url, timeout=10)
    except requests.RequestException as exc:
        raise ScraperError(f"Request failed: {exc}") from exc
    if resp.status_code != 200:
        raise ScraperError(f"HTTP {resp.status_code} for {url}")
    return resp.text

def parse_quotes(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    quotes = []
    for q in soup.select(".quote"):
        quotes.append({
            "text": q.select_one(".text").get_text(strip=True),
            "author": q.select_one(".author").get_text(strip=True),
            "tags": [t.get_text(strip=True) for t in q.select(".tag")],
        })
    return quotes
\`\`\`

### test_scraper.py
\`\`\`python
import pytest
from unittest.mock import patch, Mock
from scraper import parse_quotes, fetch_page, ScraperError

SAMPLE = '<div class="quote"><span class="text">"Be yourself."</span>' \\
         '<small class="author">Oscar Wilde</small>' \\
         '<a class="tag">life</a><a class="tag">wisdom</a></div>'

def test_parse_quotes_fields():
    q = parse_quotes(SAMPLE)[0]
    assert q["author"] == "Oscar Wilde"
    assert q["tags"] == ["life", "wisdom"]

def test_parse_quotes_empty():
    assert parse_quotes("") == []

@patch("scraper.requests.get")
def test_fetch_page_raises_on_404(mock_get):
    mock_get.return_value = Mock(status_code=404)
    with pytest.raises(ScraperError):
        fetch_page("https://quotes.toscrape.com/nope")
\`\`\`

## Run
\`pip install requests beautifulsoup4 pytest && pytest\``;

const DEMO_REVIEW_APPROVE = `VERDICT: APPROVE

All four acceptance criteria pass: status codes raise ScraperError, tags are
extracted, tests run fully offline with mocks, and exception handling is
specific. Clean, idiomatic implementation.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamText(emitter, agent, text, signal, cps = 3) {
  // Emit text in small chunks to mimic token streaming.
  const chunks = text.match(/[\s\S]{1,7}/g) || [];
  for (const chunk of chunks) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    emitter.emit('agent:token', { agent, token: chunk });
    await sleep(cps + Math.random() * 14);
  }
}

export async function runDemo({ task, emitter, signal }) {
  const runId = `demo-${Date.now()}`;
  const models = { planner: 'demo/planner-sim', coder: 'demo/coder-sim', qa: 'demo/qa-sim' };
  emitter.emit('run:start', { runId, task: task || 'Write a Python script to scrape a site and write unit tests.', models, maxIterations: 3, demo: true });

  const act = async (agent, text, ms) => {
    emitter.emit('agent:start', { agent, model: models[agent] });
    const t0 = Date.now();
    await streamText(emitter, agent, text, signal);
    emitter.emit('agent:done', { agent, content: text, usage: null, ms: Date.now() - t0, model: models[agent] });
    return text;
  };

  try {
    emitter.emit('flow', { from: 'user', to: 'planner', label: 'TASK' });
    await sleep(500);
    const spec = await act('planner', DEMO_SPEC);

    // Iteration 1 — Coder ships buggy code, QA rejects
    emitter.emit('iteration', { n: 1, max: 3 });
    emitter.emit('flow', { from: 'planner', to: 'coder', label: 'SPEC' });
    await sleep(700);
    const v1 = await act('coder', DEMO_CODE_V1);

    emitter.emit('flow', { from: 'coder', to: 'qa', label: 'CODE v1' });
    await sleep(700);
    const r1 = await act('qa', DEMO_REVIEW_REJECT);
    emitter.emit('verdict', { verdict: 'REJECT', iteration: 1, review: r1 });

    // Iteration 2 — Coder fixes, QA approves
    emitter.emit('iteration', { n: 2, max: 3 });
    emitter.emit('flow', { from: 'qa', to: 'coder', label: 'REJECTED · RETRY 1' });
    await sleep(700);
    const v2 = await act('coder', DEMO_CODE_V2);

    emitter.emit('flow', { from: 'coder', to: 'qa', label: 'CODE v2' });
    await sleep(700);
    const r2 = await act('qa', DEMO_REVIEW_APPROVE);
    emitter.emit('verdict', { verdict: 'APPROVE', iteration: 2, review: r2 });

    emitter.emit('flow', { from: 'qa', to: 'user', label: 'APPROVED ✓' });
    emitter.emit('run:done', { runId, status: 'approved', iterations: 2, spec, code: v2, review: r2, demo: true });
    return { status: 'approved', spec, code: v2, review: r2, iterations: 2 };
  } catch (err) {
    if (err.name === 'AbortError') {
      emitter.emit('run:done', { runId, status: 'aborted', demo: true });
      return { status: 'aborted' };
    }
    throw err;
  }
}
