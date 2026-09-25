import hashlib
import json
import os
import secrets
import sqlite3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).parent
DATABASE = ROOT / 'ledgerly.db'


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
                role TEXT NOT NULL DEFAULT 'user',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    return {'username': row['username'], 'role': row['role']}


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
        if path not in ('/api/register', '/api/login', '/api/update-user'):
            return super().do_POST()
        try:
            payload = self.read_json()
            username = str(payload.get('username', '')).strip().lower()
            password = str(payload.get('password', ''))
            current_username = str(payload.get('current_username', '')).strip().lower()
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
                        return self.send_json(409, {'error': 'That username already exists.'})
                    role = 'admin'
                    salt, digest = password_hash(password)
                    database.execute(
                        'INSERT INTO users (username, password_hash, password_salt, role) VALUES (?, ?, ?, ?)',
                        (username, digest, salt, role),
                    )
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


if __name__ == '__main__':
    initialise_database()
    port = int(os.environ.get('PORT', '55633'))
    server = ThreadingHTTPServer(('0.0.0.0', port), LedgerlyHandler)
    print(f'Ledgerly running on port {port}')
    server.serve_forever()
