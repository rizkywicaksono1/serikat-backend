// server.js
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware (wajib sebelum rute)
app.use(cors());
app.use(express.json());

// Konfigurasi MySQL Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'serikat_db',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Uji koneksi ke database saat server mulai
(async () => {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Terhubung ke MySQL');
        connection.release();
    } catch (err) {
        console.error('❌ Gagal koneksi ke MySQL:', err.message);
    }
})();

// ==================== 1. SETTINGS ====================

// Ambil Sync URL
app.get('/api/settings/sync-url', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT setting_value FROM app_settings WHERE setting_key = ?',
            ['syncUrl']
        );
        const syncUrl = rows.length > 0 ? rows[0].setting_value : '';
        res.json({ syncUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal mengambil sync URL' });
    }
});

// Simpan Sync URL
app.post('/api/settings/sync-url', async (req, res) => {
    try {
        const syncUrl = req.body.syncUrl || '';
        await pool.query(
            `INSERT INTO app_settings (setting_key, setting_value) 
             VALUES ('syncUrl', ?) 
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
            [syncUrl]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal menyimpan sync URL' });
    }
});

// ==================== 2. USERS & ANGGOTA ====================

// LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { id, password } = req.body;
        const [rows] = await pool.query(
            `SELECT id, name, role, department, position, phone, email, status, password 
             FROM users WHERE id = ? AND password = ?`,
            [id, password]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: 'ID Anggota atau Password salah' });
        }

        const user = rows[0];
        if (user.status !== 'aktif') {
            return res.status(403).json({ error: 'Akun tidak aktif' });
        }

        const { password: _, ...safeUser } = user;
        res.json(safeUser);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Terjadi kesalahan server' });
    }
});

// AMBIL SEMUA ANGGOTA (tanpa password)
app.get('/api/members', async (req, res) => {
    try {
        const [members] = await pool.query(
            `SELECT id, name, role, department, position, phone, email, status, created_at 
             FROM users ORDER BY name ASC`
        );
        res.json(members);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal mengambil data anggota' });
    }
});

// TAMBAH ANGGOTA BARU
app.post('/api/members', async (req, res) => {
    try {
        const { id, password, name, role, department, position, phone, email, status } = req.body;

        // Cek apakah ID sudah ada
        const [existing] = await pool.query('SELECT id FROM users WHERE id = ?', [id]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'ID Anggota sudah dipakai' });
        }

        await pool.query(
            `INSERT INTO users (id, password, name, role, department, position, phone, email, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                password || 'user123',
                name || '',
                role || 'user',
                department || '',
                position || '',
                phone || '',
                email || '',
                status || 'aktif'
            ]
        );

        res.json({
            id,
            name,
            role: role || 'user',
            department,
            position,
            phone,
            email,
            status: status || 'aktif'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal menambah anggota' });
    }
});

// TOGGLE STATUS AKTIF / NONAKTIF
app.patch('/api/members/:id/toggle-status', async (req, res) => {
    try {
        const memberId = req.params.id;

        const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [memberId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Anggota tidak ditemukan' });
        }

        const currentStatus = rows[0].status;
        const newStatus = currentStatus === 'aktif' ? 'nonaktif' : 'aktif';

        await pool.query('UPDATE users SET status = ? WHERE id = ?', [newStatus, memberId]);

        const { password: _, ...safeUser } = rows[0];
        safeUser.status = newStatus;
        res.json(safeUser);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal mengubah status' });
    }
});

// ==================== 3. KEUANGAN ====================

// Ambil semua transaksi keuangan
app.get('/api/finances', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM finances ORDER BY date DESC, id DESC');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// Sinkronisasi data keuangan massal (hapus lama, ganti data baru)
app.post('/api/finances/bulk-replace', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const newData = req.body; // array data keuangan
        await connection.beginTransaction();

        // Kosongkan data lama
        await connection.query('DELETE FROM finances');

        // Masukkan data baru jika ada
        if (Array.isArray(newData) && newData.length > 0) {
            const values = newData.map(item => [
                item.date || '',
                item.type || '',
                item.category || '',
                item.desc || '',
                Number(item.amount) || 0,
                item.status || 'Selesai'
            ]);

            await connection.query(
                'INSERT INTO finances (date, type, category, `desc`, amount, status) VALUES ?',
                [values]
            );
        }

        await connection.commit();
        res.json({ success: true, count: Array.isArray(newData) ? newData.length : 0 });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Gagal sinkronisasi data keuangan' });
    } finally {
        connection.release();
    }
});

// Jalankan Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server Backend berjalan di port http://localhost:${PORT}`);
});
