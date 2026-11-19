import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComputerState, ComputerView, RunDetail, RunEventView, RunSummary, SessionView } from '../shared/types.ts';
import './style.css';

type View = 'chat' | 'activity' | 'computer';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
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
  const [view, setView] = useState<View>('chat');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
    const source = new EventSource('/api/tasks/' + encodeURIComponent(selectedId) + '/events');
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

  async function signIn(username: string, password: string) {
    const result = await api<{ session: SessionView }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    setSession(result.session); setError('');
    const list = await api<{ tasks: RunSummary[] }>('/api/tasks');
    setTasks(list.tasks); setSelectedId(list.tasks[0]?.id || null);
  }

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); }
    finally { setSession(null); setTasks([]); setSelectedId(null); setDetail(null); setView('chat'); }
  }

  async function createTask(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ task: RunSummary }>('/api/tasks', { method: 'POST', body: JSON.stringify({ prompt: draft.trim() }) });
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

      {view === 'computer' ? <ComputerPanel tenant={session.tenant.displayName} /> : view === 'activity' ? <ActivityPanel tasks={tasks} selected={selected} events={detail?.events || []} onOpenTask={id => { setSelectedId(id); setView('chat'); }} /> : <section className="chat-view">
        <div className="chat-scroll">
          {!selected ? <div className="welcome-state">
            <div className="welcome-orbit"><RunGlyph /></div>
            <p className="eyebrow">A PERSONAL AGENT FOR YOUR WORK</p>
            <h1>你好，{session.user.displayName}</h1>
            <p className="welcome-copy">告诉我你想完成什么。我会在你的个人工作区里继续处理。</p>
            <div className="suggestions"><button onClick={() => setDraft('帮我研究一个主题，并整理成简明报告。')}>研究一个主题 <span>↗</span></button><button onClick={() => setDraft('打开云电脑，帮我整理一个工作文件。')}>使用云电脑 <span>↗</span></button><button onClick={() => setDraft('写一个 Python 脚本并运行，生成结果文件。')}>运行代码 <span>↗</span></button></div>
          </div> : <div className="conversation" aria-live="polite">
            <div className="message user-message"><div className="message-avatar">{session.user.displayName.slice(0, 1).toUpperCase()}</div><div className="message-copy"><div className="message-meta"><strong>{session.user.displayName}</strong><time>{timeLabel(selected.createdAt)}</time></div><p>{detail?.prompt || selected.prompt}</p></div></div>
            <div className="run-status-card"><span className={'run-status-icon ' + selected.status}>{selected.status === 'queued' ? '◷' : selected.status === 'done' ? '✓' : '•'}</span><div><strong>{statusLabel(selected.status)}</strong><p>{selected.status === 'queued' ? '任务和事件已保存到 MySQL，等待 Agent Runtime 接入。' : '正在加载任务活动…'}</p></div></div>
            {(detail?.events || []).map(item => <div className="event-line" key={item.id}><span className="event-marker" /><div><time>{timeLabel(item.createdAt)}</time><p>{String(item.payload.message || item.type)}</p></div></div>)}
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

function ActivityPanel({ tasks, selected, events, onOpenTask }: { tasks: RunSummary[]; selected: RunSummary | null; events: RunEventView[]; onOpenTask: (id: string) => void }) {
  const activity = events.map(event => ({ event, task: selected }));
  return <section className="content-page">
    <div className="content-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>活动</h1><p>查看最近任务及其已保存的进度事件。</p></div></div>
    {tasks.length === 0 ? <div className="empty-card">还没有任务活动。创建一个任务后，进度会显示在这里。</div> : <div className="activity-layout">
      <div className="activity-task-list">{tasks.map(task => <button className={'activity-task' + (selected?.id === task.id ? ' selected' : '')} key={task.id} onClick={() => onOpenTask(task.id)}><span className={'task-dot ' + task.status} /><span><strong>{task.title}</strong><small>{statusLabel(task.status)} · {timeLabel(task.updatedAt)}</small></span><b>›</b></button>)}</div>
      <div className="activity-events"><h2>{selected?.title || '选择一个任务'}</h2>{activity.length ? activity.map(({ event }) => <article className="activity-event" key={event.id}><span className="event-marker" /><div><strong>{String(event.payload.message || event.type)}</strong><time>{timeLabel(event.createdAt)}</time></div></article>) : <p className="muted">该任务还没有活动事件。</p>}</div>
    </div>}
  </section>;
}

function ComputerPanel({ tenant }: { tenant: string }) {
  const [computer, setComputer] = useState<ComputerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

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

  async function startComputer() {
    setStarting(true); setError('');
    try {
      const result = await api<{ computer: ComputerView }>('/api/computer/start', { method: 'POST', body: '{}' });
      setComputer(result.computer);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '云电脑暂时无法启动'); }
    finally { setStarting(false); }
  }

  const labels: Record<ComputerState, string> = {
    not_created: '云电脑尚未启动', creating: '正在启动 Linux microVM', running: '基础 Linux microVM 已运行',
    paused: 'Linux microVM 已暂停', failed: '上次启动失败',
  };

  return <section className="computer-page">
    <div className="computer-card">
      <div className="computer-illustration"><div className="computer-window"><i /><i /><i /><div className="window-line" /><div className="window-line short" /><span>›_</span></div><div className="computer-stand" /></div>
      <p className="eyebrow">PRIVATE LINUX WORKSPACE</p>
      <h1>{tenant} 的云电脑</h1>
      <p>每个租户使用自己的持久 Linux microVM。当前接入的是 CubeSandbox 基础模板；图形桌面、Chrome 和 Agent Runtime 随后接入。</p>
      <div className="computer-status"><span className={'status-pulse ' + (computer?.state || 'not_created')} />{loading ? '正在读取云电脑状态' : labels[computer?.state || 'not_created']}</div>
      {(!computer || computer.state !== 'running') && <button className="primary-button computer-action" onClick={() => void startComputer()} disabled={loading || starting || computer?.state === 'creating'}>{starting ? '正在连接 CubeSandbox…' : computer?.state === 'paused' ? '恢复 Linux microVM' : computer?.state === 'creating' ? '正在准备…' : '启动 Linux microVM'}</button>}
      {error && <p className="form-error computer-error" role="alert">{error}</p>}
      <p className="computer-footnote">登录后可启动或恢复租户专属 VM。暂不提供桌面或浏览器画面，直到图形桌面模板接入。</p>
    </div>
  </section>;
}

createRoot(document.getElementById('root')!).render(<App />);
