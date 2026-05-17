# Amazon to YNAB Sync

An automated tool for synchronizing Amazon transactions with YNAB (You Need A Budget) featuring AI-powered order description summarization.

## ✨ Features

- 🔄 Automatic synchronization of Amazon orders
- 🤖 AI-powered summarization of order descriptions
- 📊 Web interface for transaction management
- 🎯 Flexible sync options (current month, last N entries, date range)
- 🔒 Secure API authentication

## 🚀 Quick Start

### 1. Clone Repository
```bash
git clone <repository-url>
cd amazon-ynab-sync
```

### 2. Install Dependencies
```bash
npm install
cd client && npm install && cd ..
```

### 3. Configure Environment
```bash
cp .env.example .env
```

Fill the `.env` file with your API keys:

#### YNAB API Token
1. Go to [YNAB Developer Settings](https://app.youneedabudget.com/settings/developer)
2. Create a new Personal Access Token
3. Copy the token to `YNAB_TOKEN`

#### OpenAI API Key
1. Go to [OpenAI API Keys](https://platform.openai.com/api-keys)
2. Create a new API key
3. Copy the key to `OPENAI_API_KEY`

#### YNAB Account ID
1. Find your budget ID in the YNAB URL or via API
2. Set `YNAB_ACCOUNT_ID` to your Amazon account ID in YNAB

### 4. Set Up Amazon Login
```bash
npm run login
```
Follow the browser instructions to log in to Amazon.

### 5. Start Server
```bash
npm run dev
```

The application will be available at:
- **Web Interface (Vite)**: http://localhost:5173
- **API Server**: http://localhost:3001/api/*

## 📋 Usage

### Web Interface
1. Open http://localhost:5173 in your browser
2. Check Amazon login status
3. Select desired sync time period
4. Start synchronization
5. Review and edit transactions
6. Sync selected transactions with YNAB

### Command Line
```bash
# Sync current month
npm run sync

# Sync visible entries since the last YNAB-synced transaction in transactions.json
npx ts-node transactions-to-json.ts --mode newest

# Sync last 50 transactions
npx ts-node transactions-to-json.ts --mode last-n --last 50

# Sync specific date range
npx ts-node transactions-to-json.ts --mode date-range --start 2024-01-01 --end 2024-01-31

# Sync with YNAB (current month only)
npm run ynab
```

## 🔧 Configuration

### Sync Modes
- **current-month**: Current month (default)
- **newest**: Latest visible Amazon entries since the first transaction already marked as YNAB-synced in `transactions.json`
- **last-n**: Last N transactions
- **date-range**: Specific date range

### Environment Variables
```env
YNAB_TOKEN=your_ynab_token
YNAB_BUDGET_ID=last-used
YNAB_ACCOUNT_ID=your_account_id
OPENAI_API_KEY=your_openai_key
DRY_RUN=0  # 1 for test mode without YNAB sync
PORT=3001
HOST=127.0.0.1
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
# Optional API protection:
# API_AUTH_TOKEN=generate_a_long_random_token
```

If you enable `API_AUTH_TOKEN`, create `client/.env.local` and set
`VITE_API_AUTH_TOKEN` to the same value. You can also override the API URL with
`VITE_API_BASE_URL`.

## 🏗️ Architecture

- **Backend**: Node.js/Express server with TypeScript
- **Frontend**: React 19 with TypeScript and Vite
- **Scraping**: Playwright for Amazon data extraction
- **AI**: OpenAI GPT for description summarization
- **Budgeting**: YNAB API for transaction synchronization

## 🔒 Security

- Browser session data is stored locally
- The API binds to `127.0.0.1` by default
- CORS is restricted to configured localhost origins
- Optional API-key protection is available via `API_AUTH_TOKEN`
- Raw script output is not returned to the browser unless `API_DEBUG_OUTPUT=1`
- Debug-heavy scraper logs are disabled unless `DEBUG_SCRAPER=1`

## ✅ Quality Checks

```bash
npm run typecheck
npm test
cd client && npm run lint && npm run build
```

## 🐛 Troubleshooting

### Amazon Login Not Working
- Make sure you've run `npm run login`
- Check if `amazon.storageState.json` exists
- Try the login process again
- The app checks payments and order details separately. If payments work but order details need reauth, run `npm run login` again so older order detail pages can be opened.

### YNAB Sync Failing
- Check your YNAB API keys in the `.env` file
- Ensure the correct budget is selected
- Enable `DRY_RUN=1` for testing without actual synchronization

### OpenAI API Errors
- Check your OpenAI API key
- Ensure you have sufficient credits
- The application automatically falls back to a fallback model

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📄 License

This project is intended for private use.

## ⚠️ Important Notes

- Use real API keys only in your local `.env` file
- Never share your `.env` file or API keys
- The application is designed for private use