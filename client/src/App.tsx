import { useState, useEffect } from 'react'
import './App.css'
import ConfigSection from './components/ConfigSection'
import TransactionList from './components/TransactionList'

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
  orderItems?: { title: string; price?: string | null }[] | null;
  aiSummary?: string | null;
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

  return (
    <div className="app">
      <header>
        <h1>Amazon to YNAB Sync</h1>
      </header>

      <main>
        <ConfigSection onSyncComplete={fetchTransactions} />
        <TransactionList
          transactions={transactions}
          loading={loading}
          onRefresh={fetchTransactions}
        />
      </main>
    </div>
  )
}

export default App
