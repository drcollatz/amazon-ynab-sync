import { useState } from 'react';
import type { Transaction } from '../App';

interface TransactionListProps {
  transactions: Transaction[];
  loading: boolean;
  onRefresh: () => void;
}

function TransactionList({ transactions, loading, onRefresh }: TransactionListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [syncLoading, setSyncLoading] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, { loading: boolean; summary?: string; error?: string; model?: string }>>({});
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

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
      alert('Bitte wählen Sie mindestens eine Transaktion aus.');
      return;
    }

    const idsToSync = transactions
      .filter(t => t.orderId && !t.ynabSynced && selectedIds.has(t.orderId))
      .map(t => t.orderId!);

    if (idsToSync.length === 0) {
      alert('Keine unsynchronisierten Transaktionen ausgewählt.');
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
        alert('YNAB Sync erfolgreich!');
        setSelectedIds(prev => {
          const next = new Set(prev);
          idsToSync.forEach(id => next.delete(id));
          return next;
        });
        onRefresh(); // Liste aktualisieren
      } else {
        alert(`YNAB Sync fehlgeschlagen: ${data.message}`);
      }
    } catch (error) {
      alert('Fehler beim Sync mit YNAB');
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
    const key = transaction.orderId ?? `idx-${index}`;
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

      // Update aiSummary in transactions.json for consistency
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
        <h2>Amazon Transaktionen</h2>
        <button onClick={onRefresh} disabled={loading} className="btn-secondary">
          {loading ? 'Lade...' : 'Aktualisieren'}
        </button>
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
            const key = transaction.orderId ?? `idx-${index}`;
            const summaryState = summaries[key];
            return (
              <div key={index} className={`transaction-item ${transaction.ynabSynced ? 'synced' : ''}`}>
                <div className="transaction-checkbox">
                {transaction.orderId && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(transaction.orderId)}
                    onChange={(e) => handleSelectTransaction(transaction.orderId!, e.target.checked)}
                  />
                )}
              </div>
              <div className="transaction-content">
                <div className="transaction-header">
                  <span className="date">{transaction.date || 'Unbekannt'}</span>
                  <span className={`amount ${transaction.isRefund ? 'refund' : ''}`}>
                    {transaction.amount}
                  </span>
                </div>
                <div className="transaction-details">
                  <span className="merchant">{transaction.merchant || 'Unbekannt'}</span>
                  {transaction.orderItems && transaction.orderItems.length > 0 ? (
                    <ol className="description-list">
                      {transaction.orderItems.slice(0, 5).map((item, idx) => (
                        <li key={`${transaction.orderId ?? 'order'}-${idx}`}>
                          <span className="item-title">{item.title}</span>
                          {item.price && (
                            <span className="item-price">{item.price}</span>
                          )}
                        </li>
                      ))}
                      {transaction.orderItems.length > 5 && (
                        <li className="item-more">+{transaction.orderItems.length - 5} weitere Artikel</li>
                      )}
                    </ol>
                  ) : (
                    transaction.orderDescription && (
                      <span className="description">{transaction.orderDescription}</span>
                    )
                  )}
                </div>
                <div className="transaction-meta">
                  {transaction.orderId && (
                    <span className="order-id">Order: {transaction.orderId}</span>
                  )}
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
                  {transaction.ynabSynced && (
                    <span className="sync-status synced">✓ Mit YNAB synchronisiert</span>
                  )}
                  {transaction.isRefund && (
                    <span className="refund-badge">Erstattung</span>
                  )}
                </div>
                {(summaryState?.summary || transaction.aiSummary) && (
                  <div className="ai-summary">
                    <strong>KI Memo:</strong> {summaryState?.summary || transaction.aiSummary}
                    {summaryState?.model && (
                      <span className="model-tag">{summaryState.model}</span>
                    )}
                  </div>
                )}
                {summaryState?.error && (
                  <div className="ai-summary error">{summaryState.error}</div>
                )}
              </div>
            </div>
          );
          })
        )}
      </div>
    </section>
  );
}

export default TransactionList;
