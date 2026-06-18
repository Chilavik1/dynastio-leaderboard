const fsSync = require('fs');
const pathSync = require('path');

// =========================================================================
// ЭТАП 0: ИНТЕРАКТИВНАЯ НАСТРОЙКА (ПРИ ПЕРВОМ ЗАПУСКЕ)
// =========================================================================
async function ensureConfiguration() {
    const envPath = pathSync.join(__dirname, '.env');
    
    if (fsSync.existsSync(envPath)) {
        return;
    }

    console.clear();
    console.log('\x1b[36m%s\x1b[0m', '============================================');
    console.log('\x1b[35m%s\x1b[0m', '    ⚙️  ПЕРВОНАЧАЛЬНАЯ НАСТРОЙКА СЕРВЕРА    ');
    console.log('\x1b[36m%s\x1b[0m', '============================================\n');

    const inquirer = require('inquirer');

    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'dbType',
            message: 'Выберите тип хранилища данных:',
            choices: [
                { name: 'SQLite (Локальная база данных)', value: 'sqlite' },
                { name: 'JSON (Сохранение в текстовые файлы)', value: 'json' }
            ]
        },
        {
            type: 'input',
            name: 'customPath',
            message: (hash) => hash.dbType === 'sqlite' 
                ? 'Укажите путь и имя файла базы данных:' 
                : 'Укажите название папки для хранения JSON-файлов:',
            default: (hash) => hash.dbType === 'sqlite' ? './leaderboard.db' : './data_storage'
        },
        {
            type: 'input',
            name: 'port',
            message: 'Укажите порт для работы сервера:',
            default: '3000',
            validate: (value) => {
                const valid = !isNaN(parseFloat(value)) && isFinite(value);
                return valid || 'Пожалуйста, введите корректный номер порта';
            }
        },
        {
            type: 'input',
            name: 'takeEndpoint',
            message: 'Задайте секретный URL-путь для приема рекордов (вместо /take):',
            default: '/take_records_secret',
            validate: (value) => {
                let str = value.trim();
                if (!str.startsWith('/')) {
                    return 'Путь должен начинаться со знака слэша "/" (например: /my_secret_link)';
                }
                if (str.length < 3) {
                    return 'Слишком короткий путь';
                }
                return true;
            }
        },
        {
            type: 'list',
            name: 'nodeEnv',
            message: 'Выберите режим работы приложения:',
            choices: [
                { name: 'Разработка (development)', value: 'development' },
                { name: 'Продакшн (production)', value: 'production' }
            ]
        }
    ]);

    const dbPathValue = answers.dbType === 'sqlite' ? answers.customPath : './leaderboard.db';
    const jsonDirValue = answers.dbType === 'json' ? answers.customPath : './data_storage';

    const envContent = `PORT=${answers.port}
NODE_ENV=${answers.nodeEnv}
DB_TYPE=${answers.dbType}
DB_PATH=${dbPathValue}
JSON_DIR=${jsonDirValue}
TAKE_ENDPOINT=${answers.takeEndpoint.trim()}
`;

    fsSync.writeFileSync(envPath, envContent, 'utf-8');
    console.log('\n\x1b[32m%s\x1b[0m', ' Конфигурация успешно сохранена в файл .env!');
    console.log('\x1b[33m%s\x1b[0m', ' Запуск игрового сервера...\n');
}
ensureConfiguration().then(() => {
require('dotenv').config();
const express = require('express');
const { format } = require('date-fns');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk');
const TAKE_ENDPOINT = process.env.TAKE_ENDPOINT || '/take';
class SqliteStorage {
    constructor() {
        this.dbPath = process.env.DB_PATH || './leaderboard.db';
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async createTableIfNotExists(tableName) {
        return new Promise((resolve, reject) => {
            this.db.run(`CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, value BLOB)`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async getValues(tableName) {
        await this.createTableIfNotExists(tableName);
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT value FROM ${tableName}`, [], (err, rows) => {
                if (err) return reject(err);
                try {
                    const values = rows.map(row => JSON.parse(row.value));
                    resolve(values);
                } catch (e) { reject(e); }
            });
        });
    }

    async updateRecord(tableName, playerData) {
        await this.createTableIfNotExists(tableName);
        return new Promise((resolve, reject) => {
            this.db.get(`SELECT value FROM ${tableName} WHERE id = ?`, [playerData.id], (err, row) => {
                if (err) return reject(err);
                
                let existingData = row ? JSON.parse(row.value) : null;

                if (existingData && existingData.score < playerData.score) {
                    this.db.run(`UPDATE ${tableName} SET value = ? WHERE id = ?`, [JSON.stringify(playerData), playerData.id], (err) => {
                        if (err) reject(err); else resolve({ updated: true });
                    });
                } else if (!existingData) {
                    this.db.run(`INSERT INTO ${tableName}(id, value) VALUES(?, ?)`, [playerData.id, JSON.stringify(playerData)], (err) => {
                        if (err) reject(err); else resolve({ inserted: true });
                    });
                } else {
                    resolve({ skipped: true });
                }
            });
        });
    }
}

class JsonStorage {
    constructor() {
        this.dirPath = path.resolve(process.env.JSON_DIR || './data_storage');
    }

    async init() {
        await fs.mkdir(this.dirPath, { recursive: true });
    }

    async _readFilePath(tableName) {
        const filePath = path.join(this.dirPath, `${tableName}.json`);
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (err) {
            if (err.code === 'ENOENT') return {}; 
            throw err;
        }
    }

    async _writeFilePath(tableName, data) {
        const filePath = path.join(this.dirPath, `${tableName}.json`);
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    async getValues(tableName) {
        const dbData = await this._readFilePath(tableName);
        return Object.values(dbData);
    }

    async updateRecord(tableName, playerData) {
        const dbData = await this._readFilePath(tableName);
        const existingData = dbData[playerData.id];

        if (existingData && existingData.score < playerData.score) {
            dbData[playerData.id] = playerData;
            await this._writeFilePath(tableName, dbData);
            return { updated: true };
        } else if (!existingData) {
            dbData[playerData.id] = playerData;
            await this._writeFilePath(tableName, dbData);
            return { inserted: true };
        }
        return { skipped: true };
    }
}

const app = express();
const PORT = process.env.PORT || 3000;
const DB_TYPE = (process.env.DB_TYPE || 'sqlite').toLowerCase();

let storage;
if (DB_TYPE === 'sqlite') {
    storage = new SqliteStorage();
} else if (DB_TYPE === 'json') {
    storage = new JsonStorage();
} else {
    console.log(chalk.red.bold(`[ОШИБКА] Неизвестный тип БД: ${DB_TYPE}. Откат на sqlite.`));
    storage = new SqliteStorage();
}

console.clear();

let state = {};
app.use(express.json());

app.use((req, res, next) => {
    const timeStr = format(new Date(), 'HH:mm:ss');
    console.log(chalk.gray(`[${timeStr}]`) + chalk.magenta(` ${req.method}`) + ` ${req.url}`);
    next();
});

function getWeekOfYearMonth(date) {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const firstDayOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    const firstDayWeek = firstDayOfMonth.getDay() === 0 ? 7 : firstDayOfMonth.getDay();
    const weekNumber = Math.ceil((date.getDate() + firstDayWeek - 2) / 7).toString().padStart(2, '0');
    return `${year}_${month}_${weekNumber}`;
}

app.post(TAKE_ENDPOINT, async (req, res) => {
    state = req.body;
    const now = new Date();
    const curday = format(now, 'yyyy_MM_dd');
    const curWeek = `week_${getWeekOfYearMonth(now)}`;
    const curMonth = `month_${format(now, 'yyyy_MM')}`;

    const tables = [`day_${curday}`, curWeek, curMonth];

    if (state.players && Array.isArray(state.players)) {
        for (const player of state.players) {
            if (!player.id) continue;

            let playerData = {
                "name": player.name,
                "id": player.id,
                "score": player.score,
                "time": format(new Date(), 'dd:MM:yyyy HH:mm:ss')
            };

            for (const table of tables) {
                try {
                    const result = await storage.updateRecord(table, playerData);
                    if (result.inserted) {
                        console.log(chalk.green(`[НОВЫЙ] ${player.name} добавлен в ${table} (${player.score})`));
                    } else if (result.updated) {
                        console.log(chalk.yellow(`[РЕКОРД] ${player.name} обновил счет в ${table} до ${player.score}`));
                    }
                } catch (err) {
                    console.log(chalk.red(`[ОШИБКА ЗАПИСИ в ${table}]:`), err.message);
                }
            }
        }
    }

    res.json({ message: 'Данные сохранены', storage: DB_TYPE });
});

app.get('/leaderboard/:period', async (req, res) => {
    let { period } = req.params;
    let tableName;
    const now = new Date();

    if (period === 'day') {
        tableName = `day_${format(now, 'yyyy_MM_dd')}`;
    } else if (period === 'week') {
        tableName = `week_${getWeekOfYearMonth(now)}`;
    } else if (period === 'month') {
        tableName = `month_${format(now, 'yyyy_MM')}`;
    } else {
        let cleanDateStr = period;
        if (period.startsWith('day=')) {
            cleanDateStr = period.replace('day=', '');
        }

        let parsedDate = null;
        const formatsToTry = ['dd-MM-yyyy', 'dd_MM_yyyy', 'dd.MM.yyyy'];

        for (const fmt of formatsToTry) {
            try {
                const result = parse(cleanDateStr, fmt, new Date());
                if (!isNaN(result.getTime())) {
                    parsedDate = result;
                    break;
                }
            } catch (e) {}
        }

        if (parsedDate) {
            tableName = `day_${format(parsedDate, 'yyyy_MM_dd')}`;
        } else {
            return res.status(400).json({ 
                error: 'Недопустимый период. Используйте "day", "week", "month" или конкретную дату (например, day=18-06-2026, 18_06_2026, 18.06.2026).' 
            });
        }
    }

    try {
        const values = await storage.getValues(tableName);
        values.sort((a, b) => b.score - a.score);
        res.json({ period: tableName, data: values });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка при чтении данных из хранилища' });
    }
});

app.get('/leaderboard/:period', async (req, res) => {
    const { period } = req.params;
    let tableName;
    const now = new Date();

    if (period === 'day') tableName = `day_${format(now, 'yyyy_MM_dd')}`;
    else if (period === 'week') tableName = `week_${getWeekOfYearMonth(now)}`;
    else if (period === 'month') tableName = `month_${format(now, 'yyyy_MM')}`;
    else return res.status(400).json({ error: 'Недопустимый период. Используйте "day", "week" или "month".' });

    try {
        const values = await storage.getValues(tableName);
        values.sort((a, b) => b.score - a.score);
        res.json({ data: values });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка при чтении данных' });
    }
});

app.get('/state', (req, res) => {
    res.json(state);
});

storage.init()
    .then(() => {
        console.log(chalk.green(`[СТРАТЕГИЯ ХРАНЕНИЯ] Успешно запущено через: ${DB_TYPE.toUpperCase()}`));
        
        app.listen(PORT, "0.0.0.0", () => {
            console.log(chalk.blue.bold('============================================'));
            console.log(chalk.green.bold(` СТАТУС СЕРВЕРА: ONLINE`));
            console.log(chalk.white(` Локальный адрес: http://localhost:${PORT}`));
            console.log(chalk.white(` Режим (NODE_ENV): ${process.env.NODE_ENV || 'development'}`));
            console.log(chalk.blue.bold('============================================'));
            console.log(chalk.gray(' Лог сетевой активности запросов:'));
        });
    })
    .catch(err => {
        console.log(chalk.red.bold(`[КРИТИЧЕСКАЯ ОШИБКА ИНИЦИАЛИЗАЦИИ БД]: ${err.message}`));
        process.exit(1);
    });
});
