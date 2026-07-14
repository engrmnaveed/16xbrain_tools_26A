import React from 'react';

const STATUS_LABEL = {
  approved: ['APPROVED', 'ok'],
  max_iterations: ['MAX RETRIES HIT', 'warn'],
  error: ['ERROR', 'err'],
  aborted: ['STOPPED', 'warn'],
};

export default function TopBar({ running, demo, iteration, maxIterations, runStatus, onOpen }) {
  const [label, tone] = running
    ? [demo ? 'SIMULATING' : 'SWARM ACTIVE', 'run']
    : STATUS_LABEL[runStatus] || ['IDLE', 'idle'];

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">16x</span>
        <span className="brand-name">SWARM</span>
        <span className="brand-sub">Multi-Agent Collaboration Matrix</span>
      </div>

      <div className="topbar-status">
        <span className={`status-pill status-${tone}`}>
          <span className="status-dot" />
          {label}
        </span>
        {iteration > 0 && (
          <span className="iter-pill">
            ITER {iteration}/{maxIterations}
          </span>
        )}
      </div>

      <nav className="topbar-actions">
        <button className="btn ghost" onClick={() => onOpen('trace')}>Trace</button>
        <button className="btn ghost" onClick={() => onOpen('docs')}>Docs</button>
        <button className="btn ghost" onClick={() => onOpen('settings')}>Settings</button>
      </nav>
    </header>
  );
}
