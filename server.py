import hashlib
import json
import os
import secrets
import smtplib
import sqlite3
from email.message import EmailMessage
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DATABASE = Path(os.environ.get('LEDGERLY_DATABASE', str(ROOT / 'ledgerly.db')))


def connection():
    database = sqlite3.connect(DATABASE)
    database.row_factory = sqlite3.Row
    return database


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 120_000).hex()
    return salt, digest


def initialise_database():
    with connection() as database:
        database.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                first_name TEXT NOT NULL DEFAULT '',
                last_name TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT 'user',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        existing_columns = {row['name'] for row in database.execute('PRAGMA table_info(users)')}
        for column in ('first_name', 'last_name'):
            if column not in existing_columns:
                database.execute(f"ALTER TABLE users ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
        database.execute('''
            CREATE TABLE IF NOT EXISTS registration_codes (
                email TEXT PRIMARY KEY COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                code TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            )
        ''')
        database.execute('''
            CREATE TABLE IF NOT EXISTS user_states (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        database.executescript((ROOT / 'schema.sql').read_text(encoding='utf-8'))
        for role, description in (
            ('super_admin', 'Full system access'),
            ('admin', 'Business administration access'),
            ('accountant', 'Accounting and finance access'),
            ('cashier', 'POS and sales access'),
            ('storekeeper', 'Inventory and stock access'),
        ):
            database.execute('INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)', (role, description))


def public_user(row):
    return {'username': row['username'], 'role': row['role'], 'first_name': row['first_name'], 'last_name': row['last_name']}


def send_verification_email(email, code):
    host = os.environ.get('SMTP_HOST')
    if not host:
        return False
    message = EmailMessage()
    message['Subject'] = 'Verify your Ledgerly account'
    message['From'] = os.environ.get('SMTP_FROM', os.environ.get('SMTP_USER', 'no-reply@ledgerly.local'))
    message['To'] = email
    message.set_content(f'Your Ledgerly verification code is {code}. It expires in 10 minutes.')
    port = int(os.environ.get('SMTP_PORT', '587'))
    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.starttls()
        smtp.login(os.environ['SMTP_USER'], os.environ['SMTP_PASSWORD'])
        smtp.send_message(message)
    return True


class LedgerlyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        return json.loads(self.rfile.read(length) or '{}')

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ('/api/register', '/api/verify-registration', '/api/login', '/api/update-user', '/api/state'):
            return super().do_POST()
        try:
            payload = self.read_json()
            username = str(payload.get('username', '')).strip().lower()
            password = str(payload.get('password', ''))
            current_username = str(payload.get('current_username', '')).strip().lower()
            first_name = str(payload.get('first_name', '')).strip()
            last_name = str(payload.get('last_name', '')).strip()
            if path == '/api/verify-registration':
                code = str(payload.get('code', '')).strip()
                if not username or not code:
                    return self.send_json(400, {'error': 'Email and verification code are required.'})
                with connection() as database:
                    pending = database.execute('SELECT * FROM registration_codes WHERE email = ?', (username,)).fetchone()
                    if not pending or pending['expires_at'] < int(__import__('time').time()) or not secrets.compare_digest(code, pending['code']):
                        return self.send_json(400, {'error': 'That verification code is invalid or expired.'})
                    if database.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
                        return self.send_json(409, {'error': 'That email is already registered.'})
                    database.execute('INSERT INTO users (username, password_hash, password_salt, first_name, last_name, role) VALUES (?, ?, ?, ?, ?, ?)', (username, pending['password_hash'], pending['password_salt'], pending['first_name'], pending['last_name'], 'admin'))
                    database.execute('DELETE FROM registration_codes WHERE email = ?', (username,))
                    user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                return self.send_json(201, {'user': public_user(user)})
            if path == '/api/state':
                state = payload.get('state')
                if not username or not isinstance(state, dict):
                    return self.send_json(400, {'error': 'Username and workspace state are required.'})
                with connection() as database:
                    user = database.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone()
                    if not user:
                        return self.send_json(404, {'error': 'User was not found.'})
                    database.execute(
                        'INSERT INTO user_states (user_id, state_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) '
                        'ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP',
                        (user['id'], json.dumps(state)),
                    )
                return self.send_json(200, {'saved': True})
            if not username:
                return self.send_json(400, {'error': 'Username is required.'})
            if path != '/api/update-user' and not password:
                return self.send_json(400, {'error': 'Username and password are required.'})
            if password and len(password) < 6:
                return self.send_json(400, {'error': 'Password must be at least 6 characters.'})
            with connection() as database:
                if path == '/api/update-user':
                    if not current_username:
                        return self.send_json(400, {'error': 'Current username is required.'})
                    current_user = database.execute('SELECT * FROM users WHERE username = ?', (current_username,)).fetchone()
                    if not current_user:
                        return self.send_json(404, {'error': 'Current user was not found.'})
                    if username != current_username and database.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
                        return self.send_json(409, {'error': 'That username already exists.'})
                    if password:
                        salt, digest = password_hash(password)
                        database.execute('UPDATE users SET username = ?, password_hash = ?, password_salt = ? WHERE id = ?', (username, digest, salt, current_user['id']))
                    else:
                        database.execute('UPDATE users SET username = ? WHERE id = ?', (username, current_user['id']))
                    updated_user = database.execute('SELECT * FROM users WHERE id = ?', (current_user['id'],)).fetchone()
                    return self.send_json(200, {'user': public_user(updated_user)})
                user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                if path == '/api/register':
                    if user:
                        return self.send_json(409, {'error': 'That email is already registered.'})
                    salt, digest = password_hash(password)
                    database.execute('INSERT INTO users (username, password_hash, password_salt, first_name, last_name, role) VALUES (?, ?, ?, ?, ?, ?)', (username, digest, salt, first_name, last_name, 'admin'))
                    user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                    return self.send_json(201, {'user': public_user(user)})
                if not user:
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                _, digest = password_hash(password, user['password_salt'])
                if not secrets.compare_digest(digest, user['password_hash']):
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                return self.send_json(200, {'user': public_user(user)})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {'error': 'Invalid request.'})

    def do_GET(self):
        request = urlparse(self.path)
        if request.path != '/api/state':
            return super().do_GET()
        username = parse_qs(request.query).get('username', [''])[0].strip().lower()
        if not username:
            return self.send_json(400, {'error': 'Username is required.'})
        with connection() as database:
            row = database.execute('''
                SELECT user_states.state_json
                FROM user_states
                JOIN users ON users.id = user_states.user_id
                WHERE users.username = ?
            ''', (username,)).fetchone()
        if not row:
            return self.send_json(200, {'state': None})
        try:
            return self.send_json(200, {'state': json.loads(row['state_json'])})
        except json.JSONDecodeError:
            return self.send_json(500, {'error': 'Stored workspace state is invalid.'})


if __name__ == '__main__':
    initialise_database()
    port = int(os.environ.get('PORT', '55633'))
    server = ThreadingHTTPServer(('0.0.0.0', port), LedgerlyHandler)
    print(f'Ledgerly running on port {port}')
    server.serve_forever()
