require('dotenv').config()
const mysql = require('mysql2/promise')

const pool = mysql.createPool({
  uri: process.env.DB_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
})

async function initDB() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) DEFAULT 'anisa',
        date DATE,
        house_number VARCHAR(10),
        extras TEXT,
        overtime DECIMAL(4,2) DEFAULT 0,
        travel_time DECIMAL(4,2) DEFAULT 0
      )
    `)

    await conn.query(`
      CREATE TABLE IF NOT EXISTS job_times (
        id INT AUTO_INCREMENT PRIMARY KEY,
        job_id INT,
        start_time TIME,
        end_time TIME,
        duration DECIMAL(4,2)
      )
    `)

    console.log('Database initialized successfully')
  } finally {
    conn.release()
  }
}

initDB().catch(console.error)

module.exports = pool