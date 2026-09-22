const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Utility: safe log for URI host only
const getMaskedUriInfo = (uri) => {
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:\/\//, 'http://')); // quick parse hack
    return `${u.hostname}`;
  } catch (e) {
    return 'unknown-host';
  }
};

// MongoDB Connection
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
  console.error('🔴 ERROR: Environment variable MONGO_URI belum diatur di Render!');
  process.exit(1);
}

// Mongoose options (modern mongoose v6+ sudah default, tapi keep explicit)
const mongooseOptions = {
  // useNewUrlParser: true,
  // useUnifiedTopology: true,
  // serverSelectionTimeoutMS: 10000,
};

const connectWithRetry = async (retries = 3, delayMs = 3000) => {
  const hostInfo = getMaskedUriInfo(mongoURI);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🔌 Mencoba koneksi ke MongoDB host ${hostInfo} (attempt ${attempt}/${retries})`);
      await mongoose.connect(mongoURI, mongooseOptions);
      console.log('✅ Berhasil terhubung ke MongoDB Atlas');
      return;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`🔴 Gagal terhubung ke database: ${msg}`);
      if (process.env.NODE_ENV !== 'production') {
        console.error(err.stack);
      }
      if (attempt < retries) {
        console.log(`⏳ Menunggu ${delayMs}ms sebelum mencoba lagi...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        console.error('❌ Semua percobaan koneksi gagal. Keluar proses.');
        process.exit(1);
      }
    }
  }
};

// Mongoose Schema & Model
const TransactionSchema = new mongoose.Schema({
  date: { type: String, required: true }, // Format: YYYY-MM-DD
  type: { type: String, enum: ['income', 'expense'], required: true },
  category: { type: String, default: 'Umum' },
  desc: { type: String, default: 'Tanpa Keterangan' },
  amount: { type: Number, required: true, default: 0 },
  status: { type: String, default: 'Selesai' },
  source: { type: String, default: 'manual' }
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', TransactionSchema);

// --- HELPER FUNCTIONS FOR CSV PARSING ---

const normalizeSheetsUrl = (rawUrl) => {
  if (!rawUrl) return '';
  let url = rawUrl.trim();
  if (url.includes('/spreadsheets/d/') && (url.includes('/edit') || url.includes('/view'))) {
    url = url.replace(/\/(edit|view).*$/, '/export?format=csv');
  }
  if (url.includes('/pubhtml')) {
    url = url.replace('/pubhtml', '/pub?output=csv');
  }
  return url;
};

const parseAnyDate = (raw) => {
  if (!raw) return '';
  let str = String(raw).trim().replace(/^"|"$/g, '');
  const parts = str.split(/[\/.-]/);
  if (parts.length === 3) {
    let p1 = parseInt(parts[0], 10);
    let p2 = parseInt(parts[1], 10);
    let p3 = parseInt(parts[2], 10);
    if (isNaN(p1) || isNaN(p2) || isNaN(p3)) return str;
    let year, month, day;
    if (parts[0].length === 4) {
      year = p1; month = p2; day = p3;
    } else {
      year = p3 < 100 ? p3 + 2000 : p3;
      if (p1 > 12) { day = p1; month = p2; }
      else if (p2 > 12) { month = p1; day = p2; }
      else { day = p1; month = p2; }
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return str;
};

const parseCSVLine = (line, delimiter) => {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // handle escaped quotes ""
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
};

const cleanAmountToNumber = (raw) => {
  if (raw == null) return 0;
  let s = String(raw).trim();
  // remove currency symbols and spaces
  s = s.replace(/Rp|\$|€|£/gi, '').trim();
  // handle parentheses as negative: (1.000) => -1000
  const isParenNeg = /^\(.*\)$/.test(s);
  s = s.replace(/^\(|\)$/g, '');
  // remove non-digit except comma and dot and minus
  // normalize thousand separators: if both '.' and ',' present, assume '.' thousand and ',' decimal or vice versa
  // Simplest robust approach: remove all non-digit except '-' then parse integer
  s = s.replace(/[^0-9\-]/g, '');
  let num = Number(s) || 0;
  if (isParenNeg) num = -Math.abs(num);
  return num;
};

const parseCSVToTransactions = (csvText) => {
  if (!csvText || typeof csvText !== 'string') return [];
  const cleanText = csvText.replace(/^\uFEFF/, '');
  const rawLines = cleanText.split(/\r?\n/);
  const lines = rawLines.map(l => l.trim()).filter((l, idx) => l.length > 0 || idx === 0); // keep header even if empty
  if (lines.length === 0) return [];
  // detect delimiter from first non-empty line
  const firstLine = lines.find(l => l.length > 0) || lines[0];
  const delimiter = firstLine.includes(';') ? ';' : ',';
  const parsedData = [];
  const headerCols = parseCSVLine(firstLine, delimiter);
  const isHeader = headerCols.some(col =>
    /tanggal|date|tipe|type|kategori|category|keterangan|deskripsi|nominal|jumlah|amount/i.test(col)
  );
  const startIndex = isHeader ? 1 : 0;
  for (let i = startIndex; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i], delimiter);
    if (cols.length < 3) continue;
    let colOffset = 0;
    if (/^\d+$/.test(cols[0]) && cols.length >= 6) colOffset = 1;
    const dateRaw = cols[0 + colOffset];
    const typeRaw = (cols[1 + colOffset] || '').toLowerCase();
    const categoryRaw = cols[2 + colOffset] || 'Umum';
    const descRaw = cols[3 + colOffset] || 'Tanpa Keterangan';
    const amountRaw = cols[4 + colOffset] || '0';
    const formattedDate = parseAnyDate(dateRaw);
    const isIncome = ['income', 'pemasukan', 'masuk', 'kredit', 'in'].includes(typeRaw);
    const cleanAmount = cleanAmountToNumber(amountRaw);
    if (formattedDate && Math.abs(cleanAmount) > 0) {
      parsedData.push({
        date: formattedDate,
        type: isIncome ? 'income' : 'expense',
        category: categoryRaw,
        desc: descRaw,
        amount: Math.abs(cleanAmount),
        status: 'Selesai',
        source: 'sheets'
      });
    }
  }
  return parsedData;
};

// --- API ENDPOINTS ---

app.get('/api/health', (req, res) => {
  res.json({ success: true, uptime: process.uptime() });
});

app.get('/api/finances', async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ date: -1 });
    res.json({ success: true, data: transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/finances/sync-sheets', async (req, res) => {
  try {
    const { sheetUrl } = req.body;
    if (!sheetUrl) {
      return res.status(400).json({ success: false, message: 'URL Google Sheets diperlukan.' });
    }
    const csvUrl = normalizeSheetsUrl(sheetUrl);
    console.log(`📡 Fetching CSV from: ${csvUrl}`);
    const response = await axios.get(csvUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: (s) => s >= 200 && s < 300
    });
    if (!response || !response.data) {
      return res.status(400).json({ success: false, message: 'Tidak menerima data CSV dari URL.' });
    }
    const transactions = parseCSVToTransactions(response.data);
    if (transactions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Tidak ada data valid yang ditemukan dalam CSV. Pastikan format kolom sesuai (Tanggal, Tipe, Kategori, Keterangan, Nominal).'
      });
    }
    await Transaction.deleteMany({ source: 'sheets' });
    const savedData = await Transaction.insertMany(transactions);
    const allTransactions = await Transaction.find().sort({ date: -1 });
    res.json({
      success: true,
      message: `Berhasil mensinkronkan ${savedData.length} transaksi dari Google Sheets!`,
      count: savedData.length,
      data: allTransactions
    });
  } catch (err) {
    console.error('🔴 Sync Error:', err.message);
    if (process.env.NODE_ENV !== 'production') console.error(err.stack);
    res.status(500).json({
      success: false,
      message: `Gagal mengambil data Google Sheets dari server: ${err.message}`
    });
  }
});

app.post('/api/finances', async (req, res) => {
  try {
    const newDoc = new Transaction({ ...req.body, source: 'manual' });
    await newDoc.save();
    const allTransactions = await Transaction.find().sort({ date: -1 });
    res.status(201).json({ success: true, data: allTransactions });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/finances', async (req, res) => {
  try {
    await Transaction.deleteMany({});
    res.json({ success: true, message: 'Semua data transaksi berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('🛑 Graceful shutdown initiated');
  try {
    await mongoose.disconnect();
    console.log('🔌 Mongoose disconnected');
  } catch (e) {
    console.error('Error during mongoose disconnect', e);
  }
  process.exit(0);
};
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Start sequence: connect DB then start server
(async () => {
  await connectWithRetry(5, 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
  });
})();
