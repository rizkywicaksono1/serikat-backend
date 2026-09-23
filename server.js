// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const app = express();
const API_BASE = 'https://serikat-backend.onrender.com/api'; // ganti sesuai domain backend kamu

// server.js
let appSettings = {}; // atau simpan sebagai koleksi Mongoose kalau mau lebih permanen

app.get('/api/settings/sync-url', (req, res) => res.json({ syncUrl: appSettings.syncUrl || '' }));
app.post('/api/settings/sync-url', (req, res) => {
    appSettings.syncUrl = req.body.syncUrl;
    res.json({ ok: true });
});
// Schema User (anggota + admin)
const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },   // ID Anggota
    password: { type: String, required: true },           // sebaiknya di-hash, lihat catatan di bawah
    name: String,
    role: { type: String, default: 'user' },               // 'admin' atau 'user'
    department: String,
    position: String,
    phone: String,
    email: String,
    status: { type: String, default: 'aktif' }
});
const User = mongoose.model('User', userSchema);

// LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { id, password } = req.body;
        const user = await User.findOne({ id, password });
        if (!user) return res.status(401).json({ error: 'ID Anggota atau Password salah' });
        if (user.status !== 'aktif') return res.status(403).json({ error: 'Akun tidak aktif' });

        // Jangan kirim password balik ke frontend
        const { password: _, ...safeUser } = user.toObject();
        res.json(safeUser);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Terjadi kesalahan server' });
    }
});

// AMBIL SEMUA ANGGOTA
app.get('/api/members', async (req, res) => {
    try {
        const members = await User.find({}, '-password'); // exclude password
        res.json(members);
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil data anggota' });
    }
});

// TAMBAH ANGGOTA BARU
app.post('/api/members', async (req, res) => {
    try {
        const exists = await User.findOne({ id: req.body.id });
        if (exists) return res.status(400).json({ error: 'ID Anggota sudah dipakai' });

        const newUser = await User.create(req.body);
        const { password, ...safeUser } = newUser.toObject();
        res.json(safeUser);
    } catch (err) {
        res.status(500).json({ error: 'Gagal menambah anggota' });
    }
});

// TOGGLE STATUS AKTIF/NONAKTIF
app.patch('/api/members/:id/toggle-status', async (req, res) => {
    try {
        const user = await User.findOne({ id: req.params.id });
        if (!user) return res.status(404).json({ error: 'Anggota tidak ditemukan' });

        user.status = user.status === 'aktif' ? 'nonaktif' : 'aktif';
        await user.save();
        const { password, ...safeUser } = user.toObject();
        res.json(safeUser);
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengubah status' });
    }
});

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
