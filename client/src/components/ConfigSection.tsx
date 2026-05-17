import { useState, useEffect, useRef } from 'react';
import { ApiError, apiGet, apiPost } from '../api';

interface ConfigSectionProps {
  onSyncComplete: () => void;
}

type SyncStatus = {
  status: 'idle' | 'running' | 'success' | 'error';
  logs: { line: string; stream: 'stdout' | 'stderr'; timestamp: number }[];
  lastLog: { line: string; stream: 'stdout' | 'stderr'; timestamp: number } | null;
  startedAt?: number;
  finishedAt?: number;
  error?: string | null;
};

type YnabConfig = {
  configured: boolean;
  missing: string[];
};

type LoginCheckStatus = {
  valid: boolean;
  message: string;
  payments?: {
    valid: boolean;
    message: string;
  };
  details?: {
    valid: boolean;
    message: string;
    orderId?: string | null;
  };
};

type SyncMode = 'current-month' | 'newest' | 'last-n' | 'date-range';

function ConfigSection({ onSyncComplete }: ConfigSectionProps) {
  const [loginStatus, setLoginStatus] = useState<LoginCheckStatus | null>(null);
  const [ynabConfig, setYnabConfig] = useState<YnabConfig | null>(null);
  const [loading, setLoading] = useState<{ [key: string]: boolean }>({});
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const pollRef = useRef<number | null>(null);
  const [syncMode, setSyncMode] = useState<SyncMode>('current-month');
  const [lastCount, setLastCount] = useState<number>(20);
  const [customRange, setCustomRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [syncValidationError, setSyncValidationError] = useState<string | null>(null);
  const [estimatedDurationMs, setEstimatedDurationMs] = useState<number | null>(null);
  const [progressNow, setProgressNow] = useState(() => Date.now());
  const runningEstimateRef = useRef<number | null>(null);
  const lastFinishedAtRef = useRef<number | null>(null);
  const currentSyncStatus = syncStatus?.status;

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
    if (syncMode === 'newest') {
      return 120000;
    }
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
    if (currentSyncStatus !== 'running') return;
    const id = window.setInterval(() => setProgressNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [currentSyncStatus]);

  useEffect(() => {
    if (currentSyncStatus === 'running') return;
    setProgressNow(Date.now());
  }, [currentSyncStatus]);

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
    if (!currentSyncStatus || currentSyncStatus === 'running') return;
    runningEstimateRef.current = null;
  }, [currentSyncStatus]);

  const fetchSyncStatus = async () => {
    try {
      const data = await apiGet<SyncStatus>('/api/sync-status');
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
      const data = await apiGet<LoginCheckStatus>('/api/check-login');
      setLoginStatus(data);
    } catch (error) {
      setLoginStatus({ valid: false, message: error instanceof ApiError ? error.message : 'Fehler beim Prüfen des Login-Status' });
    } finally {
      setLoading(prev => ({ ...prev, check: false }));
    }
  };

  const checkYnabConfig = async () => {
    setLoading(prev => ({ ...prev, ynabConfig: true }));
    try {
      const data = await apiGet<YnabConfig>('/api/ynab-config');
      setYnabConfig(data);
    } catch (error) {
      setYnabConfig({ configured: false, missing: ['YNAB_TOKEN', 'YNAB_ACCOUNT_ID'] });
      setNotice({
        type: 'error',
        message: error instanceof ApiError ? error.message : 'YNAB-Konfiguration konnte nicht geprüft werden.'
      });
    } finally {
      setLoading(prev => ({ ...prev, ynabConfig: false }));
    }
  };

  const runLogin = async () => {
    setLoading(prev => ({ ...prev, login: true }));
    setNotice(null);
    try {
      const data = await apiPost<{ success: boolean; message?: string }>('/api/login');
      if (data.success) {
        setNotice({ type: 'success', message: 'Login erfolgreich. Bitte prüfen Sie den Browser.' });
        checkLogin(); // Status aktualisieren
      } else {
        setNotice({ type: 'error', message: data.message || 'Login fehlgeschlagen.' });
      }
    } catch (error) {
      setNotice({
        type: 'error',
        message: error instanceof ApiError ? error.message : 'Fehler beim Ausführen des Logins'
      });
    } finally {
      setLoading(prev => ({ ...prev, login: false }));
    }
  };

  const runSync = async () => {
    setSyncValidationError(null);
    setNotice(null);
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

      const data = await apiPost<{ success: boolean; message?: string; output?: string; stderr?: string }>('/api/sync', payload);
      if (data.success) {
        setNotice({ type: 'success', message: 'Sync erfolgreich abgeschlossen.' });
        if (data.output) {
          console.log('[Sync] STDOUT:\n', data.output);
        }
        if (data.stderr) {
          console.log('[Sync] STDERR:\n', data.stderr);
        }
        onSyncComplete();
      } else {
        setNotice({ type: 'error', message: data.message || 'Sync fehlgeschlagen.' });
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
      setNotice({
        type: 'error',
        message: error instanceof ApiError ? error.message : 'Fehler beim Ausführen des Syncs'
      });
    } finally {
      setLoading(prev => ({ ...prev, sync: false }));
      stopPolling();
    }
  };

  useEffect(() => {
    checkLogin();
    checkYnabConfig();
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

      </div>

      {notice && (
        <div className={`inline-notice notice-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          {notice.message}
        </div>
      )}

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
        {loginStatus && (
          <div className="session-checks">
            <div className={loginStatus.payments?.valid ? 'session-check ok' : 'session-check warn'}>
              <span>Zahlungsübersicht</span>
              <strong>{loginStatus.payments?.message ?? 'Nicht geprüft'}</strong>
            </div>
            <div className={loginStatus.details?.valid ? 'session-check ok' : 'session-check warn'}>
              <span>Bestelldetails</span>
              <strong>{loginStatus.details?.message ?? 'Nicht geprüft'}</strong>
              {loginStatus.details?.orderId && <small>Test-Order: {loginStatus.details.orderId}</small>}
            </div>
          </div>
        )}
        {loginStatus?.payments?.valid && loginStatus.details && !loginStatus.details.valid && (
          <p className="config-hint">
            Amazon lässt die Zahlungsübersicht zu, verlangt für Bestelldetails aber Reauth. Starten Sie den Login erneut.
          </p>
        )}
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
        <h3>YNAB Konfiguration</h3>
        <div className="status-display" aria-live="polite">
          {ynabConfig ? (
            <span className={ynabConfig.configured ? 'status-valid' : 'status-invalid'}>
              {ynabConfig.configured
                ? 'YNAB ist konfiguriert'
                : `Fehlt: ${ynabConfig.missing.join(', ')}`}
            </span>
          ) : (
            <span>Prüfe...</span>
          )}
        </div>
        {!ynabConfig?.configured && ynabConfig && (
          <p className="config-hint">
            Ergänzen Sie die fehlenden Werte in der .env Datei und starten Sie den Server neu.
          </p>
        )}
        <button
          onClick={checkYnabConfig}
          disabled={loading.ynabConfig}
          className="btn-secondary"
        >
          {loading.ynabConfig ? 'Prüfe...' : 'YNAB prüfen'}
        </button>
      </div>

      <div className="config-item">
        <h3>Amazon Transaktionen Sync</h3>

        <div className="timeframe-controls">
          <label className={`sync-option option-current ${syncMode === 'current-month' ? 'active' : ''}`}>
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
            <span className="option-text">Aktueller Monat</span>
          </label>
          <label className={`sync-option option-newest ${syncMode === 'newest' ? 'active' : ''}`}>
            <input
              type="radio"
              name="sync-mode"
              value="newest"
              checked={syncMode === 'newest'}
              onChange={() => {
                setSyncMode('newest');
                setSyncValidationError(null);
              }}
            />
            <span className="option-text">
              Neuste Einträge
              <span className="option-help">Alles seit der letzten erfolgreichen YNAB-Synchronisierung</span>
            </span>
          </label>
          <label className={`sync-option option-last ${syncMode === 'last-n' ? 'active' : ''}`}>
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
            <span className="option-text">
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
            </span>
          </label>
          <label className={`sync-option option-range ${syncMode === 'date-range' ? 'active' : ''}`}>
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
            <span className="option-text">Zeitraum</span>
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
