import { useState, useEffect, useMemo } from 'react';
import './App.css';
import ConfigSection from './components/ConfigSection';
import TransactionList from './components/TransactionList';

export interface Transaction {
  date: string | null;
  amount: string | null;
  paymentInstrument: string | null;
  merchant: string | null;
  orderId: string | null;
  orderUrl: string | null;
  isRefund: boolean;
  orderDescription: string | null;
  orderTitles?: string[] | null;
  orderItems?: { title: string; price?: string | null; quantity?: number }[] | null;
  orderSummary?: {
    subtotal?: string | null;
    voucher?: string | null;
    bonusPoints?: string | null;
    shipping?: string | null;
    total?: string | null;
  } | null;
  aiSummary?: string | null;
  multiOrderTransaction?: boolean;
  totalAmount?: string | null;
  orderIndex?: number;
  totalOrders?: number;
  ynabSynced?: boolean;
  ynabSync?: {
    at?: string;
    importId?: string;
    ynabTransactionId?: string | null;
    duplicateImportId?: boolean;
    amountMilliunits?: number | null;
  } | null;
}

function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchTransactions = async () => {
    setLoading(true);
    try {
      const response = await fetch('http://localhost:3001/api/transactions');
      const data = await response.json();
      setTransactions(data.transactions || []);
    } catch (error) {
      console.error('Error fetching transactions:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTransactions();
  }, []);

  const summary = useMemo(() => {
    const total = transactions.length;
    const withOrderId = transactions.filter(transaction => Boolean(transaction.orderId)).length;
    const unsynced = transactions.filter(transaction => transaction.orderId && !transaction.ynabSynced).length;
    return { total, withOrderId, unsynced };
  }, [transactions]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-surface">
          <div className="header-text">
            <p className="header-eyebrow">Cockpit</p>
            <h1>Amazon ↔︎ YNAB Sync</h1>
            <p className="header-subtitle">
              Behalten Sie Ihre Amazon-Käufe im Blick und übertragen Sie passende Transaktionen mit einem Klick nach YNAB.
            </p>
          </div>
          <div className="header-meta">
            <div className="header-stats">
              <div className="stat-card">
                <span className="stat-label">Transaktionen</span>
                <span className="stat-value">{summary.total}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Mit Order-ID</span>
                <span className="stat-value">{summary.withOrderId}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Offen für Sync</span>
                <span className="stat-value accent">{summary.unsynced}</span>
              </div>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={fetchTransactions}
              disabled={loading}
            >
              {loading ? 'Aktualisiere…' : 'Neu laden'}
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-grid">
          <ConfigSection onSyncComplete={fetchTransactions} />
          <TransactionList
            transactions={transactions}
            loading={loading}
            onRefresh={fetchTransactions}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
