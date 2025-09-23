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
    const { status, lastLog, error } = syncStatus;

    let label: string | null = null;
    if (status === 'running') {
      label = 'Sync läuft...';
    } else if (status === 'success') {
      label = 'Sync abgeschlossen';
    } else if (status === 'error') {
      label = 'Sync fehlgeschlagen';
    }

    if (!label) return null;

    const trailingLogs = syncStatus.logs ? syncStatus.logs.slice(-3) : [];

    return (
      <div className={`sync-status-info status-${status}`}>
        <div className="sync-status-label">{label}</div>
        {status === 'error' && error && (
          <div className="sync-status-error">{error}</div>
        )}
        {trailingLogs.length > 0 && (
          <ul className="sync-status-logs">
            {trailingLogs.map((log, idx) => (
              <li key={`${log.timestamp}-${idx}`}>{log.line}</li>
            ))}
          </ul>
        )}
        {trailingLogs.length === 0 && lastLog?.line && (
          <div className="sync-status-single">{lastLog.line}</div>
        )}
      </div>
    );
  };

  return (
    <section className="config-section">
      <h2>Konfiguration</h2>

      <div className="config-item">
        <h3>Amazon Login Status</h3>
        <div className="status-display">
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
