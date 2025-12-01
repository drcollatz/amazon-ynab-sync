import { useState, useMemo } from 'react';
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
  error?: string;
  summary?: SyncSummary | null;
  output?: string | null;
  stderr?: string | null;
  configurationHelp?: {
    missing: string[];
    instructions: string[];
  };
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
  const { success, message, summary, output, stderr, configurationHelp } = result;
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
  const isConfigError = Boolean(configurationHelp);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className={`modal ${success ? 'modal-success' : 'modal-error'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{isConfigError ? 'YNAB Konfiguration fehlt' : (success ? 'YNAB Sync erfolgreich' : 'YNAB Sync fehlgeschlagen')}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-message">{message}</p>
          
          {configurationHelp && (
            <div className="config-help">
              <h4>🔧 Fehlende Konfiguration</h4>
              <p>Die folgenden Umgebungsvariablen fehlen:</p>
              <ul className="missing-config-list">
                {configurationHelp.missing.map((item) => (
                  <li key={item}><code>{item}</code></li>
                ))}
              </ul>
              
              <h4>📋 Anleitung zur Konfiguration</h4>
              <ol className="config-instructions">
                {configurationHelp.instructions.map((instruction, idx) => (
                  <li key={idx}>{instruction}</li>
                ))}
              </ol>
              
              <div className="config-example">
                <h5>Beispiel .env Datei:</h5>
                <pre>
{`YNAB_TOKEN=dein_personal_access_token_hier
YNAB_ACCOUNT_ID=deine_account_id_hier
YNAB_BUDGET_ID=last-used`}
                </pre>
              </div>
              
              <div className="config-links">
                <a 
                  href="https://app.youneedabudget.com/settings/developer" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="btn-primary"
                >
                  🔑 YNAB Personal Access Token holen
                </a>
              </div>
            </div>
          )}
          
          {!isConfigError && timestamp && <p className="modal-timestamp">Zeitpunkt: {timestamp}</p>}

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
  // Use index-based selection to handle duplicate order IDs
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [syncLoading, setSyncLoading] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, { loading: boolean; summary?: string; error?: string; model?: string }>>({});
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const openSyncResult = (result: SyncResult) => setSyncResult(result);
  const closeSyncResult = () => setSyncResult(null);

  // Group transactions by orderId to find Santander-Punkte companions
  const transactionGroups = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    transactions.forEach(tx => {
      if (tx.orderId) {
        if (!groups.has(tx.orderId)) {
          groups.set(tx.orderId, []);
        }
        groups.get(tx.orderId)!.push(tx);
      }
    });
    return groups;
  }, [transactions]);

  // Filter out standalone Santander-Punkte transactions (they'll be shown in their main transaction)
  const visibleTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      const isSantanderPunkte = tx.paymentInstrument?.includes('Santander-Punkte');
      if (!isSantanderPunkte) return true;
      
      // Check if there's a main transaction for the same order
      if (tx.orderId && transactionGroups.has(tx.orderId)) {
        const group = transactionGroups.get(tx.orderId)!;
        const hasMainTransaction = group.some(t => !t.paymentInstrument?.includes('Santander-Punkte'));
        // Hide if there's a main transaction, show if it's standalone
        return !hasMainTransaction;
      }
      return true;
    });
  }, [transactions, transactionGroups]);

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allIndices = visibleTransactions
        .map((_, index) => index)
        .filter(index => visibleTransactions[index].orderId);
      setSelectedIndices(new Set(allIndices));
    } else {
      setSelectedIndices(new Set());
    }
  };

  const handleSelectTransaction = (index: number, checked: boolean) => {
    const newSelected = new Set(selectedIndices);
    if (checked) {
      newSelected.add(index);
    } else {
      newSelected.delete(index);
    }
    setSelectedIndices(newSelected);
  };

  const handleSyncToYnab = async () => {
    if (selectedIndices.size === 0) {
      openSyncResult({ success: false, message: 'Bitte wählen Sie mindestens eine Transaktion aus.' });
      return;
    }

    const idsToSync = Array.from(selectedIndices)
      .map(index => visibleTransactions[index])
      .filter(t => t && t.orderId && !t.ynabSynced)
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
        // First show success modal
        openSyncResult({
          success: true,
          message: data.message || 'YNAB Sync erfolgreich!',
          summary: data.summary ?? null,
          output: data.output ?? null,
          stderr: data.stderr ?? null
        });
        
        // Clear selection for synced transactions
        setSelectedIndices(prev => {
          const next = new Set(prev);
          Array.from(prev).forEach(index => {
            const tx = visibleTransactions[index];
            if (tx && tx.orderId && idsToSync.includes(tx.orderId)) {
              next.delete(index);
            }
          });
          return next;
        });
        
        // Refresh data after a short delay to allow user to see the modal first
        setTimeout(() => {
          onRefresh();
        }, 500);
      } else {
        openSyncResult({
          success: false,
          message: data.message || 'YNAB Sync fehlgeschlagen',
          summary: data.summary ?? null,
          output: data.output ?? null,
          stderr: data.stderr ?? null,
          configurationHelp: data.configurationHelp ?? null
        });
      }
    } catch (error) {
      console.error('Fehler beim Sync mit YNAB', error);
      openSyncResult({ success: false, message: 'Fehler beim Sync mit YNAB' });
    } finally {
      setSyncLoading(false);
    }
  };

  const selectableTransactions = visibleTransactions.filter(t => t.orderId);
  const unsyncedTransactions = visibleTransactions.filter(t => t.orderId && !t.ynabSynced);
  const selectedUnsyncedIndices = Array.from(selectedIndices)
    .filter(index => {
      const tx = visibleTransactions[index];
      return tx.orderId && !tx.ynabSynced;
    });
  const allSelected = selectableTransactions.length > 0 &&
    visibleTransactions.every((t, index) => !t.orderId || selectedIndices.has(index));

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
      setSelectedIndices(prev => {
        const next = new Set(prev);
        // Remove deleted transaction indices
        const deletedOrderIds = new Set(orderIds);
        Array.from(prev).forEach(idx => {
          const tx = visibleTransactions[idx];
          if (tx?.orderId && deletedOrderIds.has(tx.orderId)) {
            next.delete(idx);
          }
        });
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
          {selectedIndices.size > 0 && <span className="meta-pill">Ausgewählt: {selectedIndices.size}</span>}
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
            disabled={selectedUnsyncedIndices.length === 0 || syncLoading}
            className="btn-primary"
            style={syncLoading ? { opacity: 0.7 } : {}}
          >
            {syncLoading ? '⏳ Sync läuft...' : `Mit YNAB syncen (${selectedUnsyncedIndices.length})`}
          </button>
          <button
            onClick={() => resetYnabStatus(Array.from(selectedIndices).map(i => visibleTransactions[i]?.orderId).filter(Boolean) as string[], true)}
            disabled={selectedIndices.size === 0 || resetLoading}
            className="btn-secondary"
          >
            {resetLoading ? 'Setze zurück...' : `YNAB-Status zurücksetzen (${selectedIndices.size})`}
          </button>
          <button
            onClick={() => deleteTransactions(Array.from(selectedIndices).map(i => visibleTransactions[i]?.orderId).filter(Boolean) as string[], true)}
            disabled={selectedIndices.size === 0 || deleteLoading}
            className="btn-danger"
          >
            {deleteLoading ? 'Lösche...' : `Ausgewählte löschen (${selectedIndices.size})`}
          </button>
        </div>
      )}

      {syncLoading && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(255, 255, 255, 0.98)',
          padding: '32px 48px',
          borderRadius: '16px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
          zIndex: 999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px',
          border: '2px solid rgba(59, 130, 246, 0.3)'
        }}>
          <div style={{ fontSize: '48px' }}>⏳</div>
          <div style={{ fontSize: '18px', fontWeight: 600, color: '#0f172a' }}>
            YNAB Sync läuft...
          </div>
          <div style={{ fontSize: '14px', color: '#64748b' }}>
            Bitte warten Sie, während die Transaktionen synchronisiert werden
          </div>
        </div>
      )}

      <div className="transactions">
        {loading ? (
          <p>Lade Transaktionen...</p>
        ) : visibleTransactions.length === 0 ? (
          <p>Keine Transaktionen gefunden. Führen Sie zuerst einen Sync durch.</p>
        ) : (
          visibleTransactions.map((transaction, index) => {
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
                      checked={selectedIndices.has(index)}
                      onChange={(e) => handleSelectTransaction(index, e.target.checked)}
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
                    <div className="transaction-amount-section">
                      <span className={`transaction-amount ${transaction.isRefund ? 'is-refund' : ''}`}>
                        {transaction.multiOrderTransaction && transaction.totalAmount 
                          ? transaction.totalAmount 
                          : transaction.amount}
                      </span>
                      {transaction.multiOrderTransaction && transaction.totalOrders && (
                        <span className="multi-order-badge">
                          Teil {(transaction.orderIndex ?? 0) + 1}/{transaction.totalOrders}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="transaction-card__body">
                    <span className="transaction-merchant">{transaction.merchant || 'Unbekannt'}</span>
                    {transaction.orderItems && transaction.orderItems.length > 0 ? (
                      <>
                        <ol className="description-list">
                          {transaction.orderItems.slice(0, 5).map((item, idx) => (
                            <li key={`${transaction.orderId ?? 'order'}-${idx}`}>
                              <span className="item-title">
                                {item.quantity && item.quantity > 1 ? `${item.quantity}x ` : ''}{item.title}
                              </span>
                              {item.price && <span className="item-price">{item.price}</span>}
                            </li>
                          ))}
                          {transaction.orderItems.length > 5 && (
                            <li className="item-more">+{transaction.orderItems.length - 5} weitere Artikel</li>
                          )}
                        </ol>
                        {transaction.orderSummary && (
                          <div className="order-summary">
                            {transaction.orderSummary.subtotal && (
                              <div className="summary-item subtotal">
                                <span className="summary-label">Zwischensumme:</span>
                                <span className="summary-value">{transaction.orderSummary.subtotal}€</span>
                              </div>
                            )}
                            {transaction.orderSummary.voucher && (
                              <div className="summary-item voucher">
                                <span className="summary-label">Gutschein:</span>
                                <span className="summary-value">{transaction.orderSummary.voucher}</span>
                              </div>
                            )}
                            {transaction.orderSummary.bonusPoints && (
                              <div className="summary-item bonus-points">
                                <span className="summary-label">Prämienpunkte:</span>
                                <span className="summary-value">{transaction.orderSummary.bonusPoints}</span>
                              </div>
                            )}
                            {transaction.orderSummary.shipping && (
                              <div className="summary-item shipping">
                                <span className="summary-label">Versand:</span>
                                <span className="summary-value">{transaction.orderSummary.shipping}€</span>
                              </div>
                            )}
                            {transaction.orderSummary.total && (
                              <div className="summary-item total">
                                <span className="summary-label">Gesamt:</span>
                                <span className="summary-value total-value">{transaction.orderSummary.total}€</span>
                              </div>
                            )}
                            {/* Show warning for partial refunds where amount doesn't match total */}
                            {transaction.isRefund && transaction.amount && transaction.orderSummary.total && (
                              (() => {
                                const amountValue = parseFloat(transaction.amount.replace(/[^0-9.,]/g, '').replace(',', '.'));
                                const totalValue = parseFloat(transaction.orderSummary.total.replace(',', '.'));
                                return Math.abs(amountValue - totalValue) > 0.01 && (
                                  <div className="summary-item info">
                                    <span className="summary-note">
                                      ℹ️ Teilerstattung: Tatsächlicher Betrag {transaction.amount}
                                    </span>
                                  </div>
                                );
                              })()
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      transaction.orderDescription && (
                        <span className="transaction-description">{transaction.orderDescription}</span>
                      )
                    )}
                  </div>

                  <div className="transaction-card__footer">
                    <div className="transaction-meta">
                      {transaction.orderId && (
                        <a 
                          href={transaction.orderUrl || `https://www.amazon.de/gp/css/summary/edit.html?orderID=${transaction.orderId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="meta-pill order-link"
                          title="Bestellung bei Amazon öffnen"
                        >
                          Order {transaction.orderId}
                        </a>
                      )}
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
