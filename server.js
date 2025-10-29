require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser')
const session = require('express-session')
const crypto = require('crypto')
const path = require('path')
const pool = require('./database')

const app = express()

app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}))

// Load users from .env
const USERS = Object.entries(process.env)
  .filter(([k,_]) => !['DB_URL','SESSION_SECRET'].includes(k))
  .map(([username,password],i) => ({ id: i+1, username: username.toLowerCase(), password }))

function splitIntervals(input){
    if(!input) return []
    let raw = input.split(/\r?\n|;/).map(s=>s.trim()).filter(s=>s.length>0)
    let intervals = []
    for(const r of raw){
        const parts = r.split(/\s(?=\d{1,2}([:.]\d{1,2})?\s*(bis|-|–)\s*\d{1,2}([:.]\d{1,2})?)/)
        if(!parts || parts.length === 0) continue
        for(const p of parts){
            if(p && p.length > 0) intervals.push(p)
        }
    }
    return intervals
}

function parseInterval(line){
    line = line.replace(/\./g, ':').trim()
    line = line.replace(/\s*[-–]\s*/g,' bis ')
    const parts = line.split(/bis/i).map(t => t.trim())
    if(parts.length !== 2) throw new Error(`Ungültiges Format: ${line}`)
    let [start,end] = parts
    if(!start.includes(':')) start += ':00'
    if(!end.includes(':')) end += ':00'
    const startMatch = start.match(/^(\d{1,2}):(\d{2})$/)
    const endMatch = end.match(/^(\d{1,2}):(\d{2})$/)
    if(!startMatch || !endMatch) throw new Error(`Ungültige Uhrzeit: ${line}`)
    const sh = parseInt(startMatch[1]), sm = parseInt(startMatch[2])
    const eh = parseInt(endMatch[1]), em = parseInt(endMatch[2])
    const duration = (eh*60 + em - (sh*60 + sm))/60
    if(duration <= 0) throw new Error(`Endzeit vor Startzeit: ${line}`)
    return {
        start: `${sh.toString().padStart(2,'0')}:${sm.toString().padStart(2,'0')}`,
        end:   `${eh.toString().padStart(2,'0')}:${em.toString().padStart(2,'0')}`,
        duration
    }
}

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')))

app.post('/login', (req,res) => {
    const { username, password } = req.body
    const user = USERS.find(u => u.username === username.toLowerCase() && u.password === password)
    if(user){
        req.session.user = user
        res.redirect('/dashboard')
    } else {
        res.send('<h1>Falscher Benutzername oder Passwort</h1><a href="/">Zurück</a>')
    }
})

app.get('/dashboard', (req,res) => {
    if(!req.session.user) return res.redirect('/')
    res.sendFile(path.join(__dirname,'public','dashboard.html'))
})

app.get('/logout', (req,res) => {
    req.session.destroy(() => res.redirect('/'))
})

app.get('/add', (req,res) => {
    if(!req.session.user) return res.redirect('/')
    res.sendFile(path.join(__dirname,'public','add_time.html'))
})

app.post('/add', async (req,res) => {
    if(!req.session.user) return res.redirect('/')
    const { date, house_number, intervals, extras, overtime, travel_time } = req.body
    const lines = splitIntervals(intervals)
    let totalHours = 0

    function convertToDecimal(hm){
        if(!hm) return 0
        const parts = hm.split(':').map(Number)
        return parts[0] + (parts[1]||0)/60
    }

    try {
        const conn = await pool.getConnection()
        try {
            const [jobRes] = await conn.execute(
                'INSERT INTO jobs (username, date, house_number, extras, overtime, travel_time) VALUES (?,?,?,?,?,?)',
                [req.session.user.username, date, house_number, extras, convertToDecimal(overtime), convertToDecimal(travel_time)]
            )
            const jobId = jobRes.insertId

            for(const line of lines){
                const interval = parseInterval(line)
                totalHours += interval.duration
                await conn.execute(
                    'INSERT INTO job_times (job_id, start_time, end_time, duration) VALUES (?,?,?,?)',
                    [jobId, interval.start, interval.end, interval.duration]
                )
            }

            res.send(`<h1>Zeiten gespeichert ✅</h1>
                      <p>Gesamtstunden: ${totalHours.toFixed(2)}</p>
                      <a href="/dashboard">Zurück zum Dashboard</a>`)
        } finally {
            conn.release()
        }
    } catch(err){
        res.send(`<h1>Fehler beim Speichern</h1><pre>${err.message}</pre>
                  <a href="/add">Zurück</a>`)
    }
})

app.get('/all', async (req, res) => {
    if (!req.session.user) return res.redirect('/')

    try {
        const conn = await pool.getConnection()
        const [jobs] = await conn.execute('SELECT * FROM jobs WHERE username=? ORDER BY date', [req.session.user.username])

        function formatHM(totalMinutes){
            if(!totalMinutes || totalMinutes === 0) return null
            const h = Math.floor(totalMinutes/60)
            const m = totalMinutes % 60
            let str = ''
            if(h > 0) str += `${h} Std. `
            if(m > 0) str += `${m} Min.`
            return str.trim()
        }

        const jobsByMonth = {}
        for (const job of jobs) {
            const d = new Date(job.date)
            const monthKey = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}`
            if (!jobsByMonth[monthKey]) jobsByMonth[monthKey] = []
            jobsByMonth[monthKey].push(job)
        }

        let htmlContent = ''
        for (const monthKey of Object.keys(jobsByMonth)) {
            const monthJobs = jobsByMonth[monthKey]
            let monthTotalMinutes = 0
            htmlContent += `<h2>${new Date(monthJobs[0].date).toLocaleDateString('de-DE',{ month:'long', year:'numeric' })}</h2><ul>`

            for (const job of monthJobs) {
                const jobDate = new Date(job.date).toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'2-digit', year:'numeric' })
                const [times] = await conn.execute('SELECT * FROM job_times WHERE job_id=?', [job.id])

                let jobTotalMinutes = 0
                let timesHtml = ''
                for (const t of times) {
                    const durationMinutes = Math.round(parseFloat(t.duration)*60)
                    jobTotalMinutes += durationMinutes
                    timesHtml += `<li>${t.start_time} bis ${t.end_time} - ${formatHM(durationMinutes)}</li>`
                }

                monthTotalMinutes += jobTotalMinutes

                const overtimeHM = formatHM(Math.round(job.overtime*60))
                const travelHM = formatHM(Math.round(job.travel_time*60))
                const extrasText = job.extras?.trim() ? job.extras : null

                htmlContent += `<li>
                  <strong>${jobDate} - Haus ${job.house_number}</strong>
                  <ul class="sublist">${timesHtml}</ul>
                  ${extrasText ? `<div class="info-box">INFORMATIONEN: ${extrasText}</div>` : ''}
                  <div class="total-box">Gesamtstunden: ${formatHM(jobTotalMinutes)}</div>
                  ${overtimeHM ? `<div class="info-box">Überstunden: ${overtimeHM}</div>` : ''}
                  ${travelHM ? `<div class="info-box">Anfahrtszeit: ${travelHM}</div>` : ''}
                </li>`
            }

            htmlContent += `<li class="month-total">Monatssumme: ${formatHM(monthTotalMinutes)}</li></ul>`
        }

        const html = `
        <!DOCTYPE html>
        <html lang="de">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Alle Zeiten</title>
          <style>
            body { font-family: Arial, sans-serif; padding:20px; max-width:600px; margin:0 auto; background-color:#1b202c; color:#bac7e4; }
            h1, h2 { text-align:center; color:#d1dfff; }
            ul { list-style:none; padding:0; margin:0; }
            li { background-color:#13161f; margin:10px 0; padding:10px; border:1px solid #82aaff; border-radius:5px; }
            .sublist { margin-left:20px; }
            .info-box { border:1px solid #ff4579; padding:5px 10px; margin-top:5px; border-radius:5px; color:#ffb6c1; background-color:#13161f; }
            .total-box { border:1px solid #37c886; padding:5px 10px; margin-top:5px; border-radius:5px; color:#37c886cc; background-color:#13161f; }
            .month-total { border:2px solid #37c886; padding:5px 10px; margin-top:10px; border-radius:5px; color:#37c886; background-color:#13161f; font-weight:bold; text-align:center; }
            a { color:#37c886cc; text-decoration:none; display:inline-block; margin-top:10px; }
            a:hover { color:#37c886; }
          </style>
        </head>
        <body>
          <h1>Alle Zeiten</h1>
          ${htmlContent || '<p>Keine Einträge vorhanden</p>'}
          <a href="/dashboard">Zurück zum Dashboard</a>
        </body>
        </html>
        `

        res.send(html)
        conn.release()
    } catch(err) {
        res.send(`<h1>Fehler beim Laden</h1><pre>${err.message}</pre>`)
    }
})

const PORT = process.env.PORT || 40100
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))