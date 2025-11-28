uimport { useState } from 'react';
import type { Transaction } from '../App';

const euroFormatter = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR'
});

interface TransactionListProps {
  transactions: Transaction[];
  loading: boolean;
  onRefresh: () => void;
}

type SelectionStatusValue =
  | 'queued'
  | 'synced'
  | 'already-synced'
  | 'invalid-date'
  | 'not-found';

interface FilterSummary {
  count: number;
  examples: string[];
}

interface SyncSelectionStatusEntry {
  status: SelectionStatusValue;
  detail?: string;
}

interface SyncSummarySelection {
  provided: number;
  queuedIds: string[];
  syncedIds: string[];
  alreadySynced: string[];
  invalidDate: string[];
  missingIds: string[];
  statuses: Record<string, SyncSelectionStatusEntry>;
}

interface SyncSummary {
  timestamp: string;
  dryRun: boolean;
  totals?: {
    fileTransactions?: number;
    withOrderId?: number;
    withValidDate?: number;
    eligibleBeforeSelection?: number;
  };
  filters?: {
    invalidDate?: FilterSummary;
    alreadySynced?: FilterSummary;
  };
  flags?: {
    ynabSyncedWithoutId?: FilterSummary;
  };
  candidates?: {
    count: number;
    refunds: number;
    totalAmountMilliunits: number;
  };
  response?: {
    requested: number;
    created: number;
    duplicateImportIds: string[];
    missingImportIds: string[];
    matchedImportIds: number;
    error?: string;
  };
  selection?: SyncSummarySelection;
}

interface SyncResult {
  success: boolean;
  message: string;
  summary?: SyncSummary | null;
  output?: string | null;
  stderr?: string | null;
}

interface SyncResultModalProps {
  result: SyncResult;
  onClose: () => void;
}

function formatCurrencyFromMilliunits(value?: number | null): string | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return euroFormatter.format(value / 1000);
}

function SyncResultModal({ result, onClose }: SyncResultModalProps) {
  const { success, message, summary, output, stderr } = result;
  const selection = summary?.selection;
  const statuses = selection?.statuses ?? {};
  const queuedIds = selection?.queuedIds ?? [];
  const queuedMissing = queuedIds.filter((id) => statuses[id]?.detail === 'missing-ynab-transaction-id');
  const queuedOthers = queuedIds.filter((id) => statuses[id]?.detail !== 'missing-ynab-transaction-id');
  const missingIds = selection?.missingIds ?? [];
  const duplicateImportIds = summary?.response?.duplicateImportIds ?? [];
  const missingImportIds = summary?.response?.missingImportIds ?? [];
  const responseError = summary?.response?.error;
  const totalAmount = formatCurrencyFromMilliunits(summary?.candidates?.totalAmountMilliunits ?? null);
  const timestamp = summary?.timestamp ? new Date(summary.timestamp).toLocaleString('de-DE') : null;
  const filterEntries = [
    { label: 'Ungültiges Datum', data: summary?.filters?.invalidDate },
    { label: 'Bereits synchronisiert', data: summary?.filters?.alreadySynced },
    { label: 'Als synchron markiert (ohne YNAB-ID)', data: summary?.flags?.ynabSyncedWithoutId }
  ].filter((entry) => entry.data && entry.data.count > 0);
  const showOutput = Boolean(output && output.trim().length > 0);
  const showStderr = Boolean(stderr && stderr.trim().length > 0);
  const response = summary?.response;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className={`modal ${success ? 'modal-success' : 'modal-error'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{success ? 'YNAB Sync erfolgreich' : 'YNAB Sync fehlgeschlagen'}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-message">{message}</p>
          {timestamp && <p className="modal-timestamp">Zeitpunkt: {timestamp}</p>}

          {summary && (
            <div className="summary-section">
              <div className="summary-grid">
                <div>
                  <span className="summary-label">Kandidaten</span>
                  <span className="summary-value">{summary.candidates?.count ?? 0}</span>
                </div>
                <div>
                  <span className="summary-label">Übermittelt</span>
                  <span className="summary-value">{response?.requested ?? 0}</span>
                </div>
                <div>
                  <span className="summary-label">Import-IDs bestätigt</span>
                  <span className="summary-value">{response?.matchedImportIds ?? 0}</span>
                </div>
                <div>
                  <span className="summary-label">Gesamtbetrag</span>
                  <span className="summary-value">{totalAmount ?? '–'}</span>
                </div>
              </div>
            </div>
          )}

          {selection && (
            <div className="summary-section">
              <h4>Auswahl</h4>
              <ul>
                <li>Übergeben: {selection.provided}</li>
                <li>Neu synchronisiert: {selection.syncedIds.length}</li>
                <li>Bereits synchronisiert: {selection.alreadySynced.length}</li>
                <li>Ungültiges Datum: {selection.invalidDate.length}</li>
                <li>Nicht gefunden: {missingIds.length}</li>
              </ul>
              {queuedMissing.length > 0 && (
                <details className="summary-details" open={!success}>
                  <summary>Ohne YNAB-Transaktions-ID ({queuedMissing.length})</summary>
                  <div className="summary-tags">
                    {queuedMissing.slice(0, 12).map((id) => (
                      <span key={id} className="tag warning">
                        {id}
                      </span>
                    ))}
                    {queuedMissing.length > 12 && (
                      <span className="tag">+{queuedMissing.length - 12} weitere</span>
                    )}
                  </div>
                </details>
              )}
              {queuedOthers.length > 0 && (
                <details className="summary-details">
                  <summary>Weitere in Warteschlange ({queuedOthers.length})</summary>
                  <div className="summary-tags">
                    {queuedOthers.slice(0, 12).map((id) => (
                      <span key={id} className="tag muted">
                        {id}
                      </span>
                    ))}
                    {queuedOthers.length > 12 && (
                      <span className="tag">+{queuedOthers.length - 12} weitere</span>
                    )}
                  </div>
                </details>
              )}
              {missingIds.length > 0 && (
                <details className="summary-details">
                  <summary>Keine passende Transaktion ({missingIds.length})</summary>
                  <div className="summary-tags">
                    {missingIds.slice(0, 12).map((id) => (
                      <span key={id} className="tag muted">
                        {id}
                      </span>
                    ))}
                    {missingIds.length > 12 && (
                      <span className="tag">+{missingIds.length - 12} weitere</span>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}

          {filterEntries.length > 0 && (
            <div className="summary-section">
              <h4>Ausgeschlossene Transaktionen</h4>
              <ul>
                {filterEntries.map(({ label, data }) => (
                  <li key={label}>
                    <span className="summary-label-inline">{label}:</span> {data!.count}
                    {data!.examples.length > 0 && (
                      <span className="summary-examples"> (z.B. {data!.examples.slice(0, 5).join(', ')})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {response && (
            <div className="summary-section">
              <h4>YNAB Antwort</h4>
              <ul>
                <li>Übermittelt: {response.requested}</li>
                <li>Neue Transaktionen: {response.created}</li>
                <li>Import-IDs bestätigt: {response.matchedImportIds}</li>
                {duplicateImportIds.length > 0 && (
                  <li>
                    Duplikate: {duplicateImportIds.length}
                    <span className="summary-examples"> (z.B. {duplicateImportIds.slice(0, 5).join(', ')})</span>
                  </li>
                )}
                {missingImportIds.length > 0 && (
                  <li className="error-text">
                    Fehlende Import-IDs: {missingImportIds.length}
                    <span className="summary-examples"> (z.B. {missingImportIds.slice(0, 5).join(', ')})</span>
                  </li>
                )}
                {responseError && <li className="error-text">Fehler: {responseError}</li>}
              </ul>
            </div>
          )}

          {showOutput && (
            <details className="summary-details">
              <summary>Standardausgabe anzeigen</summary>
              <pre className="summary-log">{output?.trim()}</pre>
            </details>
          )}

          {showStderr && (
            <details className="summary-details">
              <summary>Fehlerausgabe anzeigen</summary>
              <pre className="summary-log error-text">{stderr?.trim()}</pre>
            </details>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}

function TransactionList({ transactions, loading, onRefresh }: TransactionListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [syncLoading, setSyncLoading] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, { loading: boolean; summary?: string; error?: string; model?: string }>>({});
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const openSyncResult = (result: SyncResult) => setSyncResult(result);
  const closeSyncResult = () => setSyncResult(null);

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allIds = transactions
        .filter(t => t.orderId)
        .map(t => t.orderId!)
        .filter(Boolean);
      setSelectedIds(new Set(allIds));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectTransaction = (orderId: string, checked: boolean) => {
    const newSelected = new Set(selectedIds);
    if (checked) {
      newSelected.add(orderId);
    } else {
      newSelected.delete(orderId);
    }
    setSelectedIds(newSelected);
  };

  const handleSyncToYnab = async () => {
    if (selectedIds.size === 0) {
      openSyncResult({ success: false, message: 'Bitte wählen Sie mindestens eine Transaktion aus.' });
      return;
    }

    const idsToSync = transactions
      .filter(t => t.orderId && !t.ynabSynced && selectedIds.has(t.orderId))
      .map(t => t.orderId!);

    if (idsToSync.length === 0) {
      openSyncResult({ success: false, message: 'Keine unsynchronisierten Transaktionen ausgewählt.' });
      return;
    }

    setSyncLoading(true);
    try {
      const response = await fetch('http://localhost:3001/api/sync-ynab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionIds: idsToSync })
      });
      const data = await response.json();
      if (data.success) {
        openSyncResult({
          success: true,
          message: data.message || 'YNAB Sync erfolgreich!',
          summary: data.summary ?? null,
          output: data.output ?? null,
          stderr: data.stderr ?? null
        });
        setSelectedIds(prev => {
          const next = new Set(prev);
          idsToSync.forEach(id => next.delete(id));
          return next;
        });
        onRefresh();
      } else {
        openSyncResult({
          success: false,
          message: data.message || 'YNAB Sync fehlgeschlagen',
          summary: data.summary ?? null,
          output: data.output ?? null,
          stderr: data.stderr ?? null
        });
      }
    } catch (error) {
      console.error('Fehler beim Sync mit YNAB', error);
      openSyncResult({ success: false, message: 'Fehler beim Sync mit YNAB' });
    } finally {
      setSyncLoading(false);
    }
  };

  const selectableTransactions = transactions.filter(t => t.orderId);
  const unsyncedTransactions = transactions.filter(t => t.orderId && !t.ynabSynced);
  const selectedUnsyncedIds = unsyncedTransactions
    .map(t => t.orderId!)
    .filter(id => selectedIds.has(id));
  const allSelected = selectableTransactions.length > 0 &&
    selectableTransactions.every(t => t.orderId && selectedIds.has(t.orderId));

  const buildSummaryText = (transaction: Transaction) => {
    if (transaction.orderDescription) return transaction.orderDescription;
    if (transaction.orderItems && transaction.orderItems.length > 0) {
      return transaction.orderItems.map(item => item.price ? `${item.title} (${item.price})` : item.title).join(' | ');
    }
    if (transaction.orderTitles && transaction.orderTitles.length > 0) {
      return transaction.orderTitles.join(' | ');
    }
    return [transaction.merchant, transaction.amount, transaction.date].filter(Boolean).join(' ');
  };

  const handleSummarize = async (transaction: Transaction, index: number) => {
    // Create the same unique key as used in the render
    const key = transaction.orderId ? `${transaction.orderId}-${index}` : `idx-${index}`;
    const text = buildSummaryText(transaction);
    if (!text) return;

    setSummaries(prev => ({
      ...prev,
      [key]: { loading: true }
    }));

    try {
      const response = await fetch('http://localhost:3001/api/ai-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          orderId: transaction.orderId ?? null
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Unbekannter Fehler');
      }
      setSummaries(prev => ({
        ...prev,
        [key]: { loading: false, summary: data.summary, model: data.model }
      }));

      if (transaction.orderId) {
        fetch('http://localhost:3001/api/update-ai-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: transaction.orderId, aiSummary: data.summary })
        }).catch(err => console.warn('Failed to update aiSummary:', err));
      }
    } catch (error) {
      console.error('AI-Summary fehlgeschlagen', error);
      const message = error instanceof Error ? error.message : 'Fehler bei der Zusammenfassung';
      setSummaries(prev => ({
        ...prev,
        [key]: { loading: false, error: message }
      }));
    }
  };

  const deleteTransactions = async (orderIds: string[], confirm: boolean) => {
    if (orderIds.length === 0) return;
    if (confirm) {
      const message = orderIds.length === 1
        ? 'Diese Transaktion wirklich löschen?'
        : `Die ausgewählten ${orderIds.length} Transaktionen wirklich löschen?`;
      if (!window.confirm(message)) return;
    }

    setDeleteLoading(true);
    try {
      const response = await fetch('http://localhost:3001/api/delete-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds })
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data?.error || 'Fehler beim Löschen der Transaktionen');
      }
      setSelectedIds(prev => {
        const next = new Set(prev);
        orderIds.forEach(id => next.delete(id));
        return next;
      });
      onRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Fehler beim Löschen der Transaktionen';
      alert(message);
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleDeleteSingle = (orderId: string | null | undefined) => {
    if (!orderId) return;
    deleteTransactions([orderId], true);
  };

  const resetYnabStatus = async (orderIds: string[], confirm: boolean) => {
    if (orderIds.length === 0) return;
    if (confirm) {
      const message = orderIds.length === 1
        ? 'YNAB-Status für diese Transaktion zurücksetzen?'
        : `YNAB-Status für ${orderIds.length} Transaktionen zurücksetzen?`;
      if (!window.confirm(message)) return;
    }

    setResetLoading(true);
    try {
      const response = await fetch('http://localhost:3001/api/reset-ynab-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds })
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data?.error || 'Fehler beim Zurücksetzen des YNAB-Status');
      }
      onRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Fehler beim Zurücksetzen des YNAB-Status';
      alert(message);
    } finally {
      setResetLoading(false);
    }
  };

  const handleResetSingle = (orderId: string | null | undefined) => {
    if (!orderId) return;
    resetYnabStatus([orderId], true);
  };

  return (
    <section className="transaction-list">
      <div className="list-header">
        <div>
          <h2>Amazon Transaktionen</h2>
          <p className="list-subtitle">
            {loading
              ? 'Lade aktuelle Daten...'
              : `Bereit für den Abgleich: ${unsyncedTransactions.length} offen, ${transactions.length} insgesamt.`}
          </p>
        </div>
        <div className="list-header-actions">
          {selectedIds.size > 0 && <span className="meta-pill">Ausgewählt: {selectedIds.size}</span>}
          <button onClick={onRefresh} disabled={loading} className="btn-secondary">
            {loading ? 'Lade...' : 'Aktualisieren'}
          </button>
        </div>
      </div>

      {selectableTransactions.length > 0 && (
        <div className="bulk-actions">
          <label>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => handleSelectAll(e.target.checked)}
            />
            Alle auswählen
          </label>
          <button
            onClick={handleSyncToYnab}
            disabled={selectedUnsyncedIds.length === 0 || syncLoading}
            className="btn-primary"
          >
            {syncLoading ? 'Sync läuft...' : `Mit YNAB syncen (${selectedUnsyncedIds.length})`}
          </button>
          <button
            onClick={() => resetYnabStatus(Array.from(selectedIds), true)}
            disabled={selectedIds.size === 0 || resetLoading}
            className="btn-secondary"
          >
            {resetLoading ? 'Setze zurück...' : `YNAB-Status zurücksetzen (${selectedIds.size})`}
          </button>
          <button
            onClick={() => deleteTransactions(Array.from(selectedIds), true)}
            disabled={selectedIds.size === 0 || deleteLoading}
            className="btn-danger"
          >
            {deleteLoading ? 'Lösche...' : `Ausgewählte löschen (${selectedIds.size})`}
          </button>
        </div>
      )}

      <div className="transactions">
        {loading ? (
          <p>Lade Transaktionen...</p>
        ) : transactions.length === 0 ? (
          <p>Keine Transaktionen gefunden. Führen Sie zuerst einen Sync durch.</p>
        ) : (
          transactions.map((transaction, index) => {
            // Create a truly unique key to prevent React key conflicts
            // Use orderId + index to ensure uniqueness, fallback to just index
            const key = transaction.orderId ? `${transaction.orderId}-${index}` : `idx-${index}`;
            const summaryState = summaries[key];
            return (
              <div key={key} className={`transaction-card ${transaction.ynabSynced ? 'is-synced' : ''}`}>
                <div className="transaction-card__select">
                  {transaction.orderId && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(transaction.orderId)}
                      onChange={(e) => handleSelectTransaction(transaction.orderId!, e.target.checked)}
                    />
                  )}
                </div>
                <div className="transaction-card__content">
                  <div className="transaction-card__top">
                    <div className="transaction-card__top-left">
                      <span className="transaction-date">{transaction.date || 'Unbekannt'}</span>
                      {(transaction.ynabSynced || transaction.isRefund) && (
                        <div className="transaction-badges">
                          {transaction.ynabSynced && <span className="badge badge-success">YNAB synchron</span>}
                          {transaction.isRefund && <span className="badge badge-info">Erstattung</span>}
                        </div>
                      )}
                    </div>
                    <span className={`transaction-amount ${transaction.isRefund ? 'is-refund' : ''}`}>
                      {transaction.amount}
                    </span>
                  </div>

                  <div className="transaction-card__body">
                    <span className="transaction-merchant">{transaction.merchant || 'Unbekannt'}</span>
                    {transaction.orderItems && transaction.orderItems.length > 0 ? (
                      <ol className="description-list">
                        {transaction.orderItems.slice(0, 5).map((item, idx) => (
                          <li key={`${transaction.orderId ?? 'order'}-${idx}`}>
                            <span className="item-title">{item.title}</span>
                            {item.price && <span className="item-price">{item.price}</span>}
                          </li>
                        ))}
                        {transaction.orderItems.length > 5 && (
                          <li className="item-more">+{transaction.orderItems.length - 5} weitere Artikel</li>
                        )}
                      </ol>
                    ) : (
                      transaction.orderDescription && (
                        <span className="transaction-description">{transaction.orderDescription}</span>
                      )
                    )}
                  </div>

                  <div className="transaction-card__footer">
                    <div className="transaction-meta">
                      {transaction.orderId && <span className="meta-pill">Order {transaction.orderId}</span>}
                      {transaction.ynabSync?.importId && (
                        <span className="meta-pill muted">Import {transaction.ynabSync.importId}</span>
                      )}
                    </div>
                    <div className="transaction-actions">
                      <button
                        type="button"
                        className="btn-icon"
                        title="KI-Zusammenfassung erzeugen"
                        onClick={() => handleSummarize(transaction, index)}
                        disabled={summaryState?.loading}
                      >
                        {summaryState?.loading ? '…' : '🪄'}
                      </button>
                      {transaction.orderId && (
                        <button
                          type="button"
                          className="btn-icon"
                          title="YNAB-Status zurücksetzen"
                          onClick={() => handleResetSingle(transaction.orderId)}
                          disabled={resetLoading}
                        >
                          ♻️
                        </button>
                      )}
                      {transaction.orderId && (
                        <button
                          type="button"
                          className="btn-icon danger"
                          title="Transaktion löschen"
                          onClick={() => handleDeleteSingle(transaction.orderId)}
                          disabled={deleteLoading}
                        >
                          🗑️
                        </button>
                      )}
                    </div>
                  </div>

                  {(summaryState?.summary || transaction.aiSummary) && (
                    <div className="ai-summary">
                      <strong>KI Memo:</strong> {summaryState?.summary || transaction.aiSummary}
                      {summaryState?.model && <span className="model-tag">{summaryState.model}</span>}
                    </div>
                  )}
                  {summaryState?.error && <div className="ai-summary error">{summaryState.error}</div>}
                </div>
              </div>
            );
          })
        )}
      </div>

      {syncResult && <SyncResultModal result={syncResult} onClose={closeSyncResult} />}
    </section>
  );
}

export default TransactionList;
