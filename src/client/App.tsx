import {useCallback, useEffect, useState} from 'react';
import {FlaskConical} from 'lucide-react';
import {api, Progress, Side} from './api';
import ReviewerView from './ReviewerView';
import AdjudicatorView from './AdjudicatorView';

type Role = Side | 'C';

const ROLE_TABS: Array<{role: Role; label: string}> = [
  {role: 'A', label: '评审 A'},
  {role: 'B', label: '评审 B'},
  {role: 'C', label: '协调裁决'},
];

export default function App() {
  const [role, setRole] = useState<Role>('A');
  const [progress, setProgress] = useState<Progress | null>(null);

  const refreshProgress = useCallback(() => {
    api.progress().then(setProgress).catch(() => {});
  }, []);
  useEffect(refreshProgress, [refreshProgress, role]);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20}/>
        <strong>Search Relevance Lab</strong>
        <small>双评审盲评 · 协调裁决</small>
        <nav className="tabs">
          {ROLE_TABS.map(tab => (
            <button key={tab.role} className={role === tab.role ? 'active' : ''} onClick={() => setRole(tab.role)}>
              {tab.label}
            </button>
          ))}
        </nav>
        {progress && (
          <small className="progress">
            已定案 {progress.final}/{progress.total} · 待协调 {progress.adjudication} · 等待对方 {progress.awaiting} · 语料 r{progress.corpusRevision}
          </small>
        )}
      </header>
      {role === 'C' ? (
        <AdjudicatorView onProgress={refreshProgress}/>
      ) : (
        <ReviewerView key={role} reviewer={role} onProgress={refreshProgress}/>
      )}
    </main>
  );
}
