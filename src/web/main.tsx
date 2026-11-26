import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActivityFeedItem, BrowserState, ComputerState, ComputerView, RunDetail, RunEventView, RunSummary, SessionView, TaskArtifact } from '../shared/types.ts';
import './style.css';

type View = 'chat' | 'activity' | 'computer';

function appPath(path: string): string {
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return base + path.replace(/^\/+/, '');
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url.startsWith('/') ? appPath(url) : url, { ...init, credentials: 'same-origin', headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || '请求失败，请稍后重试');
  return value;
}

function statusLabel(status: RunSummary['status']): string {
  const values: Record<RunSummary['status'], string> = {
    queued: '排队中', working: '工作中', waiting_for_user: '等待你', done: '已完成', failed: '失败', stopped: '已停止',
  };
  return values[status];
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function traceTimeLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

function durationLabel(value: unknown): string {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function sizeLabel(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function traceDetails(details: unknown) {
  if (!details || typeof details !== 'object') return null;
  return <details className="trace-details"><summary>结构化详情</summary><pre>{JSON.stringify(details, null, 2)}</pre></details>;
}

function RunGlyph() {
  return <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>;
}

function Login({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onLogin(username, password); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); }
    finally { setBusy(false); }
  }
  return <main className="login-page">
    <section className="login-card" aria-label="登录 Coke Super Agent">
      <RunGlyph />
      <p className="eyebrow">YOUR PERSONAL AGENT</p>
      <h1>让 Agent 帮你完成工作</h1>
      <p className="login-copy">登录后继续查看任务、活动和个人云电脑。</p>
      <form onSubmit={event => void submit(event)}>
        <label>用户名<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required /></label>
        <label>密码<input autoComplete="current-password" type="password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button login-button" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
      </form>
      <p className="local-note">本地测试环境提供 Alice 与 Bob 两个独立租户账号。</p>
    </section>
  </main>;
}

function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [tasks, setTasks] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [view, setView] = useState<View>('chat');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [debugMode, setDebugMode] = useState(() => localStorage.getItem('csa-debug-mode') === 'true');

  function toggleDebugMode() {
    setDebugMode(current => {
      const next = !current;
      localStorage.setItem('csa-debug-mode', String(next));
      return next;
    });
  }

  async function loadTasks() {
    const result = await api<{ tasks: RunSummary[] }>('/api/tasks');
    setTasks(result.tasks);
    setSelectedId(current => current && result.tasks.some(task => task.id === current) ? current : result.tasks[0]?.id || null);
  }

  useEffect(() => {
    let active = true;
    void api<{ session: SessionView }>('/api/auth/session').then(async result => {
      if (!active) return;
      setSession(result.session);
      try { await loadTasks(); } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : '任务列表读取失败'); }
    }).catch(() => { if (active) setSession(null); }).finally(() => { if (active) setAuthChecked(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session || !selectedId) { setDetail(null); return; }
    let active = true;
    const refresh = () => api<{ task: RunDetail }>('/api/tasks/' + encodeURIComponent(selectedId)).then(result => { if (active) setDetail(result.task); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '任务读取失败'); });
    void refresh();
    const source = new EventSource(appPath('/api/tasks/' + encodeURIComponent(selectedId) + '/events'));
    source.addEventListener('run_event', event => {
      const data = event as MessageEvent<string>;
      try {
        const next = JSON.parse(data.data) as RunEventView;
        setDetail(current => current ? { ...current, events: current.events.some(item => item.id === next.id) ? current.events : [...current.events, next] } : current);
        void loadTasks();
      } catch { setError('收到的任务事件无法读取'); }
    });
    source.addEventListener('stream_error', () => { source.close(); });
    return () => { active = false; source.close(); };
  }, [session?.tenant.id, selectedId]);

  const selected = useMemo(() => tasks.find(task => task.id === selectedId) || null, [tasks, selectedId]);

  useEffect(() => {
    if (!session || !selectedId) { setArtifacts([]); setArtifactsError(''); setArtifactsLoading(false); return; }
    let active = true;
    setArtifacts([]);
    setArtifactsError('');
    setPreviewPath(null);
    setArtifactsLoading(true);
    void api<{ artifacts: TaskArtifact[] }>('/api/tasks/' + encodeURIComponent(selectedId) + '/artifacts')
      .then(result => { if (active) setArtifacts(result.artifacts); })
      .catch(reason => { if (active) setArtifactsError(reason instanceof Error ? reason.message : '任务文件读取失败'); })
      .finally(() => { if (active) setArtifactsLoading(false); });
    return () => { active = false; };
  }, [session?.tenant.id, selectedId, selected?.status]);

  async function signIn(username: string, password: string) {
    const result = await api<{ session: SessionView }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    setSession(result.session); setError('');
    const list = await api<{ tasks: RunSummary[] }>('/api/tasks');
    setTasks(list.tasks); setSelectedId(list.tasks[0]?.id || null);
  }

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); }
    finally { setSession(null); setTasks([]); setSelectedId(null); setDetail(null); setArtifacts([]); setArtifactsError(''); setPreviewPath(null); setView('chat'); }
  }

  async function createTask(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const canContinue = selected && ['done', 'waiting_for_user', 'failed'].includes(selected.status);
      const endpoint = canContinue ? '/api/tasks/' + encodeURIComponent(selected.id) + '/reply' : '/api/tasks';
      const result = await api<{ task: RunSummary }>(endpoint, { method: 'POST', body: JSON.stringify({ prompt: draft.trim() }) });
      setDraft(''); setView('chat');
      setTasks(current => [result.task, ...current.filter(task => task.id !== result.task.id)]);
      setSelectedId(result.task.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '任务暂时无法创建'); }
    finally { setBusy(false); }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); void createTask();
    }
  }

  if (!authChecked) return <main className="loading-page"><RunGlyph /><span>正在连接你的工作区…</span></main>;
  if (!session) return <Login onLogin={signIn} />;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><RunGlyph /><span>Coke Super Agent</span></div>
      <button className="new-task-button" onClick={() => { setSelectedId(null); setDetail(null); setView('chat'); setDraft(''); }}><span aria-hidden="true">＋</span> 新任务</button>
      <div className="side-section-label">工作区</div>
      <nav className="primary-nav" aria-label="主导航">
        <button className={view === 'chat' ? 'selected' : ''} onClick={() => setView('chat')}><span>◌</span>任务</button>
        <button className={view === 'activity' ? 'selected' : ''} onClick={() => setView('activity')}><span>◷</span>活动</button>
        <button className={view === 'computer' ? 'selected' : ''} onClick={() => setView('computer')}><span>▣</span>云电脑</button>
      </nav>
      <div className="side-section-label recent-heading">最近任务 <span>{tasks.length}</span></div>
      <div className="task-list" aria-label="最近任务">
        {tasks.length === 0 && <p className="sidebar-empty">你的任务会显示在这里</p>}
        {tasks.map(task => <button key={task.id} className={'task-nav-item' + (selectedId === task.id ? ' selected' : '')} onClick={() => { setSelectedId(task.id); setView('chat'); }}>
          <span className={'task-dot ' + task.status} /><span className="task-nav-copy"><strong>{task.title}</strong><small>{timeLabel(task.updatedAt)}</small></span>
        </button>)}
      </div>
      <div className="account-card">
        <div className="account-avatar">{session.user.displayName.slice(0, 1).toUpperCase()}</div>
        <div className="account-copy"><strong>{session.user.displayName}</strong><small>{session.tenant.displayName}</small></div>
        <button aria-label="退出登录" title="退出登录" onClick={() => void signOut()}>↗</button>
      </div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="mobile-brand"><RunGlyph /><span>Coke Super Agent</span></div>
        <div className="topbar-title">{view === 'chat' ? (selected?.title || '你的个人 Agent') : view === 'activity' ? '活动' : '云电脑'}</div>
        <div className="topbar-right"><span className="tenant-chip"><i />{session.tenant.slug}</span><button className="topbar-avatar" aria-label={session.user.displayName}>{session.user.displayName.slice(0, 1).toUpperCase()}</button></div>
      </header>

      {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭">×</button></div>}

      {view === 'computer' ? <ComputerPanel tenant={session.tenant.displayName} /> : view === 'activity' ? <ActivityPanel tenantId={session.tenant.id} tasks={tasks} selected={selected} debugMode={debugMode} onToggleDebug={toggleDebugMode} onOpenTask={id => { setSelectedId(id); setView('chat'); }} /> : <section className="chat-view">
        <div className="chat-scroll">
          {!selected ? <div className="welcome-state">
            <div className="welcome-orbit"><RunGlyph /></div>
            <p className="eyebrow">A PERSONAL AGENT FOR YOUR WORK</p>
            <h1>你好，{session.user.displayName}</h1>
            <p className="welcome-copy">告诉我你想完成什么。我会在你的个人工作区里继续处理。</p>
            <div className="suggestions"><button onClick={() => setDraft('帮我研究一个主题，并整理成简明报告。')}>研究一个主题 <span>↗</span></button><button onClick={() => setDraft('打开云电脑，帮我整理一个工作文件。')}>使用云电脑 <span>↗</span></button><button onClick={() => setDraft('写一个 Python 脚本并运行，生成结果文件。')}>运行代码 <span>↗</span></button></div>
          </div> : <div className="conversation" aria-live="polite">
            <div className="message user-message"><div className="message-avatar">{session.user.displayName.slice(0, 1).toUpperCase()}</div><div className="message-copy"><div className="message-meta"><strong>{session.user.displayName}</strong><time>{timeLabel(selected.createdAt)}</time></div><p>{detail?.prompt || selected.prompt}</p></div></div>
            <div className="run-status-card"><span className={'run-status-icon ' + selected.status}>{selected.status === 'queued' ? '◷' : selected.status === 'done' ? '✓' : '•'}</span><div className="run-status-copy"><strong>{statusLabel(selected.status)}</strong><p>{selected.status === 'queued' ? '任务已进入队列，Agent 将在你的 Linux microVM 中处理。' : selected.status === 'waiting_for_user' ? '请打开云电脑完成登录或验证码，然后在这里发送继续指令。' : selected.status === 'working' ? 'Agent 正在你的 Linux microVM 中处理任务。' : selected.status === 'failed' ? '运行失败；打开调试模式查看失败阶段和完整链路。' : '任务活动已保存。'}</p>{debugMode && <code className="run-correlation">Run ID · {selected.id}</code>}</div><DebugToggle enabled={debugMode} onToggle={toggleDebugMode} />
            </div>
            {(() => {
              const events = detail?.events || [];
              const failure = [...events].reverse().find(item => item.type === 'failed');
              const traceFailure = [...events].reverse().find(item => item.type === 'debug' && item.payload.level === 'error');
              const showFailure = selected.status === 'failed' || Boolean(traceFailure);
              if (!showFailure) return null;
              const bestMessage = String(traceFailure?.payload.message || failure?.payload.message || 'Agent 在未能确认最终结果前退出。');
              return <div className="run-failure" role="alert"><span>!</span><div><strong>{selected.status === 'failed' ? '任务失败' : '执行链路报错'}</strong><p>{bestMessage}</p>{traceFailure && <small>#{traceFailure.sequence} · {String(traceFailure.payload.component || 'runtime')} · {String(traceFailure.payload.stage || 'unknown-stage')}</small>}</div></div>;
            })()}
            {(detail?.events || []).filter(item => debugMode || item.type !== 'debug').map(item => {
              const isTrace = item.type === 'debug';
              const isDebug = isTrace || (debugMode && typeof item.payload.component === 'string' && typeof item.payload.stage === 'string');
              const level = isDebug ? String(item.payload.level || (item.type === 'failed' ? 'error' : item.type === 'waiting_for_user' ? 'warning' : 'info')) : '';
              const details = isDebug ? item.payload.details : undefined;
              const duration = isDebug ? durationLabel(item.payload.durationMs) : '';
              return <div className={'event-line' + (isDebug ? ` debug ${level}` : '')} key={item.id}><span className="event-marker" /><div><time>{isDebug ? traceTimeLabel(item.createdAt) : timeLabel(item.createdAt)}{isDebug && <span>#{item.sequence} · {String(item.payload.component || 'runtime')} · {String(item.payload.stage || 'event')}{duration ? ` · ${duration}` : ''}</span>}</time><p>{String(item.payload.message || item.type)}</p>{isDebug && traceDetails(details)}</div></div>;
            })}
            {(artifacts.length > 0 || artifactsLoading || artifactsError) && <section className="artifact-list" aria-label="任务文件与产物">
              <div className="artifact-heading"><strong>文件与产物</strong>{artifactsLoading && <span>正在读取…</span>}</div>
              {artifactsError && <p className="artifact-error">{artifactsError}</p>}
              {artifacts.map(artifact => {
                const baseUrl = appPath('/api/tasks/' + encodeURIComponent(selected.id) + '/artifacts/download?path=' + encodeURIComponent(artifact.path));
                const isPreviewed = previewPath === artifact.path;
                const glyph = artifact.mediaType.startsWith('image/') ? '▧' : artifact.mediaType === 'text/html' ? '◉' : '▤';
                return <article className="artifact-card" key={artifact.path}>
                  <span className="artifact-icon" aria-hidden="true">{glyph}</span>
                  <span className="artifact-copy"><strong title={artifact.path}>{artifact.name}</strong><small>{sizeLabel(artifact.sizeBytes)}{artifact.previewable ? ' · 可预览' : ''}</small></span>
                  {artifact.previewable && <button className="artifact-action" type="button" aria-expanded={isPreviewed} onClick={() => setPreviewPath(isPreviewed ? null : artifact.path)}>{isPreviewed ? '收起预览' : '预览'}</button>}
                  <a className="artifact-action" href={baseUrl} download={artifact.name}>下载</a>
                  {isPreviewed && <iframe className="artifact-preview" title={`预览 ${artifact.name}`} src={baseUrl + '&mode=preview'} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
                </article>;
              })}
            </section>}
          </div>}
        </div>
        <form className="composer" onSubmit={event => void createTask(event)}>
          <textarea aria-label="给 Coke Super Agent 发送消息" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="描述你想完成的任务…" rows={2} maxLength={10000} />
          <div className="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button className="send-button" disabled={busy || !draft.trim()} aria-label="发送任务">{busy ? '…' : '↑'}</button></div>
        </form>
      </section>}
    </main>
  </div>;
}

function ActivityPanel({ tenantId, tasks, selected, debugMode, onToggleDebug, onOpenTask }: { tenantId: string; tasks: RunSummary[]; selected: RunSummary | null; debugMode: boolean; onToggleDebug: () => void; onOpenTask: (id: string) => void }) {
  const [activity, setActivity] = useState<ActivityFeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [activityError, setActivityError] = useState('');
  const generation = useRef(0);
  const loadedOlder = useRef(false);

  useEffect(() => {
    const pageGeneration = ++generation.current;
    let active = true;
    let initial = true;
    setActivity([]);
    setNextCursor(null);
    setActivityError('');
    setLoading(true);
    setLoadingOlder(false);
    loadedOlder.current = false;

    const refresh = async () => {
      try {
        const query = new URLSearchParams({ limit: '50', ...(debugMode ? { debug: '1' } : {}) });
        const page = await api<{ items: ActivityFeedItem[]; nextCursor: number | null }>('/api/activity?' + query);
        if (!active || generation.current !== pageGeneration) return;
        setActivity(current => {
          const byId = new Map(current.map(item => [item.event.id, item]));
          for (const item of page.items) byId.set(item.event.id, item);
          return [...byId.values()].sort((a, b) => b.event.id - a.event.id);
        });
        if (initial || !loadedOlder.current) setNextCursor(page.nextCursor);
        initial = false;
        setActivityError('');
      } catch (reason) {
        if (active && generation.current === pageGeneration) setActivityError(reason instanceof Error ? reason.message : '活动读取失败');
      } finally {
        if (active && generation.current === pageGeneration) setLoading(false);
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [tenantId, debugMode]);

  async function loadOlder() {
    if (nextCursor === null || loadingOlder) return;
    const pageGeneration = generation.current;
    setLoadingOlder(true);
    setActivityError('');
    try {
      const query = new URLSearchParams({ limit: '50', before: String(nextCursor), ...(debugMode ? { debug: '1' } : {}) });
      const page = await api<{ items: ActivityFeedItem[]; nextCursor: number | null }>('/api/activity?' + query);
      if (generation.current !== pageGeneration) return;
      setActivity(current => {
        const byId = new Map(current.map(item => [item.event.id, item]));
        for (const item of page.items) byId.set(item.event.id, item);
        return [...byId.values()].sort((a, b) => b.event.id - a.event.id);
      });
      setNextCursor(page.nextCursor);
      loadedOlder.current = true;
    } catch (reason) {
      if (generation.current === pageGeneration) setActivityError(reason instanceof Error ? reason.message : '更早的活动读取失败');
    } finally {
      if (generation.current === pageGeneration) setLoadingOlder(false);
    }
  }

  return <section className="content-page">
    <div className="content-heading content-heading-row"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>活动</h1><p>按时间查看所有任务的进度；打开任一记录可回到对应任务。</p></div><DebugToggle enabled={debugMode} onToggle={onToggleDebug} /></div>
    {tasks.length === 0 ? <div className="empty-card">还没有任务活动。创建一个任务后，进度会显示在这里。</div> : <div className="activity-layout">
      <div className="activity-task-list"><h2>最近任务</h2>{tasks.map(task => <button className={'activity-task' + (selected?.id === task.id ? ' selected' : '')} key={task.id} onClick={() => onOpenTask(task.id)}><span className={'task-dot ' + task.status} /><span><strong>{task.title}</strong><small>{statusLabel(task.status)} · {timeLabel(task.updatedAt)}</small></span><b>›</b></button>)}</div>
      <div className="activity-events"><h2>最近活动<small>{debugMode ? ' · 含调试链路' : ' · 普通进度'}</small></h2>
      {activityError && <p className="activity-error" role="alert">{activityError}</p>}
      {loading && activity.length === 0 ? <p className="muted">正在读取活动…</p> : activity.length ? activity.map(({ event, runId, title, status }) => {
        const isTrace = event.type === 'debug';
        const isDebug = isTrace || (debugMode && typeof event.payload.component === 'string' && typeof event.payload.stage === 'string');
        const level = isDebug ? String(event.payload.level || (event.type === 'failed' ? 'error' : event.type === 'waiting_for_user' ? 'warning' : 'info')) : '';
        const duration = isDebug ? durationLabel(event.payload.durationMs) : '';
        return <article className={'activity-event' + (isDebug ? ` debug ${level}` : '')} key={event.id}>
          <span className="event-marker" />
          <div className="activity-event-content">
            <div className="activity-event-top"><div><strong>{String(event.payload.message || event.type)}</strong>{isDebug && <small>#{event.sequence} · {String(event.payload.component || 'runtime')} · {String(event.payload.stage || 'event')}{duration ? ` · ${duration}` : ''}</small>}</div><time>{isDebug ? traceTimeLabel(event.createdAt) : timeLabel(event.createdAt)}</time></div>
            {isDebug && traceDetails(event.payload.details)}
            <button className="activity-open-task" type="button" onClick={() => onOpenTask(runId)}><span className={'task-dot ' + status} />{title} <span>打开任务 →</span></button>
          </div>
        </article>;
      }) : <p className="muted">还没有活动事件。创建一个任务后，进度会显示在这里。</p>}
      {nextCursor !== null && <button className="activity-load-older" type="button" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? '正在加载…' : '加载更早记录'}</button>}
      </div>
    </div>}
  </section>;
}

function DebugToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return <button className={'debug-toggle' + (enabled ? ' enabled' : '')} type="button" aria-pressed={enabled} onClick={onToggle}><span>{enabled ? '●' : '○'}</span>调试模式 {enabled ? '开启' : '关闭'}</button>;
}

function ComputerPanel({ tenant }: { tenant: string }) {
  const [computer, setComputer] = useState<ComputerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [desktopConnection, setDesktopConnection] = useState(0);
  const [browserState, setBrowserState] = useState<BrowserState>('unavailable');
  const [retryingBrowser, setRetryingBrowser] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => api<{ computer: ComputerView }>('/api/computer')
      .then(result => { if (active) setComputer(result.computer); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '云电脑状态读取失败'); })
      .finally(() => { if (active) setLoading(false); });
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (computer?.state !== 'running' || computer.desktopState !== 'ready') {
      setBrowserState('unavailable');
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await api<{ browserState: BrowserState }>('/api/computer/browser');
        if (active) setBrowserState(result.browserState);
      } catch {
        if (active) setBrowserState('unknown');
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 10_000);
      }
    };
    void refresh();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [computer?.state, computer?.desktopState]);

  async function startComputer() {
    setStarting(true); setError('');
    try {
      const result = await api<{ computer: ComputerView }>('/api/computer/start', { method: 'POST', body: '{}' });
      setComputer(result.computer);
      if (result.computer.desktopState === 'ready') setDesktopConnection(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '云电脑暂时无法启动'); }
    finally { setStarting(false); }
  }

  async function retryBrowser() {
    setRetryingBrowser(true);
    setError('');
    try {
      await api<{ queued: boolean }>('/api/computer/browser/retry', { method: 'POST', body: '{}' });
      setBrowserState('starting');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '浏览器重试失败');
    } finally {
      setRetryingBrowser(false);
    }
  }

  const labels: Record<ComputerState, string> = {
    not_created: '云电脑尚未启动', creating: '正在启动 Linux microVM', running: 'Linux microVM 已运行',
    paused: 'Linux microVM 已暂停', failed: '上次启动失败',
  };
  const desktopUrl = appPath('/novnc/vnc.html?autoconnect=true&resize=scale&path=' + encodeURIComponent(appPath('/api/computer/desktop/websockify')));
  const desktopReady = computer?.state === 'running' && computer.desktopState === 'ready';
  const computerFailed = computer?.state === 'failed' || computer?.desktopState === 'failed';

  if (desktopReady) return <section className="computer-page desktop-ready">
    <div className="desktop-view">
      <header className="desktop-toolbar">
        <div><span className="status-pulse running" />{tenant} 的 Linux 云电脑</div>
        <div>
          <span className={'desktop-browser-status ' + browserState} role={browserState === 'failed' ? 'alert' : 'status'} aria-live="polite">
            {{ unavailable: '浏览器状态不可用', starting: '浏览器启动中', ready: '浏览器可操作', failed: '浏览器控制不可用', unknown: '浏览器状态未知' }[browserState]}
          </span>
          {browserState === 'failed' && <button type="button" onClick={() => void retryBrowser()} disabled={retryingBrowser}>{retryingBrowser ? '正在重试…' : '重试浏览器'}</button>}
          <button type="button" onClick={() => void startComputer()} disabled={starting}>{starting ? '正在连接…' : '重新连接'}</button>
          <a href={desktopUrl} target="_blank" rel="noreferrer">在新窗口打开</a>
        </div>
      </header>
      {error && <p className="form-error computer-error" role="alert">{error}</p>}
      <iframe key={desktopConnection} className="desktop-frame" title={`${tenant} 的 Linux 云电脑`} src={desktopUrl} allow="clipboard-read; clipboard-write; fullscreen" />
    </div>
  </section>;

  const desktopStatus = computer?.state === 'running' ? {
    pending: '桌面组件已预装，等待启动会话', installing: '正在启动 Linux 桌面会话', ready: 'Linux 桌面已就绪', failed: '桌面启动失败，可重试',
  }[computer.desktopState] : '';
  const canStart = !computer || computer.state !== 'running' || computer.desktopState === 'pending' || computer.desktopState === 'failed';

  return <section className="computer-page">
    <div className="computer-card">
      <div className="computer-illustration"><div className="computer-window"><i /><i /><i /><div className="window-line" /><div className="window-line short" /><span>›_</span></div><div className="computer-stand" /></div>
      <p className="eyebrow">PRIVATE LINUX WORKSPACE</p>
      <h1>{tenant} 的云电脑</h1>
      <p>每个租户使用自己的持久 Linux microVM，包含 XFCE 桌面、Chromium、终端、Node.js 和 Python。浏览器与桌面操作直接在这台租户电脑中进行。</p>
      <div className={'computer-status' + (computerFailed ? ' failed' : '')} role={computerFailed ? 'alert' : 'status'} aria-live="polite"><span className={'status-pulse ' + (computerFailed ? 'failed' : computer?.state || 'not_created')} />{loading ? '正在读取云电脑状态' : desktopStatus || labels[computer?.state || 'not_created']}</div>
      {canStart && <button className="primary-button computer-action" onClick={() => void startComputer()} disabled={loading || starting || computer?.state === 'creating'}>{starting ? '正在准备 Linux 云电脑…' : computer?.state === 'paused' ? '恢复 Linux microVM' : computer?.state === 'running' && computer.desktopState === 'failed' ? '重试桌面启动' : computer?.state === 'running' ? '启动桌面会话' : computer?.state === 'creating' ? '正在准备…' : '启动 Linux 云电脑'}</button>}
      {error && <p className="form-error computer-error" role="alert">{error}</p>}
      <p className="computer-footnote">桌面、Chrome、Node.js、Python 和 Agent Runtime 由模板预装。启动时会检查组件并运行桌面会话；你也可以在 Linux 终端中用 apt 安装其他软件。浏览器配置和文件会保留在这台租户电脑中。</p>
    </div>
  </section>;
}

createRoot(document.getElementById('root')!).render(<App />);
