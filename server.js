// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors()); // Mengizinkan Frontend mengakses Backend
app.use(express.json()); // Agar bisa menerima format JSON

// URI Database (Gunakan 127.0.0.1 untuk menghindari isu IPv6 Node.js v17+)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/serikat_db';

// Koneksi ke Database MongoDB (Mongoose v6+ tidak memerlukan useNewUrlParser/useUnifiedTopology)
mongoose.connect(MONGO_URI)
.then(() => console.log('✅ Terhubung ke MongoDB'))
.catch(err => {
    console.error('❌ Gagal koneksi DB:', err.message);
});

// --- BIKIN SKEMA DATABASE (TABLE) ---
const FinanceSchema = new mongoose.Schema({
    date: String,
    type: String,
    category: String,
    desc: String,
    amount: Number,
    status: { type: String, default: 'Selesai' }
});
const Finance = mongoose.model('Finance', FinanceSchema);

// --- BIKIN JALUR API (ROUTES) ---

// 1. Mengambil semua data keuangan (GET)
app.get('/api/finances', async (req, res) => {
    try {
        const finances = await Finance.find().sort({ date: -1 }); // urutkan dari terbaru
        res.json(finances);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 2. Menambah data keuangan baru (POST)
app.post('/api/finances/bulk-replace', async (req, res) => {
    try {
        const newData = req.body; // array of transactions dari frontend
        await Finance.deleteMany({});      // hapus semua data lama
        const inserted = await Finance.insertMany(newData); // masukkan data baru dari spreadsheet
        res.json(inserted);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal sinkronisasi data' });
    }
});
// Jalankan Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server Backend berjalan di port http://localhost:${PORT}`);
});
