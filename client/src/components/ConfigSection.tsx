import { useState, useEffect, useRef } from 'react';

interface ConfigSectionProps {
  onSyncComplete: () => void;
}

function ConfigSection({ onSyncComplete }: ConfigSectionProps) {
  const [loginStatus, setLoginStatus] = useState<{ valid: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState<{ [key: string]: boolean }>({});
  const [syncStatus, setSyncStatus] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    logs: { line: string; stream: 'stdout' | 'stderr'; timestamp: number }[];
    lastLog: { line: string; stream: 'stdout' | 'stderr'; timestamp: number } | null;
    startedAt?: number;
    finishedAt?: number;
    error?: string | null;
  } | null>(null);
  const pollRef = useRef<number | null>(null);
  const [syncMode, setSyncMode] = useState<'current-month' | 'last-n' | 'date-range'>('current-month');
  const [lastCount, setLastCount] = useState<number>(20);
  const [customRange, setCustomRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [syncValidationError, setSyncValidationError] = useState<string | null>(null);
  const [estimatedDurationMs, setEstimatedDurationMs] = useState<number | null>(null);
  const [progressNow, setProgressNow] = useState(() => Date.now());
  const runningEstimateRef = useRef<number | null>(null);
  const lastFinishedAtRef = useRef<number | null>(null);

  const formatDuration = (value: number | null | undefined) => {
    if (!Number.isFinite(value) || !value || value <= 0) return '0:00 min';
    const totalSeconds = Math.round(value / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      return `${hours}h ${restMinutes.toString().padStart(2, '0')}m`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')} min`;
  };

  const computeFallbackDuration = () => {
    if (syncMode === 'last-n') {
      const count = Number.isFinite(lastCount) && lastCount > 0 ? Math.floor(lastCount) : 20;
      const perItem = 11000; // empirische Schätzung pro Detailseite
      return Math.min(Math.max(count * perItem, 90000), 12 * 60 * 1000);
    }
    if (syncMode === 'date-range') {
      const start = Date.parse(customRange.start);
      const end = Date.parse(customRange.end);
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        const days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
        return Math.min(Math.max(days * 60000, 120000), 12 * 60 * 1000);
      }
      return 240000;
    }
    return 180000;
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('sync-average-duration');
    if (!stored) return;
    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed > 0) {
      setEstimatedDurationMs(parsed);
    }
  }, []);

  useEffect(() => {
    if (syncStatus?.status !== 'running') return;
    const id = window.setInterval(() => setProgressNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [syncStatus?.status]);

  useEffect(() => {
    if (syncStatus?.status === 'running') return;
    setProgressNow(Date.now());
  }, [syncStatus?.status]);

  useEffect(() => {
    if (!syncStatus || syncStatus.status !== 'success') return;
    if (typeof syncStatus.startedAt !== 'number' || typeof syncStatus.finishedAt !== 'number') return;
    if (syncStatus.finishedAt === lastFinishedAtRef.current) return;
    lastFinishedAtRef.current = syncStatus.finishedAt;
    const duration = syncStatus.finishedAt - syncStatus.startedAt;
    if (!Number.isFinite(duration) || duration <= 0) return;
    setEstimatedDurationMs(prev => {
      const next = prev ? Math.round(prev * 0.5 + duration * 0.5) : duration;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('sync-average-duration', String(next));
      }
      return next;
    });
  }, [syncStatus]);

  useEffect(() => {
    if (!syncStatus || syncStatus.status === 'running') return;
    runningEstimateRef.current = null;
  }, [syncStatus?.status]);

  const fetchSyncStatus = async () => {
    try {
      const response = await fetch('http://localhost:3001/api/sync-status');
      if (!response.ok) return;
      const data = await response.json();
      setSyncStatus(data);
      return data;
    } catch (error) {
      console.error('Sync-Status konnte nicht geladen werden', error);
    }
  };

  const startPolling = () => {
    fetchSyncStatus();
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      fetchSyncStatus();
    }, 1000);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const checkLogin = async () => {
    setLoading(prev => ({ ...prev, check: true }));
    try {
      const response = await fetch('http://localhost:3001/api/check-login');
      const data = await response.json();
      setLoginStatus(data);
    } catch (error) {
      setLoginStatus({ valid: false, message: 'Fehler beim Prüfen des Login-Status' });
    } finally {
      setLoading(prev => ({ ...prev, check: false }));
    }
  };

  const runLogin = async () => {
    setLoading(prev => ({ ...prev, login: true }));
    try {
      const response = await fetch('http://localhost:3001/api/login', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        alert('Login erfolgreich! Bitte prüfen Sie den Browser.');
        checkLogin(); // Status aktualisieren
      } else {
        alert(`Login fehlgeschlagen: ${data.message}`);
      }
    } catch (error) {
      alert('Fehler beim Ausführen des Logins');
    } finally {
      setLoading(prev => ({ ...prev, login: false }));
    }
  };

  const runSync = async () => {
    setSyncValidationError(null);
    try {
      const payload: Record<string, unknown> = { mode: syncMode };

      if (syncMode === 'last-n') {
        if (!Number.isFinite(lastCount) || lastCount <= 0) {
          setSyncValidationError('Bitte geben Sie eine Anzahl größer 0 ein.');
          return;
        }
        payload.lastCount = Math.floor(lastCount);
      }

      if (syncMode === 'date-range') {
        if (!customRange.start || !customRange.end) {
          setSyncValidationError('Bitte Start- und Enddatum angeben.');
          return;
        }
        const start = Date.parse(customRange.start);
        const end = Date.parse(customRange.end);
        if (Number.isNaN(start) || Number.isNaN(end)) {
          setSyncValidationError('Ungültige Datumsangabe.');
          return;
        }
        if (start > end) {
          setSyncValidationError('Startdatum darf nicht nach dem Enddatum liegen.');
          return;
        }
        payload.startDate = customRange.start;
        payload.endDate = customRange.end;
      }

      runningEstimateRef.current = Math.max(60000, estimatedDurationMs ?? computeFallbackDuration());

      setLoading(prev => ({ ...prev, sync: true }));
      startPolling();

      const response = await fetch('http://localhost:3001/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (data.success) {
        alert('Sync erfolgreich!');
        if (data.output) {
          console.log('[Sync] STDOUT:\n', data.output);
        }
        if (data.stderr) {
          console.log('[Sync] STDERR:\n', data.stderr);
        }
        onSyncComplete();
      } else {
        console.error('Sync fehlgeschlagen:', data.message);
        if (data.output) {
          console.error('[Sync] STDOUT:\n', data.output);
        }
        if (data.stderr) {
          console.error('[Sync] STDERR:\n', data.stderr);
        }
      }
      await fetchSyncStatus();
    } catch (error) {
      console.error('Fehler beim Ausführen des Syncs', error);
    } finally {
      setLoading(prev => ({ ...prev, sync: false }));
      stopPolling();
    }
  };

  useEffect(() => {
    checkLogin();
    fetchSyncStatus();

    return () => {
      stopPolling();
    };
  }, []);

  const renderSyncInfo = () => {
    if (!syncStatus) return null;
    const { status, error, lastLog, startedAt, finishedAt } = syncStatus;

    if (status === 'running') {
      const baseline = Math.max(60000, runningEstimateRef.current ?? estimatedDurationMs ?? computeFallbackDuration());
      const start = typeof startedAt === 'number' ? startedAt : Date.now();
      const elapsed = Math.max(0, progressNow - start);
      const target = Math.max(baseline, elapsed + 1000);
      const ratio = target > 0 ? Math.min(1, elapsed / target) : 0;
      const fillPercent = Math.min(100, Math.max(4, ratio * 100));
      const displayPercent = Math.min(100, Math.round(ratio * 100));
      const remaining = Math.max(0, target - elapsed);
      const etaTime = remaining > 60000
        ? new Date(Date.now() + remaining).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
        : null;
      const hintText = estimatedDurationMs
        ? `Schätzung basierend auf der letzten Laufzeit (${formatDuration(estimatedDurationMs)}).`
        : 'Schätzung basierend auf den aktuellen Optionen.';

      return (
        <div className="sync-status-info status-running">
          <div className="sync-status-label">Sync läuft…</div>
          <div className="sync-progress">
            <div
              className="sync-progress-track"
              role="progressbar"
              aria-valuenow={displayPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="sync-progress-fill" style={{ width: `${fillPercent}%` }} />
            </div>
            <div className="sync-progress-meta">
              <span className="sync-progress-value">{displayPercent}%</span>
              <span>Laufzeit: {formatDuration(elapsed)}</span>
              <span>Rest ca.: {remaining < 5000 ? 'gleich fertig' : formatDuration(remaining)}</span>
              {etaTime && <span>Fertig um {etaTime} Uhr</span>}
            </div>
            <div className="sync-progress-hint">{hintText}</div>
          </div>
        </div>
      );
    }

    if (status === 'success') {
      const duration = typeof startedAt === 'number' && typeof finishedAt === 'number'
        ? Math.max(0, finishedAt - startedAt)
        : null;
      const finishedLabel = typeof finishedAt === 'number'
        ? new Date(finishedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
        : null;

      return (
        <div className="sync-status-info status-success">
          <div className="sync-status-label">Sync abgeschlossen</div>
          <div className="sync-progress-meta">
            {duration !== null && <span>Gesamtdauer: {formatDuration(duration)}</span>}
            {finishedLabel && <span>Fertig um {finishedLabel} Uhr</span>}
          </div>
        </div>
      );
    }

    if (status === 'error') {
      return (
        <div className="sync-status-info status-error">
          <div className="sync-status-label">Sync fehlgeschlagen</div>
          {error && <div className="sync-status-error">{error}</div>}
          {lastLog?.line && <div className="sync-status-single">{lastLog.line}</div>}
        </div>
      );
    }

    return null;
  };

  return (
    <section className="config-section">
      <div className="config-heading">
        <h2>Konfiguration</h2>
        <p>Steuern Sie Login und Sync-Einstellungen, bevor Sie Transaktionen importieren.</p>
      </div>

      <div className="config-item">
        <h3>Amazon Login Status</h3>
        <div className="status-display" aria-live="polite">
          {loginStatus ? (
            <span className={loginStatus.valid ? 'status-valid' : 'status-invalid'}>
              {loginStatus.message}
            </span>
          ) : (
            <span>Prüfe...</span>
          )}
        </div>
        <div className="button-group">
          <button
            onClick={checkLogin}
            disabled={loading.check}
            className="btn-secondary"
          >
            {loading.check ? 'Prüfe...' : 'Status prüfen'}
          </button>
          <button
            onClick={runLogin}
            disabled={loading.login}
            className="btn-primary"
          >
            {loading.login ? 'Login läuft...' : 'Login starten'}
          </button>
        </div>
      </div>

      <div className="config-item">
        <h3>Amazon Transaktionen Sync</h3>
        <p>Lädt die neuesten Transaktionen von Amazon.</p>
        <div className="timeframe-controls">
          <label>
            <input
              type="radio"
              name="sync-mode"
              value="current-month"
              checked={syncMode === 'current-month'}
              onChange={() => {
                setSyncMode('current-month');
                setSyncValidationError(null);
              }}
            />
            Aktueller Monat
          </label>
          <label className={`option-last ${syncMode === 'last-n' ? 'active' : ''}`}>
            <input
              type="radio"
              name="sync-mode"
              value="last-n"
              checked={syncMode === 'last-n'}
              onChange={() => {
                setSyncMode('last-n');
                setSyncValidationError(null);
              }}
            />
            Letzte
            <input
              type="number"
              min={1}
              value={lastCount}
              onChange={(e) => {
                setLastCount(Number(e.target.value));
                setSyncValidationError(null);
              }}
              disabled={syncMode !== 'last-n'}
            />
            Einträge
          </label>
          <label className={`option-range ${syncMode === 'date-range' ? 'active' : ''}`}>
            <input
              type="radio"
              name="sync-mode"
              value="date-range"
              checked={syncMode === 'date-range'}
              onChange={() => {
                setSyncMode('date-range');
                setSyncValidationError(null);
              }}
            />
            Zeitraum
          </label>
          {syncMode === 'date-range' && (
            <div className="date-range-inputs">
              <label>
                Von
                <input
                  type="date"
                  value={customRange.start}
                  onChange={(e) => {
                    setCustomRange(prev => ({ ...prev, start: e.target.value }));
                    setSyncValidationError(null);
                  }}
                />
              </label>
              <label>
                Bis
                <input
                  type="date"
                  value={customRange.end}
                  onChange={(e) => {
                    setCustomRange(prev => ({ ...prev, end: e.target.value }));
                    setSyncValidationError(null);
                  }}
                />
              </label>
            </div>
          )}
        </div>
        {syncValidationError && <div className="form-error">{syncValidationError}</div>}
        <button
          onClick={runSync}
          disabled={loading.sync}
          className="btn-primary"
        >
          {loading.sync ? 'Sync läuft...' : 'Sync starten'}
        </button>
        {renderSyncInfo()}
      </div>
    </section>
  );
}

export default ConfigSection;
