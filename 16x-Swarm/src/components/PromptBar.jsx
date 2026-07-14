import React from 'react';

const PLACEHOLDER =
  'Describe a task for the swarm… e.g. "Write a Python script to scrape quotes.toscrape.com and write unit tests."';

export default function PromptBar({ prompt, setPrompt, running, refining, hasKey, onRun, onDemo, onStop, onRefine }) {
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !running) onRun();
  };

  return (
    <footer className="prompt-bar">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={PLACEHOLDER}
        rows={2}
        disabled={running}
        spellCheck={false}
      />
      <div className="prompt-actions">
        <button
          className="btn ghost"
          onClick={onRefine}
          disabled={running || refining || !prompt.trim()}
          title={hasKey ? 'AI rewrites your task to be specific & testable' : 'Add an OpenRouter key in Settings'}
        >
          {refining ? '✦ refining…' : '✦ Refine with AI'}
        </button>
        <button className="btn demo" onClick={onDemo} disabled={running} title="Scripted showcase — no API key needed">
          ▶ Demo
        </button>
        {running ? (
          <button className="btn stop" onClick={onStop}>■ Stop</button>
        ) : (
          <button className="btn run" onClick={onRun} disabled={!prompt.trim()} title="⌘/Ctrl + Enter">
            ⚡ Run Swarm
          </button>
        )}
      </div>
    </footer>
  );
}
