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

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/serikat_pekerja';

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('🟢 Connected to MongoDB Atlas'))
.catch(err => console.error('🔴 MongoDB Connection Error:', err));

// Mongoose Schema & Model
const TransactionSchema = new mongoose.Schema({
    date: { type: String, required: true }, // Format: YYYY-MM-DD
    type: { type: String, enum: ['income', 'expense'], required: true },
    category: { type: String, default: 'Umum' },
    desc: { type: String, default: 'Tanpa Keterangan' },
    amount: { type: Number, required: true, default: 0 },
    status: { type: String, default: 'Selesai' },
    source: { type: String, default: 'manual' } // 'manual' or 'sheets'
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', TransactionSchema);

// --- HELPER FUNCTIONS FOR CSV PARSING ---

// Convert Google Sheets edit/pubhtml link to exportable CSV URL
const normalizeSheetsUrl = (rawUrl) => {
    if (!rawUrl) return '';
    let url = rawUrl.trim();
    if (url.includes('/spreadsheets/d/') && (url.includes('/edit') || url.includes('/view'))) {
        // PERBAIKAN: Menambahkan backslash (\) agar // tidak dibaca sebagai komentar
        url = url.replace(/\/(edit|view).*$/, '/export?format=csv');
    }
    if (url.includes('/pubhtml')) {
        url = url.replace('/pubhtml', '/pub?output=csv');
    }
    return url;
};

// Universal Date Parser (Supports DD/MM/YYYY, YYYY-MM-DD, M/D/YY)
const parseAnyDate = (raw) => {
    if (!raw) return '';
    let str = String(raw).trim().replace(/^"|"$/g, '');
    const parts = str.split(/[/-.]/);
    if (parts.length === 3) {
        let p1 = parseInt(parts[0], 10);
        let p2 = parseInt(parts[1], 10);
        let p3 = parseInt(parts[2], 10);

        if (isNaN(p1) || isNaN(p2) || isNaN(p3)) return str;

        let year, month, day;

        if (parts[0].length === 4) { // YYYY-MM-DD
            year = p1; month = p2; day = p3;
        } else { // Third part is year (DD/MM/YYYY)
            year = p3 < 100 ? p3 + 2000 : p3;
            if (p1 > 12) { day = p1; month = p2; }
            else if (p2 > 12) { month = p1; day = p2; }
            else { day = p1; month = p2; }
        }

        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return str;
};

// Parse CSV line taking quotes into account
const parseCSVLine = (line, delimiter) => {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
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

// Robust CSV Parser
const parseCSVToTransactions = (csvText) => {
    if (!csvText || typeof csvText !== 'string') return [];

    const cleanText = csvText.replace(/^\uFEFF/, ''); // Remove UTF-8 BOM
    const lines = cleanText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return [];

    const delimiter = lines[0].includes(';') ? ';' : ',';
    const parsedData = [];

    // Check if line 1 is header
    const line0Cols = parseCSVLine(lines[0], delimiter);
    const isHeaderLine0 = line0Cols.some(col => 
        /tanggal|date|tipe|type|kategori|category|keterangan|deskripsi|nominal|jumlah|amount/i.test(col)
    );

    const startIndex = isHeaderLine0 ? 1 : 0;

    for (let i = startIndex; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i], delimiter);
        if (cols.length < 3) continue;

        // Auto detect column offset if column 0 is index number ("No")
        let colOffset = 0;
        if (/^\d+$/.test(cols[0]) && cols.length >= 6) {
            colOffset = 1;
        }

        const dateRaw = cols[0 + colOffset];
        const typeRaw = (cols[1 + colOffset] || '').toLowerCase();
        const categoryRaw = cols[2 + colOffset] || 'Umum';
        const descRaw = cols[3 + colOffset] || 'Tanpa Keterangan';
        const amountRaw = cols[4 + colOffset] || '0';

        const formattedDate = parseAnyDate(dateRaw);
        const isIncome = ['income', 'pemasukan', 'masuk', 'kredit', 'in'].includes(typeRaw);

        // Clean amount number
        let cleanAmountStr = amountRaw.replace(/Rp|\s/gi, '').replace(/[\.,]00$/, '');
        const cleanAmount = Number(cleanAmountStr.replace(/[^0-9]/g, '')) || 0;

        if (formattedDate && cleanAmount > 0) {
            parsedData.push({
                date: formattedDate,
                type: isIncome ? 'income' : 'expense',
                category: categoryRaw,
                desc: descRaw,
                amount: cleanAmount,
                status: 'Selesai',
                source: 'sheets'
            });
        }
    }

    return parsedData;
};

// --- API ENDPOINTS ---

// 1. GET ALL TRANSACTIONS
app.get('/api/finances', async (req, res) => {
    try {
        const transactions = await Transaction.find().sort({ date: -1 });
        res.json({ success: true, data: transactions });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. SERVER-SIDE GOOGLE SHEETS SYNC ENDPOINT
app.post('/api/finances/sync-sheets', async (req, res) => {
    try {
        const { sheetUrl } = req.body;
        if (!sheetUrl) {
            return res.status(400).json({ success: false, message: 'URL Google Sheets diperlukan.' });
        }

        const csvUrl = normalizeSheetsUrl(sheetUrl);
        console.log(`📡 Fetching CSV directly from server: ${csvUrl}`);

        // Server-side HTTP Fetch using Axios (Bypasses CORS entirely)
        const response = await axios.get(csvUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        });

        const transactions = parseCSVToTransactions(response.data);

        if (transactions.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Tidak ada data valid yang ditemukan dalam CSV. Pastikan format kolom sesuai (Tanggal, Tipe, Kategori, Keterangan, Nominal).' 
            });
        }

        // Option: Replace all synced Google Sheets data in MongoDB
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
        res.status(500).json({
            success: false,
            message: `Gagal mengambil data Google Sheets dari server: ${err.message}`
        });
    }
});

// 3. ADD MANUAL TRANSACTION
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

// 4. CLEAR ALL TRANSACTIONS
app.delete('/api/finances', async (req, res) => {
    try {
        await Transaction.deleteMany({});
        res.json({ success: true, message: 'Semua data transaksi berhasil dihapus.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// PERBAIKAN: Menambahkan `0.0.0.0` (khusus Render) & perbaikan backtick pada console.log
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
});
